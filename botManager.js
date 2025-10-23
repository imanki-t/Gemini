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

export const activeRequests = new Set();

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

// In-memory state (synced with MongoDB)
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
    // Save to MongoDB instead of files
    const savePromises = [];

    // Save user settings
    for (const [userId, settings] of Object.entries(userSettings)) {
      savePromises.push(db.saveUserSettings(userId, settings));
    }

    // Save server settings
    for (const [guildId, settings] of Object.entries(serverSettings)) {
      savePromises.push(db.saveServerSettings(guildId, settings));
    }

    // Save chat histories
    for (const [id, history] of Object.entries(chatHistories)) {
      savePromises.push(db.saveChatHistory(id, history));
    }

    // Save custom instructions
    for (const [id, instructions] of Object.entries(customInstructions)) {
      savePromises.push(db.saveCustomInstructions(id, instructions));
    }

    // Save blacklisted users
    for (const [guildId, users] of Object.entries(blacklistedUsers)) {
      savePromises.push(db.saveBlacklistedUsers(guildId, users));
    }

    // Save channel settings
    for (const [channelId, value] of Object.entries(alwaysRespondChannels)) {
      savePromises.push(db.saveChannelSetting(channelId, 'alwaysRespond', value));
    }
    for (const [channelId, value] of Object.entries(channelWideChatHistory)) {
      savePromises.push(db.saveChannelSetting(channelId, 'wideChatHistory', value));
    }
    for (const [channelId, value] of Object.entries(continuousReplyChannels)) {
      savePromises.push(db.saveChannelSetting(channelId, 'continuousReply', value));
    }

    // Save user response preferences
    for (const [userId, preference] of Object.entries(userResponsePreference)) {
      savePromises.push(db.saveUserResponsePreference(userId, preference));
    }

    // Save active users (optional - this is temporary data)
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

    // Load all data from MongoDB
    console.log('Loading data from MongoDB...');

    [
      chatHistories,
      userSettings,
      serverSettings,
      customInstructions,
      blacklistedUsers,
      userResponsePreference,
      activeUsersInChannels,
    ] = await Promise.all([
      db.getAllChatHistories(),
      db.getAllUserSettings(),
      db.getAllServerSettings(),
      db.getAllCustomInstructions(),
      db.getAllBlacklistedUsers(),
      db.getAllUserResponsePreferences(),
      db.getActiveUsersInChannels(),
    ]);

    // Load channel-specific settings
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
                  if (contentItem.fileData) {
                    delete contentItem.fileData;
                  }
                  return Object.keys(contentItem).length > 0;
                });
              }
            });
          }
        });
      }
    });
    console.log('fileData elements have been removed from chat histories.');
  } catch (error) {
    console.error('An error occurred while removing fileData elements:', error);
  }
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
        removeFileData(chatHistories);
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
    // Connect to MongoDB first
    await db.connectDB();
    
    // Load state from MongoDB
    await loadStateFromDB();
    
    // Schedule daily cleanup
    scheduleDailyReset();
    
    console.log('✅ Bot state loaded and initialized');
  } catch (error) {
    console.error('Error during initialization:', error);
    throw error;
  }
}

export function getHistory(id) {
  const historyObject = chatHistories[id] || {};
  let combinedHistory = [];

  for (const messagesId in historyObject) {
    if (historyObject.hasOwnProperty(messagesId)) {
      combinedHistory = [...combinedHistory, ...historyObject[messagesId]];
    }
  }

  return combinedHistory.map(entry => {
    return {
      role: entry.role === 'assistant' ? 'model' : entry.role,
      parts: entry.content
    };
  });
}

export function updateChatHistory(id, newHistory, messagesId) {
  if (!chatHistories[id]) {
    chatHistories[id] = {};
  }

  if (!chatHistories[id][messagesId]) {
    chatHistories[id][messagesId] = [];
  }

  chatHistories[id][messagesId] = [...chatHistories[id][messagesId], ...newHistory];
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
        showActionButtons: true,
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
  } catch (error) {
    console.error('Error initializing blacklist for guild:', error);
  }
}

// Graceful shutdown
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
