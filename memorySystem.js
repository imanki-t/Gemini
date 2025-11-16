import { genAI } from './botManager.js';
import * as db from './database.js';

const EMBEDDING_MODEL = 'text-embedding-004';
const MAX_CONTEXT_TOKENS = 30000;
const TOKENS_PER_MESSAGE = 150;
const MAX_FULL_MESSAGES = 30;
const COMPRESSION_THRESHOLD = 60;
const INDEX_BATCH_SIZE = 20; // 🔥 Index every 20 messages
const QUEUE_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const QUEUE_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

class MemorySystem {
  constructor() {
    this.embeddingCache = new Map();
    this.indexingQueue = new Map(); // Track messages waiting to be indexed
    this.lastIndexedCount = new Map(); // Track last indexed message count per history
    
    // Start cleanup interval
    this.startQueueCleanup();
  }

  startQueueCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      
      // Clean up old indexing queue entries
      for (const [historyId, data] of this.indexingQueue.entries()) {
        if (now - data.timestamp > QUEUE_EXPIRY) {
          this.indexingQueue.delete(historyId);
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        console.log(`✅ Cleaned ${cleaned} expired indexing queue entries`);
      }
    }, QUEUE_CLEANUP_INTERVAL);
  }

  async generateEmbedding(text) {
    const cacheKey = text.slice(0, 100);
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey);
    }

    try {
      const result = await genAI.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
      });
      
      const embedding = result.embeddings?.[0]?.values;
      
      if (!embedding) {
        console.error('No embedding returned from API');
        return null;
      }

      this.embeddingCache.set(cacheKey, embedding);
      
      if (this.embeddingCache.size > 1000) {
        const firstKey = this.embeddingCache.keys().next().value;
        this.embeddingCache.delete(firstKey);
      }
      
      return embedding;
    } catch (error) {
      console.error('Embedding generation failed:', error);
      return null;
    }
  }

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  extractTextFromMessage(message) {
    let text = '';
    if (message.content && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.text) {
          text += part.text + ' ';
        }
      }
    }
    return text.trim();
  }

  formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    return `${seconds} second${seconds > 1 ? 's' : ''}`;
  }

  async compressOldMessages(messages, model) {
    if (messages.length <= 5) return messages;

    try {
      const chat = genAI.chats.create({
        model: model,
        config: {
          systemInstruction: {
            role: "system",
            parts: [{
              text: "Summarize the following conversation history concisely while preserving key information, context, and important details. Keep the summary factual and comprehensive."
            }]
          },
          temperature: 0.3,
          topP: 0.95
        }
      });

      const conversationText = messages.map((msg, idx) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const text = this.extractTextFromMessage(msg);
        return `${role}: ${text}`;
      }).join('\n\n');

      const result = await chat.sendMessage({
        message: [{
          text: `Summarize this conversation:\n\n${conversationText}`
        }]
      });

      const summary = result.text || conversationText.slice(0, 500);

      return [{
        role: 'user',
        content: [{
          text: `[Previous conversation summary: ${summary}]`
        }],
        timestamp: Date.now()
      }];
    } catch (error) {
      console.error('Compression failed:', error);
      return messages.slice(-3);
    }
  }

  async getRelevantContext(historyId, currentQuery, allHistory, maxRelevant = 5) {
    try {
      const queryEmbedding = await this.generateEmbedding(currentQuery);
      if (!queryEmbedding) return [];

      const memoryEntries = await db.getMemoryEntries(historyId);
      if (!memoryEntries || memoryEntries.length === 0) return [];

      const scoredEntries = memoryEntries.map(entry => ({
        ...entry,
        similarity: this.cosineSimilarity(queryEmbedding, entry.embedding)
      }));

      scoredEntries.sort((a, b) => b.similarity - a.similarity);

      const relevant = scoredEntries
        .filter(entry => entry.similarity > 0.7)
        .slice(0, maxRelevant);

      return relevant.map(entry => entry.messages).flat();
    } catch (error) {
      console.error('Context retrieval failed:', error);
      return [];
    }
  }

  async storeMemoryWithEmbedding(historyId, messages) {
    try {
      const conversationText = messages.map(msg => 
        this.extractTextFromMessage(msg)
      ).join(' ');

      if (conversationText.length < 10) return;

      const embedding = await this.generateEmbedding(conversationText);
      if (!embedding) return;

      await db.saveMemoryEntry(historyId, {
        messages,
        embedding,
        timestamp: Date.now(),
        text: conversationText.slice(0, 500)
      });
      
      console.log(`✅ Indexed ${messages.length} messages for ${historyId}`);
    } catch (error) {
      console.error('Memory storage failed:', error);
    }
  }

  // 🔥 NEW: Check and trigger instant indexing every 20 messages
  async checkAndIndexMessages(historyId, allHistory) {
    try {
      const historyArray = [];
      for (const messagesId in allHistory) {
        if (allHistory.hasOwnProperty(messagesId)) {
          historyArray.push(...allHistory[messagesId]);
        }
      }

      const currentCount = historyArray.length;
      const lastIndexed = this.lastIndexedCount.get(historyId) || 0;
      const messagesSinceLastIndex = currentCount - lastIndexed;

      // If we have 20+ new messages, index them immediately
      if (messagesSinceLastIndex >= INDEX_BATCH_SIZE) {
        console.log(`🔄 Auto-indexing ${messagesSinceLastIndex} new messages for ${historyId}`);
        
        // Get the unindexed messages (everything after MAX_FULL_MESSAGES, excluding recent)
        const oldMessages = historyArray.slice(0, -MAX_FULL_MESSAGES);
        
        if (oldMessages.length > 0) {
          // Index in batches of 20
          const batches = [];
          for (let i = lastIndexed; i < oldMessages.length; i += INDEX_BATCH_SIZE) {
            batches.push(oldMessages.slice(i, i + INDEX_BATCH_SIZE));
          }

          // Index all batches (don't await - run in background)
          for (const batch of batches) {
            this.storeMemoryWithEmbedding(historyId, batch).catch(console.error);
          }
          
          // Update the last indexed count
          this.lastIndexedCount.set(historyId, oldMessages.length);
        }
      }
    } catch (error) {
      console.error('Auto-indexing check failed:', error);
    }
  }

  async getOptimizedHistory(historyId, currentQuery, model) {
    try {
      const allHistory = await db.getChatHistory(historyId);
      if (!allHistory) return [];

      const historyArray = [];
      for (const messagesId in allHistory) {
        if (allHistory.hasOwnProperty(messagesId)) {
          historyArray.push(...allHistory[messagesId]);
        }
      }

      if (historyArray.length === 0) return [];

      // 🔥 NEW: Trigger instant indexing check (non-blocking)
      this.checkAndIndexMessages(historyId, allHistory).catch(console.error);

      // If history is short enough, return it with time context and attribution
      if (historyArray.length <= MAX_FULL_MESSAGES) {
        return this.formatHistoryWithContext(historyArray);
      }

      // For longer histories, use RAG with compression
      const recentMessages = historyArray.slice(-MAX_FULL_MESSAGES);
      const oldMessages = historyArray.slice(0, -MAX_FULL_MESSAGES);

      const relevantContext = await this.getRelevantContext(
        historyId,
        currentQuery,
        allHistory,
        3
      );

      const compressedOld = oldMessages.length > COMPRESSION_THRESHOLD
        ? await this.compressOldMessages(oldMessages, model)
        : oldMessages.slice(-10);

      const combined = [
        ...compressedOld,
        ...relevantContext,
        ...recentMessages
      ];

      // Remove duplicates while preserving order
      const uniqueMessages = Array.from(
        new Map(combined.map(msg => [
          this.extractTextFromMessage(msg) + (msg.timestamp || ''),
          msg
        ])).values()
      );

      // Sort by timestamp and format
      uniqueMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      return this.formatHistoryWithContext(uniqueMessages);
      
    } catch (error) {
      console.error('History optimization failed:', error);
      return [];
    }
  }

  formatHistoryWithContext(historyArray) {
    let previousTimestamp = null;
    const timeThresholdMs = 30 * 60 * 1000; // 30 minutes

    return historyArray.map(entry => {
      const apiEntry = {
        role: entry.role === 'assistant' ? 'model' : entry.role,
        parts: []
      };

      let textContent = entry.content
        .filter(part => part.text !== undefined)
        .map(part => part.text)
        .join('\n');

      // Add time elapsed context if gap > 30 minutes
      let timePassed = "";
      if (previousTimestamp && entry.timestamp) {
        const timeDiffMs = entry.timestamp - previousTimestamp;
        if (timeDiffMs > timeThresholdMs) {
          const durationString = this.formatDuration(timeDiffMs);
          timePassed = `[TIME ELAPSED: ${durationString} since the previous turn]\n`;
        }
      }
      previousTimestamp = entry.timestamp;

      // Add user attribution if this is a user message with user info
      if (entry.role === 'user' && entry.username && entry.displayName) {
        textContent = timePassed + `[${entry.displayName} (@${entry.username})]: ${textContent}`;
      } else {
        textContent = timePassed + textContent;
      }

      if (textContent.trim()) {
        apiEntry.parts.push({ text: textContent });
      }

      return apiEntry;
    }).filter(entry => entry.parts.length > 0);
  }

  async cleanupOldMemories(daysOld = 30) {
    try {
      const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
      const deleted = await db.deleteOldMemoryEntries(cutoffTime);
      console.log(`✅ Cleaned up ${deleted} memories older than ${daysOld} days`);
      return deleted;
    } catch (error) {
      console.error('Memory cleanup failed:', error);
      return 0;
    }
  }

  getQueueStatus() {
    return {
      indexingQueueSize: this.indexingQueue.size,
      cacheSize: this.embeddingCache.size,
      trackedHistories: this.lastIndexedCount.size,
      entries: Array.from(this.lastIndexedCount.entries()).map(([id, count]) => ({
        historyId: id,
        lastIndexedMessageCount: count
      }))
    };
  }

  // 🔥 NEW: Force immediate indexing for a specific history
  async forceIndexNow(historyId) {
    try {
      const allHistory = await db.getChatHistory(historyId);
      if (!allHistory) return { success: false, message: 'No history found' };

      const historyArray = [];
      for (const messagesId in allHistory) {
        if (allHistory.hasOwnProperty(messagesId)) {
          historyArray.push(...allHistory[messagesId]);
        }
      }

      const oldMessages = historyArray.slice(0, -MAX_FULL_MESSAGES);
      
      if (oldMessages.length === 0) {
        return { success: false, message: 'No old messages to index' };
      }

      // Index in batches
      const batches = [];
      for (let i = 0; i < oldMessages.length; i += INDEX_BATCH_SIZE) {
        batches.push(oldMessages.slice(i, i + INDEX_BATCH_SIZE));
      }

      console.log(`🔥 Force-indexing ${oldMessages.length} messages in ${batches.length} batches`);

      for (const batch of batches) {
        await this.storeMemoryWithEmbedding(historyId, batch);
      }

      this.lastIndexedCount.set(historyId, oldMessages.length);

      return { 
        success: true, 
        message: `Indexed ${oldMessages.length} messages in ${batches.length} batches`,
        batchCount: batches.length,
        messageCount: oldMessages.length
      };
    } catch (error) {
      console.error('Force indexing failed:', error);
      return { success: false, message: error.message };
    }
  }
}

export const memorySystem = new MemorySystem();
