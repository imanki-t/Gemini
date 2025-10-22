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

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

export const genAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
export { createUserContent, createPartFromUri };
export const token = process.env.DISCORD_BOT_TOKEN;

export const activeRequests = new Set();
export const activeSettingsInteractions = new Map();

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
        this_queue.push(resolve);
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
let serverSettings = {};
let globalUserSettings = {};

export const state = {
  get chatHistories() {
    return chatHistories;
  },
  set chatHistories(v) {
    chatHistories = v;
  },
  get serverSettings() {
    return serverSettings;
  },
  set serverSettings(v) {
    serverSettings = v;
  },
  get globalUserSettings() {
    return globalUserSettings;
  },
  set globalUserSettings(v) {
    globalUserSettings = v;
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(__dirname, 'config');
const CHAT_HISTORIES_DIR = path.join(CONFIG_DIR, 'chat_histories_new');
export const TEMP_DIR = path.join(__dirname, 'temp');

const FILE_PATHS = {
  serverSettings: path.join(CONFIG_DIR, 'server_settings_new.json'),
  globalUserSettings: path.join(CONFIG_DIR, 'global_user_settings.json'),
};

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

function removeFileData(histories) {
  try {
    Object.values(histories).forEach(subIdEntries => {
      subIdEntries.forEach(message => {
        if (message.content) {
          message.content = message.content.filter(contentItem => {
            if (contentItem.fileData) {
              delete contentItem.fileData;
            }
            return Object.keys(contentItem).length > 0;
          });
        }
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
  scheduleDailyReset();
  await loadStateFromFile();
  console.log('Bot state loaded and initialized.');
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

export function getUserSettings(userId) {
  if (!state.globalUserSettings[userId]) {
    state.globalUserSettings[userId] = { ...config.defaultGlobalUserSettings };
  }
  return state.globalUserSettings[userId];
}

export function getServerSettings(guildId) {
  if (!state.serverSettings[guildId]) {
    state.serverSettings[guildId] = { ...config.defaultServerSettings };
  }
  return state.serverSettings[guildId];
}

export function getEffectiveSettings(userId, guildId) {
  const userSettings = getUserSettings(userId);
  
  if (guildId) {
    const serverSettings = getServerSettings(guildId);
    if (serverSettings.overrideUserSettings) {
      return { ...serverSettings, isOverride: true };
    }
  }
  
  return { ...userSettings, isOverride: false };
                                     }
