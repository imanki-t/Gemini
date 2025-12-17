import { genAI } from './botManager.js';
import * as db from './database.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_DIR = path.join(__dirname, 'temp');

// ✅ CORRECT: Latest model
const EMBEDDING_MODEL = 'gemini-embedding-001';

const MAX_CONTEXT_TOKENS = 30000;
const TOKENS_PER_MESSAGE = 150;
const MAX_FULL_MESSAGES = 10;
const COMPRESSION_THRESHOLD = 60;
const INDEX_BATCH_SIZE = 50;

class MemorySystem {
  constructor() {
    this.embeddingCache = new Map();
    this.indexingQueue = new Map();
    this.lastIndexedCount = new Map();
  }

  /**
   * ✅ FIXED: Correct SDK usage for embeddings
   */
  async generateEmbedding(text, taskType = 'RETRIEVAL_DOCUMENT') {
    // 1. Critical Validation
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return null;
    }

    const cacheKey = text.slice(0, 100) + taskType;
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey);
    }

    try {
      // ✅ CORRECT SDK FORMAT
      const result = await genAI.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: {
          taskType: taskType
        }
      });
      
      // ✅ CORRECT: Access embeddings array
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
      // ✅ CORRECT SDK FORMAT
      const conversationText = messages.map((msg, idx) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const text = this.extractTextFromMessage(msg);
        return `${role}: ${text}`;
      }).join('\n\n');

      const request = {
        model: model,
        contents: [{ role: 'user', parts: [{ text: `Summarize this conversation:\n\n${conversationText}` }] }],
        systemInstruction: { parts: [{ text: "Summarize the following conversation history concisely while preserving key information, context, and important details. Keep the summary factual and comprehensive." }] },
        generationConfig: {
          temperature: 0.3,
          topP: 0.95
        }
      };

      const result = await genAI.models.generateContent(request);
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
      return messages.slice(-3);
    }
  }

  async getRelevantContext(historyId, currentQuery, allHistory, maxRelevant = 5) {
    try {
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

  /**
   * Convert messages to readable text format for file upload
   */
  messagesToText(messages) {
    let text = '';
    let previousTimestamp = null;
    const timeThresholdMs = 30 * 60 * 1000;

    for (const entry of messages) {
      // Add time context
      if (previousTimestamp && entry.timestamp) {
        const timeDiffMs = entry.timestamp - previousTimestamp;
        if (timeDiffMs > timeThresholdMs) {
          const durationString = this.formatDuration(timeDiffMs);
          text += `\n[TIME ELAPSED: ${durationString} since the previous turn]\n`;
        }
      }
      previousTimestamp = entry.timestamp;

      // Add role
      const role = entry.role === 'user' ? 'User' : 'Assistant';
      text += `\n${role}`;

      // Add user attribution if available
      if (entry.role === 'user' && entry.username && entry.displayName) {
        text += ` [${entry.displayName} (@${entry.username})]`;
      }
      text += ':\n';

      // Add content
      for (const part of entry.content) {
        if (part.text !== undefined && part.text !== '') {
          text += part.text + '\n';
        } else if (part.fileUri) {
          const mime = part.mimeType || 'unknown';
          text += `[Attachment: Previous file (${mime}) - Content no longer available]\n`;
        } else if (part.inlineData) {
          text += `[Attachment: Previous inline image]\n`;
        }
      }

      text += '\n';
    }

    return text;
  }

  /**
   * ✅ FIXED: Correct file upload API - returns fileData object for inline use
   */
  async uploadHistoryAsFile(text, filename, description) {
    try {
      // For short texts, return inline data instead of file upload
      if (text.length < 1000) {
        return {
          description,
          text: text,  // Inline text
          mimeType: 'text/plain'
        };
      }

      // For longer texts, upload as file
      await fs.mkdir(TEMP_DIR, { recursive: true });

      const filePath = path.join(TEMP_DIR, filename);
      await fs.writeFile(filePath, text, 'utf8');

      // ✅ CORRECT SDK: Use 'path' parameter with file path string
      const uploadResult = await genAI.files.upload({
        path: filePath,
        config: {
          mimeType: 'text/plain',
          displayName: filename,
        }
      });

      // Clean up temp file
      await fs.unlink(filePath).catch(() => {});

      return {
        description,
        fileUri: uploadResult.uri,
        mimeType: 'text/plain'
      };
    } catch (error) {
      console.error('Failed to upload history file:', error.message);
      // Fallback to inline text
      return {
        description,
        text: text.slice(0, 10000),  // Truncate if needed
        mimeType: 'text/plain'
      };
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

      // If history is short enough, return as-is (formatted for API)
      if (historyArray.length <= MAX_FULL_MESSAGES) {
        return this.formatHistoryWithContext(historyArray);
      }

      // For longer histories, use inline text or files with RAG
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

      // ✅ FIXED: Build history with proper parts structure
      const fileHistory = [];

      // Add compressed/summary history
      if (compressedOld.length > 0) {
        const summaryText = this.messagesToText(compressedOld);
        const summaryCount = oldMessages.length;
        const summaryFile = await this.uploadHistoryAsFile(
          summaryText,
          `history_summary_${historyId}_${Date.now()}.txt`,
          `Summarized ${summaryCount} older messages`
        );
        
        if (summaryFile) {
          const parts = [{ text: `[${summaryFile.description}]` }];
          
          // ✅ CRITICAL FIX: Add proper file part based on what was returned
          if (summaryFile.fileUri) {
            parts.push({
              fileData: {
                fileUri: summaryFile.fileUri,
                mimeType: summaryFile.mimeType
              }
            });
          } else if (summaryFile.text) {
            parts.push({ text: summaryFile.text });
          }
          
          fileHistory.push({
            role: 'user',
            parts: parts
          });
        }
      }

      // Add relevant context if any
      if (relevantContext.length > 0) {
        const contextText = this.messagesToText(relevantContext);
        const contextFile = await this.uploadHistoryAsFile(
          contextText,
          `relevant_context_${historyId}_${Date.now()}.txt`,
          `${relevantContext.length} relevant messages from memory`
        );
        
        if (contextFile) {
          const parts = [{ text: `[${contextFile.description}]` }];
          
          // ✅ CRITICAL FIX: Add proper file part
          if (contextFile.fileUri) {
            parts.push({
              fileData: {
                fileUri: contextFile.fileUri,
                mimeType: contextFile.mimeType
              }
            });
          } else if (contextFile.text) {
            parts.push({ text: contextFile.text });
          }
          
          fileHistory.push({
            role: 'user',
            parts: parts
          });
        }
      }

      // Return formatted recent messages directly (no files needed for recent context)
      return [...fileHistory, ...this.formatHistoryWithContext(recentMessages)];
      
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
