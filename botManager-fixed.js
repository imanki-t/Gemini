import dotenv from 'dotenv';
dotenv.config();
import {
  Client,
  GatewayIntentBits,
  Partials
} from 'discord.js';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';
import {
  fileURLToPath
} from 'url';

import config from './config.js';
import * as db from './database.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// --- ROBUST API KEY ROTATION SYSTEM WITH ERROR RECOVERY ---
const apiKeys = [];
let keyIndex = 1;

// Load all API keys
while (process.env[`GOOGLE_API_KEY${keyIndex}`]) {
  apiKeys.push(process.env[`GOOGLE_API_KEY${keyIndex}`]);
  keyIndex++;
}

if (apiKeys.length === 0 && process.env.GOOGLE_API_KEY) {
  apiKeys.push(process.env.GOOGLE_API_KEY);
}

console.log(`✅ Loaded ${apiKeys.length} API keys for rotation.`);

let currentKeyIdx = 0;
let requestCount = 0;
const ROTATION_THRESHOLD = 10;
const keyUsageStats = new Map();
const keyErrorTracking = new Map();
const MAX_RETRIES_PER_KEY = 2;

// Initialize stats
apiKeys.forEach((_, idx) => {
  keyUsageStats.set(idx, { requests: 0, lastUsed: null, errors: 0, successfulRequests: 0 });
  keyErrorTracking.set(idx, { consecutiveErrors: 0, lastError: null, blocked: false });
});

let currentClient = new GoogleGenAI({ apiKey: apiKeys[0] });

function logKeySwitch(oldIdx, newIdx, reason) {
  const timestamp = new Date().toISOString();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 [API KEY SWITCH] ${timestamp}`);
  console.log(`   Reason: ${reason}`);
  console.log(`   From: Key #${oldIdx + 1} (${apiKeys[oldIdx].slice(0, 8)}...)`);
  console.log(`   To: Key #${newIdx + 1} (${apiKeys[newIdx].slice(0, 8)}...)`);
  console.log(`   Old Key Stats: ${keyUsageStats.get(oldIdx).successfulRequests} successful, ${keyUsageStats.get(oldIdx).errors} errors`);
  console.log(`${'='.repeat(60)}\n`);
}

// Switch to next available (non-blocked) key
function switchToNextKey(reason = 'Rotation') {
  if (apiKeys.length === 1) {
    console.log('⚠️ Only one API key available, cannot switch');
    return false;
  }

  const oldIdx = currentKeyIdx;
  let attempts = 0;
  const maxAttempts = apiKeys.length;

  // Try to find a non-blocked key
  do {
    currentKeyIdx = (currentKeyIdx + 1) % apiKeys.length;
    attempts++;
    
    const tracking = keyErrorTracking.get(currentKeyIdx);
    if (!tracking.blocked) {
      break;
    }
  } while (attempts < maxAttempts);

  // If all keys are blocked, unblock the one with oldest error
  if (keyErrorTracking.get(currentKeyIdx).blocked) {
    console.log('⚠️ All keys blocked, resetting blocks...');
    keyErrorTracking.forEach((tracking) => {
      tracking.blocked = false;
      tracking.consecutiveErrors = 0;
    });
    currentKeyIdx = (oldIdx + 1) % apiKeys.length;
  }

  currentClient = new GoogleGenAI({ apiKey: apiKeys[currentKeyIdx] });
  requestCount = 0;
  
  logKeySwitch(oldIdx, currentKeyIdx, reason);
  return true;
}

