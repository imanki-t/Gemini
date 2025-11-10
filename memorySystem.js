import { genAI } from './botManager.js';
import * as db from './database.js';

const EMBEDDING_MODEL = 'text-embedding-004';
const MAX_CONTEXT_TOKENS = 30000;
const TOKENS_PER_MESSAGE = 150;
const MAX_FULL_MESSAGES = Math.floor(MAX_CONTEXT_TOKENS / TOKENS_PER_MESSAGE * 0.6);
const COMPRESSION_THRESHOLD = MAX_FULL_MESSAGES * 2;

class MemorySystem {
  constructor() {
    this.embeddingCache = new Map();
    this.compressionQueue = new Map();
  }

  async generateEmbedding(text) {
    const cacheKey = text.slice(0, 100);
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey);
    }

    try {
      const result = await genAI.models.embed({
        model: EMBEDDING_MODEL,
        content: text
      });
      
      const embedding = result.embedding.values;
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
        }]
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

      if (historyArray.length <= MAX_FULL_MESSAGES) {
        return historyArray.map(entry => ({
          role: entry.role === 'assistant' ? 'model' : entry.role,
          parts: entry.content.filter(part => part.text !== undefined)
        })).filter(entry => entry.parts.length > 0);
      }

      const recentMessages = historyArray.slice(-MAX_FULL_MESSAGES);
      const oldMessages = historyArray.slice(0, -MAX_FULL_MESSAGES);

      if (oldMessages.length > 0) {
        if (!this.compressionQueue.has(historyId)) {
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

      const uniqueMessages = Array.from(
        new Map(combined.map(msg => [
          this.extractTextFromMessage(msg),
          msg
        ])).values()
      );

      return uniqueMessages.map(entry => ({
        role: entry.role === 'assistant' ? 'model' : entry.role,
        parts: entry.content.filter(part => part.text !== undefined)
      })).filter(entry => entry.parts.length > 0);

    } catch (error) {
      console.error('History optimization failed:', error);
      return [];
    }
  }

  shouldUseSearch(query) {
    const searchTriggers = [
      /what(?:'s| is) (?:the )?(?:latest|current|recent|new|today)/i,
      /(?:weather|temperature|forecast)/i,
      /(?:news|happening|events?) (?:in|about|on|today)/i,
      /(?:price|cost|worth) of/i,
      /when (?:did|was|is|will)/i,
      /who (?:is|was|won|became)/i,
      /search (?:for|about)/i,
      /find (?:information|info|me|out)/i,
      /look up/i,
      /tell me about (?:the )?(?:latest|current|recent)/i,
      /\b(?:stock|crypto|bitcoin|eth)\b/i,
      /\b(?:election|vote|result)\b/i,
      /\b(?:update|status) (?:on|about|of)/i
    ];

    return searchTriggers.some(pattern => pattern.test(query));
  }

  async cleanupOldMemories(daysOld = 30) {
    try {
      const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
      await db.deleteOldMemoryEntries(cutoffTime);
      console.log(`Cleaned up memories older than ${daysOld} days`);
    } catch (error) {
      console.error('Memory cleanup failed:', error);
    }
  }
}

export const memorySystem = new MemorySystem();

setInterval(() => {
  memorySystem.cleanupOldMemories(30).catch(console.error);
}, 24 * 60 * 60 * 1000);
