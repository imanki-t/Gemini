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

// --- Core Client and API Initialization ---
// Using new Google GenAI library instead of deprecated @google/generative-ai

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Initialize with new API format that requires apiKey object
export const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
export { createUserContent, createPartFromUri };
export const token = process.env.DISCORD_BOT_TOKEN;

// --- Concurrency and Request Management ---

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


// --- State and Data Management ---

let chatHistories = {};
let activeUsersInChannels = {};
let customInstructions = {};
let serverSettings = {};
let userResponsePreference = {};
let alwaysRespondChannels = {};
let channelWideChatHistory = {};
let blacklistedUsers = {};
let userModelPreference = {}; // New state for user model selection
let userActionButtons = {}; // New state for user action buttons preference
let userContinuousReply = {}; // New state for user continuous reply preference
let userEmbedColor = {}; // New state for user custom embed color

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
  get userModelPreference() {
    return userModelPreference;
  },
  set userModelPreference(v) {
    userModelPreference = v;
  },
  get userActionButtons() {
    return userActionButtons;
  },
  set userActionButtons(v) {
    userActionButtons = v;
  },
  get userContinuousReply() {
    return userContinuousReply;
  },
  set userContinuousReply(v) {
    userContinuousReply = v;
  },
  get userEmbedColor() {
    return userEmbedColor;
  },
  set userEmbedColor(v) {
    userEmbedColor = v;
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(__dirname, 'config');
const CHAT_HISTORIES_DIR = path.join(CONFIG_DIR, 'chat_histories_4');
export const TEMP_DIR = path.join(__dirname, 'temp');

const FILE_PATHS = {
  activeUsersInChannels: path.join(CONFIG_DIR, 'active_users_in_channels.json'),
  customInstructions: path.join(CONFIG_DIR, 'custom_instructions.json'),
  serverSettings: path.join(CONFIG_DIR, 'server_settings.json'),
  userResponsePreference: path.join(CONFIG_DIR, 'user_response_preference.json'),
  alwaysRespondChannels: path.join(CONFIG_DIR, 'always_respond_channels.json'),
  channelWideChatHistory: path.join(CONFIG_DIR, 'channel_wide_chathistory.json'),
  blacklistedUsers: path.join(CONFIG_DIR, 'blacklisted_users.json'),
  userModelPreference: path.join(CONFIG_DIR, 'user_model_preference.json'),
  userActionButtons: path.join(CONFIG_DIR, 'user_action_buttons.json'),
  userContinuousReply: path.join(CONFIG_DIR, 'user_continuous_reply.json'),
  userEmbedColor: path.join(CONFIG_DIR, 'user_embed_color.json'),
};

// --- Data Persistence Functions ---

let isSaving = false;
let savePending = false;

export async function saveStateToFile() {
  if (isSaving) {
    savePending = true;
    return;
  }
  isSaving = true;

  try {
    await fs.mkdir(CONFIG_DIR, {
      recursive: true
    });
    await fs.mkdir(CHAT_HISTORIES_DIR, {
      recursive: true
    });

    const chatHistoryPromises = Object.entries(chatHistories).map(([key, value]) => {
      const filePath = path.join(CHAT_HISTORIES_DIR, `${key}.json`);
      return fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
    });

    const filePromises = Object.entries(FILE_PATHS).map(([key, filePath]) => {
      return fs.writeFile(filePath, JSON.stringify(state[key], null, 2), 'utf-8');
    });

    await Promise.all([...chatHistoryPromises, ...filePromises]);
  } catch (error) {
    console.error('Error saving state to files:', error);
  } finally {
    isSaving = false;
    if (savePending) {
      savePending = false;
      saveStateToFile();
    }
  }
}

async function loadStateFromFile() {
  try {
    await fs.mkdir(CONFIG_DIR, {
      recursive: true
    });
    await fs.mkdir(CHAT_HISTORIES_DIR, {
      recursive: true
    });
    await fs.mkdir(TEMP_DIR, {
      recursive: true
    });

    const files = await fs.readdir(CHAT_HISTORIES_DIR);
    const chatHistoryPromises = files
      .filter(file => file.endsWith('.json'))
      .map(async file => {
        const user = path.basename(file, '.json');
        const filePath = path.join(CHAT_HISTORIES_DIR, file);
        try {
          const data = await fs.readFile(filePath, 'utf-8');
          chatHistories[user] = JSON.parse(data);
        } catch (readError) {
          console.error(`Error reading chat history for ${user}:`, readError);
        }
      });
    await Promise.all(chatHistoryPromises);

    const filePromises = Object.entries(FILE_PATHS).map(async ([key, filePath]) => {
      try {
        const data = await fs.readFile(filePath, 'utf-8');
        state[key] = JSON.parse(data);
      } catch (readError) {
        if (readError.code !== 'ENOENT') {
          console.error(`Error reading ${key} from ${filePath}:`, readError);
        }
      }
    });
    await Promise.all(filePromises);

  } catch (error) {
    console.error('Error loading state from files:', error);
  }
}

// --- Daily Cleanup and Initialization ---

function removeFileData(histories) {
  try {
    Object.values(histories).forEach(subIdEntries => {
      Object.values(subIdEntries).forEach(messages => {
        messages.forEach(message => {
          if (message.content) {
            message.content = message.content.filter(contentItem => {
              if (contentItem.fileData) {
                // Remove file data
                delete contentItem.fileData;
                // If it was just a file part, it might become empty, ensure it's removed if empty.
                return Object.keys(contentItem).length > 0;
              }
              return true;
            });
            // Also clean up content array if it becomes empty
            if (message.content.length === 0) {
              message.content = [{ text: '' }];
            }
          }
        });
      });
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

    setTimeout(async ()       