// Wrap API call with automatic retry and key switching
async function withRetry(apiCall, context = 'API Call') {
  let lastError = null;
  const startKeyIdx = currentKeyIdx;
  let keysAttempted = 0;

  while (keysAttempted < apiKeys.length) {
    const currentAttemptKey = currentKeyIdx;
    
    try {
      console.log(`🔵 [${context}] Attempting with Key #${currentKeyIdx + 1}`);
      
      // Update stats
      const stats = keyUsageStats.get(currentKeyIdx);
      stats.requests++;
      stats.lastUsed = Date.now();
      
      // Execute the API call
      const result = await apiCall();
      
      // Success! Update stats
      stats.successfulRequests++;
      keyErrorTracking.get(currentKeyIdx).consecutiveErrors = 0;
      
      console.log(`✅ [${context}] Success with Key #${currentKeyIdx + 1}`);
      
      // Check rotation threshold
      requestCount++;
      if (requestCount >= ROTATION_THRESHOLD && apiKeys.length > 1) {
        switchToNextKey('Request threshold reached');
      }
      
      return result;
      
    } catch (error) {
      lastError = error;
      const stats = keyUsageStats.get(currentAttemptKey);
      const tracking = keyErrorTracking.get(currentAttemptKey);
      
      stats.errors++;
      tracking.consecutiveErrors++;
      tracking.lastError = {
        message: error.message,
        timestamp: Date.now()
      };
      
      console.error(`❌ [${context}] Error with Key #${currentAttemptKey + 1}: ${error.message}`);
      
      // Block key if too many consecutive errors
      if (tracking.consecutiveErrors >= MAX_RETRIES_PER_KEY) {
        tracking.blocked = true;
        console.log(`🚫 [${context}] Key #${currentAttemptKey + 1} temporarily blocked due to consecutive errors`);
      }
      
      keysAttempted++;
      
      // Try next key if available
      if (keysAttempted < apiKeys.length) {
        switchToNextKey(`Error recovery (${error.message.slice(0, 50)}...)`);
        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  // All keys failed
  console.error(`💥 [${context}] All ${apiKeys.length} API keys failed!`);
  throw new Error(`All API keys exhausted. Last error: ${lastError?.message || 'Unknown'}`);
}

// Enhanced proxy with error recovery
export const genAI = new Proxy({}, {
  get(target, prop) {
    if (prop === 'models') {
      return {
        generateContent: async (request) => {
          return withRetry(async () => {
            return await currentClient.models.generateContent(request);
          }, 'generateContent');
        },
        generateContentStream: async (request) => {
          return withRetry(async () => {
            return await currentClient.models.generateContentStream(request);
          }, 'generateContentStream');
        },
        embedContent: async (request) => {
          return withRetry(async () => {
            return await currentClient.models.embedContent(request);
          }, 'embedContent');
        }
      };
    }
    
    if (prop === 'chats') {
      return {
        create: (config) => {
          const chat = currentClient.chats.create(config);
          return {
            sendMessage: async (message) => {
              return withRetry(async () => {
                return await chat.sendMessage(message);
              }, 'chat.sendMessage');
            }
          };
        }
      };
    }
    
    if (prop === 'files') {
      return {
        upload: async (options) => {
          return withRetry(async () => {
            return await currentClient.files.upload(options);
          }, 'files.upload');
        },
        get: async (options) => {
          return withRetry(async () => {
            return await currentClient.files.get(options);
          }, 'files.get');
        }
      };
    }
    
    // Fallback for other properties
    const value = currentClient[prop];
    return typeof value === 'function' ? value.bind(currentClient) : value;
  }
});

export function forceKeySwitch(reason = 'Manual switch') {
  return switchToNextKey(reason);
}

export function getApiKeyStats() {
  const stats = [];
  apiKeys.forEach((key, idx) => {
    const keyStats = keyUsageStats.get(idx);
    const tracking = keyErrorTracking.get(idx);
    stats.push({
      keyNumber: idx + 1,
      keyPreview: `${key.slice(0, 8)}...`,
      isCurrent: idx === currentKeyIdx,
      totalRequests: keyStats.requests,
      successfulRequests: keyStats.successfulRequests,
      errors: keyStats.errors,
      consecutiveErrors: tracking.consecutiveErrors,
      blocked: tracking.blocked,
      lastUsed: keyStats.lastUsed ? new Date(keyStats.lastUsed).toISOString() : 'Never',
      lastError: tracking.lastError ? `${tracking.lastError.message.slice(0, 50)}...` : null
    });
  });
  return {
    totalKeys: apiKeys.length,
    currentKey: currentKeyIdx + 1,
    rotationThreshold: ROTATION_THRESHOLD,
    keys: stats
  };
}

// Log stats every 30 minutes
setInterval(() => {
  const stats = getApiKeyStats();
  console.log('\n📊 API Key Usage Statistics:');
  console.log(JSON.stringify(stats, null, 2));
}, 30 * 60 * 1000);

// ---------------------------------------

export const token = process.env.DISCORD_BOT_TOKEN;

// Key: UserId, Value: { queue: Array<Message>, isProcessing: boolean }
export const requestQueues = new Map();

class Mutex {
  constructor() {
    this._locked = false;
    this._queue = [];
  }

  acquire() {
    return new Promise(resolve => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const nextResolve = this._queue.shift();
      nextResolve();
    } else {
      this._locked = false;
    }
  }

  async runExclusive(callback) {
    await this.acquire();
    try {
      return await callback();
    } finally {
      this.release();
    }
  }
}

export const chatHistoryLock = new Mutex();

let chatHistories = {};
let activeUsersInChannels = {};
let customInstructions = {};
let serverSettings = {};
let userSettings = {};
let userResponsePreference = {};
let alwaysRespondChannels = {};
let channelWideChatHistory = {};
let blacklistedUsers = {};
let continuousReplyChannels = {};
let imageUsage = {};
let birthdays = {};
let reminders = {};
let dailyQuotes = {};
let roulette = {};
let complimentCounts = {};
let complimentOptOut = {};
let userTimezones = {}; // NEW: Store user timezones
let serverDigests = {}; // NEW: Store digest cooldowns

export const state = {
  get chatHistories() {
    return chatHistories;
  },
  set chatHistories(v) {
    chatHistories = v;
  },
  get activeUsersInChannels() {
    return activeUsersInChannels;
  },
  set activeUsersInChannels(v) {
    activeUsersInChannels = v;
  },
  get customInstructions() {
    return customInstructions;
  },
  set customInstructions(v) {
    customInstructions = v;
  },
  get serverSettings() {
    return serverSettings;
  },
  set serverSettings(v) {
    serverSettings = v;
  },
  get userSettings() {
    return userSettings;
  },
  set userSettings(v) {
    userSettings = v;
  },
  get userResponsePreference() {
    return userResponsePreference;
  },
  set userResponsePreference(v) {
    userResponsePreference = v;
  },
  get alwaysRespondChannels() {
    return alwaysRespondChannels;
  },
  set alwaysRespondChannels(v) {
    alwaysRespondChannels = v;
  },
  get channelWideChatHistory() {
    return channelWideChatHistory;
  },
  set channelWideChatHistory(v) {
    channelWideChatHistory = v;
  },
  get blacklistedUsers() {
    return blacklistedUsers;
  },
  set blacklistedUsers(v) {
    blacklistedUsers = v;
  },
  get continuousReplyChannels() {
    return continuousReplyChannels;
  },
  set continuousReplyChannels(v) {
    continuousReplyChannels = v;
  },
  get requestQueues() {
    return requestQueues;
  },
  get imageUsage() {
    return imageUsage;
  },
  set imageUsage(v) {
    imageUsage = v;
  },
  get birthdays() {
    return birthdays;
  },
  set birthdays(v) {
    birthdays = v;
  },
  get reminders() {
    return reminders;
  },
  set reminders(v) {
    reminders = v;
  },
  get dailyQuotes() {
    return dailyQuotes;
  },
  set dailyQuotes(v) {
    dailyQuotes = v;
  },
  get roulette() {
    return roulette;
  },
  set roulette(v) {
    roulette = v;
  },
  get complimentCounts() {
    return complimentCounts;
  },
  set complimentCounts(v) {
    complimentCounts = v;
  },
  get complimentOptOut() {
    return complimentOptOut;
  },
  set complimentOptOut(v) {
    complimentOptOut = v;
  },
  get userTimezones() {
    return userTimezones;
  },
  set userTimezones(v) {
    userTimezones = v;
  },
  get serverDigests() {
    return serverDigests;
  },
  set serverDigests(v) {
    serverDigests = v;
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TEMP_DIR = path.join(__dirname, 'temp');

let isSaving = false;
let savePending = false;

export async function saveStateToFile() {
  if (isSaving) {
    savePending = true;
    return;
  }
  isSaving = true;

  try {
    const savePromises = [];

    for (const [userId, settings] of Object.entries(userSettings)) {
      savePromises.push(db.saveUserSettings(userId, settings));
    }

    for (const [guildId, settings] of Object.entries(serverSettings)) {
      savePromises.push(db.saveServerSettings(guildId, settings));
    }

    for (const [id, history] of Object.entries(chatHistories)) {
      savePromises.push(db.saveChatHistory(id, history));
    }

    for (const [id, instructions] of Object.entries(customInstructions)) {
      savePromises.push(db.saveCustomInstructions(id, instructions));
    }

    for (const [guildId, users] of Object.entries(blacklistedUsers)) {
      savePromises.push(db.saveBlacklistedUsers(guildId, users));
    }

    for (const [channelId, value] of Object.entries(alwaysRespondChannels)) {
      savePromises.push(db.saveChannelSetting(channelId, 'alwaysRespond', value));
    }
    for (const [channelId, value] of Object.entries(channelWideChatHistory)) {
      savePromises.push(db.saveChannelSetting(channelId, 'wideChatHistory', value));
    }
    for (const [channelId, value] of Object.entries(continuousReplyChannels)) {
      savePromises.push(db.saveChannelSetting(channelId, 'continuousReply', value));
    }

    for (const [userId, preference] of Object.entries(userResponsePreference)) {
      savePromises.push(db.saveUserResponsePreference(userId, preference));
    }

    for (const [userId, usage] of Object.entries(imageUsage)) {
      savePromises.push(db.saveImageUsage(userId, usage));
    }

    for (const [userId, data] of Object.entries(birthdays)) {
      savePromises.push(db.saveBirthday(userId, data));
    }
    
    for (const [channelId, config] of Object.entries(roulette)) {
      savePromises.push(db.saveRouletteConfig(channelId, config));
    }
    
    for (const [userId, config] of Object.entries(dailyQuotes)) {
      savePromises.push(db.saveDailyQuote(userId, config));
    }
    
    for (const [userId, count] of Object.entries(complimentCounts)) {
      savePromises.push(db.saveComplimentCount(userId, count));
    }
    
    for (const [userId, timezone] of Object.entries(userTimezones)) {
      savePromises.push(db.saveUserTimezone(userId, timezone));
    }
    
    for (const [guildId, digest] of Object.entries(serverDigests)) {
      savePromises.push(db.saveServerDigest(guildId, digest));
    }

    savePromises.push(db.saveActiveUsersInChannels(activeUsersInChannels));

    await Promise.all(savePromises);
  } catch (error) {
    console.error('Error saving state to MongoDB:', error);
  } finally {
    isSaving = false;
    if (savePending) {
      savePending = false;
      saveStateToFile();
    }
  }
}

async function loadStateFromDB() {
  try {
    await fs.mkdir(TEMP_DIR, {
      recursive: true
    });

    console.log('Loading data from MongoDB...');

    [
      chatHistories,
      userSettings,
      serverSettings,
      customInstructions,
      blacklistedUsers,
      userResponsePreference,
      activeUsersInChannels,
      imageUsage,
      birthdays,
      reminders,
      dailyQuotes,
      roulette,
      complimentCounts,
      complimentOptOut,
      userTimezones,
      serverDigests
    ] = await Promise.all([
      db.getAllChatHistories(),
      db.getAllUserSettings(),
      db.getAllServerSettings(),
      db.getAllCustomInstructions(),
      db.getAllBlacklistedUsers(),
      db.getAllUserResponsePreferences(),
      db.getActiveUsersInChannels(),
      db.getAllImageUsages(),
      db.getAllBirthdays(),
      db.getAllReminders(),
      db.getAllDailyQuotes(),
      db.getAllRouletteConfigs(),
      db.getAllComplimentCounts(),
      db.getAllComplimentOptOuts(),
      db.getAllUserTimezones(),
      db.getAllServerDigests()
    ]);

    alwaysRespondChannels = await db.getAllChannelSettings('alwaysRespond');
    channelWideChatHistory = await db.getAllChannelSettings('wideChatHistory');
    continuousReplyChannels = await db.getAllChannelSettings('continuousReply');

    console.log('✅ Data loaded from MongoDB');
  } catch (error) {
    console.error('Error loading state from MongoDB:', error);
  }
}

function preserveAttachmentContext(histories) {
  try {
    Object.values(histories).forEach(subIdEntries => {
      if (typeof subIdEntries === 'object' && subIdEntries !== null) {
        Object.values(subIdEntries).forEach(messages => {
          if (Array.isArray(messages)) {
            messages.forEach(message => {
              if (message.content) {
                message.content = message.content.map(contentItem => {
                  if (contentItem.fileData || contentItem.fileUri) {
                    const mimeType = contentItem.mimeType || contentItem.fileData?.mimeType || 'unknown';
                    const fileName = contentItem.fileName || 'attachment';
                    
                    let fileType = 'File';
                    if (mimeType.startsWith('image/')) fileType = 'Image';
                    else if (mimeType.startsWith('video/')) fileType = 'Video';
                    else if (mimeType.startsWith('audio/')) fileType = 'Audio';
                    else if (mimeType.includes('pdf')) fileType = 'PDF';
                    
                    return {
                      text: `[${fileType} was attached: ${fileName} (${mimeType})]`
                    };
                  }
                  return contentItem;
                });
              }
            });
          }
        });
      }
    });
    console.log('File URIs replaced with descriptive text in chat histories.');
  } catch (error) {
    console.error('An error occurred while preserving attachment context:', error);
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

function scheduleDailyReset() {
  try {
    const now = new Date();
    const nextReset = new Date();
    nextReset.setHours(0, 0, 0, 0);
    if (nextReset <= now) {
      nextReset.setDate(now.getDate() + 1);
    }
    const timeUntilNextReset = nextReset - now;

    setTimeout(async () => {
      console.log('Running daily cleanup task...');
      await chatHistoryLock.runExclusive(async () => {
        preserveAttachmentContext(chatHistories);
        
        const currentMs = Date.now();
        for (const userId in imageUsage) {
            imageUsage[userId].count = 0;
            imageUsage[userId].lastReset = currentMs;
        }
        
        await saveStateToFile();
      });
      console.log('Daily cleanup task finished.');
      scheduleDailyReset();
    }, timeUntilNextReset);

  } catch (error) {
    console.error('An error occurred while scheduling the daily reset:', error);
  }
}

export async function initialize() {
  try {
    await db.connectDB();
    
    await loadStateFromDB();
    
    scheduleDailyReset();
    
    console.log('✅ Bot state loaded and initialized');
    console.log('\n📊 Initial API Key Configuration:');
    console.log(JSON.stringify(getApiKeyStats(), null, 2));
  } catch (error) {
    console.error('Error during initialization:', error);
    throw error;
  }
}

export function getHistory(id, guildId = null) {
  const historyObject = chatHistories[id] || {};
  let combinedHistory = [];

  if (guildId && chatHistories[guildId]) {
    const guildHistory = chatHistories[guildId] || {};
    for (const messagesId in guildHistory) {
      if (guildHistory.hasOwnProperty(messagesId)) {
        combinedHistory = [...combinedHistory, ...guildHistory[messagesId]];
      }
    }
  }

  for (const messagesId in historyObject) {
    if (historyObject.hasOwnProperty(messagesId)) {
      combinedHistory = [...combinedHistory, ...historyObject[messagesId]];
    }
  }

  combinedHistory.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const maxMessages = 50; // Changed from 100 to 50
  if (combinedHistory.length > maxMessages) {
    combinedHistory = combinedHistory.slice(-maxMessages);
  }

  const apiHistory = [];
  let previousTimestamp = null;
  const timeThresholdMs = 30 * 60 * 1000; 

  for (const entry of combinedHistory) {
    const apiEntry = {
      role: entry.role === 'assistant' ? 'model' : entry.role,
      parts: []
    };

    if (previousTimestamp) {
      const timeDiffMs = entry.timestamp - previousTimestamp;
      if (timeDiffMs > timeThresholdMs) { 
          const durationString = formatDuration(timeDiffMs);
          apiEntry.parts.push({ text: `[TIME ELAPSED: ${durationString} since the previous turn]\n` });
      }
    }
    previousTimestamp = entry.timestamp;

    let userInfoAdded = false;
    
    if (Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (part.text !== undefined) {
          let textVal = part.text;
          if (!userInfoAdded && entry.role === 'user' && entry.username && entry.displayName) {
            textVal = `[${entry.displayName} (@${entry.username})]: ${textVal}`;
            userInfoAdded = true;
          }
          apiEntry.parts.push({ text: textVal });
        } 
        else if (part.fileUri) {
          const mime = part.mimeType || 'media';
          apiEntry.parts.push({ text: `[Attachment: Previous file (${mime}) - Content no longer available to vision model]` });
        }
        else if (part.inlineData) {
           apiEntry.parts.push({ text: `[Attachment: Previous inline image]` });
        }
      }
    }

    if (apiEntry.parts.length > 0) {
      apiHistory.push(apiEntry);
    }
  }

  return apiHistory;
}

export function updateChatHistory(id, newHistory, messagesId, username = null, displayName = null) {
  if (!chatHistories[id]) {
    chatHistories[id] = {};
  }

  if (!chatHistories[id][messagesId]) {
    chatHistories[id][messagesId] = [];
  }

  const historyWithUserInfo = newHistory.map(entry => {
    if (entry.role === 'user' && (username || displayName)) {
      return {
        ...entry,
        userId: messagesId,
        username: username,
        displayName: displayName,
        timestamp: Date.now()
      };
    }
    return {
      ...entry,
      timestamp: entry.timestamp || Date.now()
    };
  });

  chatHistories[id][messagesId] = [...chatHistories[id][messagesId], ...historyWithUserInfo];
}

export function getUserResponsePreference(userId) {
  return state.userResponsePreference[userId] || config.defaultResponseFormat;
}

export function initializeBlacklistForGuild(guildId) {
  try {
    if (!state.blacklistedUsers[guildId]) {
      state.blacklistedUsers[guildId] = [];
    }
    if (!state.serverSettings[guildId]) {
      state.serverSettings[guildId] = {
        selectedModel: 'gemini-2.5-flash',
        responseFormat: 'Normal',
        showActionButtons: false,
        continuousReply: false,
        customPersonality: null,
        embedColor: config.hexColour,
        overrideUserSettings: true,
        serverChatHistory: false,
        allowedChannels: []
      };
    } else if (!state.serverSettings[guildId].allowedChannels) {
      state.serverSettings[guildId].allowedChannels = [];
    }
    
    if (state.serverSettings[guildId].showActionButtons === undefined) {
      state.serverSettings[guildId].showActionButtons = false;
    }
    if (state.serverSettings[guildId].continuousReply === undefined) {
      state.serverSettings[guildId].continuousReply = true;
    }
  } catch (error) {
    console.error('Error initializing blacklist for guild:', error);
  }
}

export function checkImageRateLimit(userId) {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const ONE_MINUTE = 60 * 1000;
  
  if (!imageUsage[userId]) {
    imageUsage[userId] = { count: 0, lastReset: now, lastRequest: 0 };
  }

  const usage = imageUsage[userId];

  if (now - usage.lastReset > ONE_DAY) {
    usage.count = 0;
    usage.lastReset = now;
  }

  if (now - usage.lastRequest < ONE_MINUTE) {
    const waitSeconds = Math.ceil((ONE_MINUTE - (now - usage.lastRequest)) / 1000);
    return { 
      allowed: false, 
      message: `⏳ Please wait ${waitSeconds}s before generating another image.` 
    };
  }

  const limit = config.imageConfig?.maxPerDay || 10;
  if (usage.count >= limit) {
    return { 
      allowed: false, 
      message: `🛑 You've reached your daily limit of ${limit} images. Limits reset daily.` 
    };
  }

  return { allowed: true };
}

export function incrementImageUsage(userId) {
  const now = Date.now();
  if (!imageUsage[userId]) {
    imageUsage[userId] = { count: 0, lastReset: now, lastRequest: 0 };
  }
  
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (now - imageUsage[userId].lastReset > ONE_DAY) {
      imageUsage[userId].count = 0;
      imageUsage[userId].lastReset = now;
  }

  imageUsage[userId].count++;
  imageUsage[userId].lastRequest = now;
}

process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  await saveStateToFile();
  await db.closeDB();
  console.log('\n📊 Final API Key Statistics:');
  console.log(JSON.stringify(getApiKeyStats(), null, 2));
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nGracefully shutting down...');
  await saveStateToFile();
  await db.closeDB();
  console.log('\n📊 Final API Key Statistics:');
  console.log(JSON.stringify(getApiKeyStats(), null, 2));
  process.exit(0);
});
