import { genAI } from './botManager.js';
import * as db from './database.js';

// ✅ CORRECT: Latest model (GA since July 2025)
const EMBEDDING_MODEL = 'gemini-embedding-001';

const MAX_CONTEXT_TOKENS = 30000;
const TOKENS_PER_MESSAGE = 150;
const MAX_FULL_MESSAGES = 30;
const COMPRESSION_THRESHOLD = 60;
const INDEX_BATCH_SIZE = 20;

class MemorySystem {
  constructor() {
    this.embeddingCache = new Map();
    this.indexingQueue = new Map();
    this.lastIndexedCount = new Map();
  }

  /**
   * ✅ FIXED: Validation to prevent "requests must not be empty" error
   * ✅ FIXED: Correct API call format for @google/genai SDK
   */
  async generateEmbedding(text, taskType = 'RETRIEVAL_DOCUMENT') {
    // 1. Critical Validation
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      // console.warn('⚠️ Skipped embedding generation: Text is empty.');
      return null;
    }

    const cacheKey = text.slice(0, 100) + taskType;
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey);
    }

    try {
      const result = await genAI.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text, 
        config: {
          taskType: taskType,
        }
      });
      
      const embedding = result.embeddings?.[0]?.values;
      
      if (!embedding || !Array.isArray(embedding)) {
        return null;
      }

      this.embeddingCache.set(cacheKey, embedding);
      
      // Cache management
      if (this.embeddingCache.size > 1000) {
        const firstKey = this.embeddingCache.keys().next().value;
        this.embeddingCache.delete(firstKey);
      }
      
      return embedding;
    } catch (error) {
      console.error('Embedding generation failed:', error.message);
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
    if (!message || !message.content) {
      return '';
    }
    
    let text = '';
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && part.text) {
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
          systemInstruction: "Summarize the following conversation history concisely while preserving key information, context, and important details. Keep the summary factual and comprehensive.",
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
        message: `Summarize this conversation:\n\n${conversationText}`
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
      console.error('Compression failed:', error.message);
      // Fallback: return the last few messages if compression fails
      return messages.slice(-3);
    }
  }

  async getRelevantContext(historyId, currentQuery, allHistory, maxRelevant = 5) {
    try {
      // Validation to prevent empty query embedding error
      if (!currentQuery || currentQuery.trim().length === 0) return [];

      const queryEmbedding = await this.generateEmbedding(currentQuery, 'RETRIEVAL_QUERY');
      if (!queryEmbedding) {
        return [];
      }

      const memoryEntries = await db.getMemoryEntries(historyId);
      if (!memoryEntries || memoryEntries.length === 0) {
        return [];
      }

      const scoredEntries = memoryEntries
        .filter(entry => entry.embedding && Array.isArray(entry.embedding))
        .map(entry => ({
          ...entry,
          similarity: this.cosineSimilarity(queryEmbedding, entry.embedding)
        }));

      scoredEntries.sort((a, b) => b.similarity - a.similarity);

      const relevant = scoredEntries
        .filter(entry => entry.similarity > 0.7)
        .slice(0, maxRelevant);

      return relevant.map(entry => entry.messages).flat();
    } catch (error) {
      console.error('Context retrieval failed:', error.message);
      return [];
    }
  }

  async storeMemoryWithEmbedding(historyId, messages) {
    try {
      const conversationText = messages
        .map(msg => this.extractTextFromMessage(msg))
        .filter(text => text.length > 0)
        .join(' ');

      if (conversationText.length < 10) {
        return;
      }

      const embedding = await this.generateEmbedding(conversationText, 'RETRIEVAL_DOCUMENT');
      if (!embedding) {
        return;
      }

      await db.saveMemoryEntry(historyId, {
        messages,
        embedding,
        timestamp: Date.now(),
        text: conversationText.slice(0, 500)
      });
      
    } catch (error) {
      console.error('Memory storage failed:', error.message);
    }
  }

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

      if (messagesSinceLastIndex >= INDEX_BATCH_SIZE) {
        const oldMessages = historyArray.slice(0, -MAX_FULL_MESSAGES);
        
        if (oldMessages.length > 0) {
          const batches = [];
          for (let i = lastIndexed; i < oldMessages.length; i += INDEX_BATCH_SIZE) {
            batches.push(oldMessages.slice(i, i + INDEX_BATCH_SIZE));
          }

          for (const batch of batches) {
            this.storeMemoryWithEmbedding(historyId, batch).catch(err => {
              console.error('Background indexing error:', err.message);
            });
          }
          
          this.lastIndexedCount.set(historyId, oldMessages.length);
        }
      }
    } catch (error) {
      console.error('Auto-indexing check failed:', error.message);
    }
  }

  async getOptimizedHistory(historyId, currentQuery, model) {
    try {
      const allHistory = await db.getChatHistory(historyId);
      if (!allHistory) {
        return [];
      }

      const historyArray = [];
      for (const messagesId in allHistory) {
        if (allHistory.hasOwnProperty(messagesId)) {
          historyArray.push(...allHistory[messagesId]);
        }
      }

      if (historyArray.length === 0) return [];

      // Trigger instant indexing check (non-blocking)
      this.checkAndIndexMessages(historyId, allHistory).catch(() => {});

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

      uniqueMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      return this.formatHistoryWithContext(uniqueMessages);
      
    } catch (error) {
      console.error('History optimization failed:', error.message);
      return [];
    }
  }

  formatHistoryWithContext(historyArray) {
    let previousTimestamp = null;
    const timeThresholdMs = 30 * 60 * 1000;

    return historyArray.map(entry => {
      const apiEntry = {
        role: entry.role === 'assistant' ? 'model' : entry.role,
        parts: []
      };

      // 1. Add Time Context if needed
      if (previousTimestamp && entry.timestamp) {
        const timeDiffMs = entry.timestamp - previousTimestamp;
        if (timeDiffMs > timeThresholdMs) {
          const durationString = this.formatDuration(timeDiffMs);
          apiEntry.parts.push({ 
            text: `[TIME ELAPSED: ${durationString} since the previous turn]\n` 
          });
        }
      }
      previousTimestamp = entry.timestamp;

      // 2. Process Content Parts
      let userInfoAdded = false;

      for (const part of entry.content) {
        // Handle Text
        if (part.text !== undefined && part.text !== '') {
          let finalText = part.text;
          
          // Add User Info to the FIRST text part only
          if (!userInfoAdded && entry.role === 'user' && entry.username && entry.displayName) {
            finalText = `[${entry.displayName} (@${entry.username})]: ${finalText}`;
            userInfoAdded = true;
          }
          
          apiEntry.parts.push({ text: finalText });
        } 
        // Handle Files (URIs) - STRIP for memory to prevent 403 Forbidden
        // When using RAG or compressed memory, we cannot pass old URIs because they might be
        // owned by a different API key (rotation) or have expired.
        else if (part.fileUri) {
           const mime = part.mimeType || 'unknown';
           apiEntry.parts.push({ text: `[Attachment: Previous file (${mime}) - Content no longer available to vision model]` });
        }
        else if (part.inlineData) {
           apiEntry.parts.push({ text: `[Attachment: Previous inline image]` });
        }
      }

      return apiEntry;
    }).filter(entry => entry.parts.length > 0);
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
      console.error('Force indexing failed:', error.message);
      return { success: false, message: error.message };
    }
  }
}

export const memorySystem = new MemorySystem();
