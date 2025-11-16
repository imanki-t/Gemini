import { genAI } from './botManager.js';
import * as db from './database.js';

const EMBEDDING_MODEL = 'text-embedding-004';
const MAX_CONTEXT_TOKENS = 30000;
const TOKENS_PER_MESSAGE = 150;
const MAX_FULL_MESSAGES = 30;
const COMPRESSION_THRESHOLD = 60;
const REINDEX_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const QUEUE_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const QUEUE_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

class MemorySystem {
  constructor() {
    this.embeddingCache = new Map();
    this.compressionQueue = new Map();
    
    // Start cleanup interval
    this.startQueueCleanup();
  }

  startQueueCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      
      for (const [historyId, timestamp] of this.compressionQueue.entries()) {
        if (now - timestamp > QUEUE_EXPIRY) {
          this.compressionQueue.delete(historyId);
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        console.log(`✅ Cleaned ${cleaned} expired compression queue entries`);
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
      
      console.log(`✅ Stored ${messages.length} messages with embeddings for ${historyId}`);
    } catch (error) {
      console.error('Memory storage failed:', error);
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

      // If history is short enough, return it with time context and attribution
      if (historyArray.length <= MAX_FULL_MESSAGES) {
        return this.formatHistoryWithContext(historyArray);
      }

      // For longer histories, use RAG with compression
      const recentMessages = historyArray.slice(-MAX_FULL_MESSAGES);
      const oldMessages = historyArray.slice(0, -MAX_FULL_MESSAGES);

      // 🔧 FIX: Time-based re-indexing for compression queue
      if (oldMessages.length > 0) {
        const lastCompression = this.compressionQueue.get(historyId) || 0;
        const timeSinceLastCompression = Date.now() - lastCompression;
        
        // Re-index every 24 hours to catch new old messages
        if (timeSinceLastCompression > REINDEX_INTERVAL) {
          console.log(`🔄 Re-indexing old messages for ${historyId} (${oldMessages.length} messages)`);
          this.compressionQueue.set(historyId, Date.now());
          this.storeMemoryWithEmbedding(historyId, oldMessages).catch(console.error);
        }
      }

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
      size: this.compressionQueue.size,
      cacheSize: this.embeddingCache.size,
      entries: Array.from(this.compressionQueue.entries()).map(([id, timestamp]) => ({
        historyId: id,
        lastCompression: new Date(timestamp).toISOString(),
        age: Date.now() - timestamp
      }))
    };
  }
}

export const memorySystem = new MemorySystem();
