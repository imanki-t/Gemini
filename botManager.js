import dotenv from 'dotenv';
dotenv.config();
import {
  Client,
  GatewayIntentBits,
  Partials
} from 'discord.js';
import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} from '@google/genai';
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

export const genAI = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY
});
export {
  createUserContent,
  createPartFromUri
};
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
let imageUsage = {}; // New state for image rate limiting

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
  // Expose the queue to the state object
  get requestQueues() {
    return requestQueues;
  },
  get imageUsage() {
    return imageUsage;
  },
  
  set imageUsage(v) {
    imageUsage = v;
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
      imageUsage
    ] = await Promise.all([
      db.getAllChatHistories(),
      db.getAllUserSettings(),
      db.getAllServerSettings(),
      db.getAllCustomInstructions(),
      db.getAllBlacklistedUsers(),
      db.getAllUserResponsePreferences(),
      db.getActiveUsersInChannels(),
      db.getAllImageUsages()
    ]);

    alwaysRespondChannels = await db.getAllChannelSettings('alwaysRespond');
    channelWideChatHistory = await db.getAllChannelSettings('wideChatHistory');
    continuousReplyChannels = await db.getAllChannelSettings('continuousReply');

    console.log('✅ Data loaded from MongoDB');
  } catch (error) {
    console.error('Error loading state from MongoDB:', error);
  }
}

function removeFileData(histories) {
  try {
    Object.values(histories).forEach(subIdEntries => {
      if (typeof subIdEntries === 'object' && subIdEntries !== null) {
        Object.values(subIdEntries).forEach(messages => {
          if (Array.isArray(messages)) {
            messages.forEach(message => {
              if (message.content) {
                message.content = message.content.filter(contentItem => {
                  if (contentItem.fileData || contentItem.fileUri) {
                    return false;
                  }
                  return contentItem.text !== undefined;
                });
              }
            });
          }
        });
      }
    });
    console.log('fileData and fileUri elements have been removed from chat histories.');
  } catch (error) {
    console.error('An error occurred while removing fileData elements:', error);
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
                  // If this is a fileData/fileUri, replace it with text description
                  if (contentItem.fileData || contentItem.fileUri) {
                    const mimeType = contentItem.mimeType || contentItem.fileData?.mimeType || 'unknown';
                    const fileName = contentItem.fileName || 'attachment';
                    
                    // Determine file type
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

// --- HELPER FUNCTION FOR TIME FORMATTING ---
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
// -------------------------------------------

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
        
        // Reset daily image limits
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
  } catch (error) {
    console.error('Error during initialization:', error);
    throw error;
  }
}

export function getHistory(id, guildId = null) {
  const historyObject = chatHistories[id] || {};
  let combinedHistory = [];

  // If in a guild with user memory, also get recent guild-wide messages
  if (guildId && chatHistories[guildId]) {
    const guildHistory = chatHistories[guildId] || {};
    for (const messagesId in guildHistory) {
      if (guildHistory.hasOwnProperty(messagesId)) {
        combinedHistory = [...combinedHistory, ...guildHistory[messagesId]];
      }
    }
  }

  // Also add user's personal history
  for (const messagesId in historyObject) {
    if (historyObject.hasOwnProperty(messagesId)) {
      combinedHistory = [...combinedHistory, ...historyObject[messagesId]];
    }
  }

  // Sort by timestamp
  combinedHistory.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // Keep only recent messages
  const maxMessages = 100;
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

    // --- FIX: Logic to preserve File URIs ---
    
    // 1. Add Time Context
    if (previousTimestamp) {
      const timeDiffMs = entry.timestamp - previousTimestamp;
      if (timeDiffMs > timeThresholdMs) { 
          const durationString = formatDuration(timeDiffMs);
          apiEntry.parts.push({ text: `[TIME ELAPSED: ${durationString} since the previous turn]\n` });
      }
    }
    previousTimestamp = entry.timestamp;

    // 2. Iterate parts
    let userInfoAdded = false;
    
    if (Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (part.text !== undefined) {
          let textVal = part.text;
          // Add attribution to first text node
          if (!userInfoAdded && entry.role === 'user' && entry.username && entry.displayName) {
            textVal = `[${entry.displayName} (@${entry.username})]: ${textVal}`;
            userInfoAdded = true;
          }
          apiEntry.parts.push({ text: textVal });
        } 
        else if (part.fileUri) {
          // Pass the file URI directly to Gemini
          apiEntry.parts.push({ fileUri: part.fileUri });
        }
        else if (part.inlineData) {
          apiEntry.parts.push({ inlineData: part.inlineData });
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

  // Add user attribution to each message
  const historyWithUserInfo = newHistory.map(entry => {
    // Only add user info if this is a user message and we have the data
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
        overrideUserSettings: false,
        serverChatHistory: false,
        allowedChannels: []
      };
    } else if (!state.serverSettings[guildId].allowedChannels) {
      state.serverSettings[guildId].allowedChannels = [];
    }
    
    // Ensure defaults for existing settings without these properties
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

// --- IMAGE RATE LIMITING LOGIC ---
export function checkImageRateLimit(userId) {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const ONE_MINUTE = 60 * 1000;
  
  if (!imageUsage[userId]) {
    imageUsage[userId] = { count: 0, lastReset: now, lastRequest: 0 };
  }

  const usage = imageUsage[userId];

  // Daily Reset
  if (now - usage.lastReset > ONE_DAY) {
    usage.count = 0;
    usage.lastReset = now;
  }

  // 1. Check Minute Limit (1 per minute)
  if (now - usage.lastRequest < ONE_MINUTE) {
    const waitSeconds = Math.ceil((ONE_MINUTE - (now - usage.lastRequest)) / 1000);
    return { 
      allowed: false, 
      message: `⏳ Please wait ${waitSeconds}s before generating another image.` 
    };
  }

  // 2. Check Daily Limit (10 per day)
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
  
  // Handle edge case where day reset happened in checkImageRateLimit but not saved yet
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
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nGracefully shutting down...');
  await saveStateToFile();
  await db.closeDB();
  process.exit(0);
});

      
