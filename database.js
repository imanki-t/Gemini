import { MongoClient } from 'mongodb';

let client;
let db;

const collections = {
  userSettings: 'userSettings',
  serverSettings: 'serverSettings',
  chatHistories: 'chatHistories',
  customInstructions: 'customInstructions',
  blacklistedUsers: 'blacklistedUsers',
  channelSettings: 'channelSettings'
};

export async function connectDB() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/gemini-discord-bot';
    
    client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
    });

    await client.connect();
    db = client.db();
    
    console.log('✅ Connected to MongoDB successfully');
    
    // Create indexes for better performance
    await createIndexes();
    
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    throw error;
  }
}

async function createIndexes() {
  try {
    await db.collection(collections.userSettings).createIndex({ userId: 1 }, { unique: true });
    await db.collection(collections.serverSettings).createIndex({ guildId: 1 }, { unique: true });
    await db.collection(collections.chatHistories).createIndex({ id: 1 }, { unique: true });
    await db.collection(collections.customInstructions).createIndex({ id: 1 }, { unique: true });
    await db.collection(collections.blacklistedUsers).createIndex({ guildId: 1 }, { unique: true });
    await db.collection(collections.channelSettings).createIndex({ channelId: 1 }, { unique: true });
    
    console.log('✅ Database indexes created');
  } catch (error) {
    console.error('⚠️ Error creating indexes:', error.message);
  }
}

export async function closeDB() {
  if (client) {
    await client.close();
    console.log('MongoDB connection closed');
  }
}

// User Settings Operations
export async function saveUserSettings(userId, settings) {
  try {
    await db.collection(collections.userSettings).updateOne(
      { userId },
      { $set: { userId, ...settings, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error saving user settings:', error);
    throw error;
  }
}

export async function getUserSettings(userId) {
  try {
    const settings = await db.collection(collections.userSettings).findOne({ userId });
    return settings || null;
  } catch (error) {
    console.error('Error getting user settings:', error);
    return null;
  }
}

export async function getAllUserSettings() {
  try {
    const settings = await db.collection(collections.userSettings).find({}).toArray();
    const result = {};
    settings.forEach(setting => {
      const { userId, _id, updatedAt, ...rest } = setting;
      result[userId] = rest;
    });
    return result;
  } catch (error) {
    console.error('Error getting all user settings:', error);
    return {};
  }
}

// Server Settings Operations
export async function saveServerSettings(guildId, settings) {
  try {
    await db.collection(collections.serverSettings).updateOne(
      { guildId },
      { $set: { guildId, ...settings, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error saving server settings:', error);
    throw error;
  }
}

export async function getServerSettings(guildId) {
  try {
    const settings = await db.collection(collections.serverSettings).findOne({ guildId });
    return settings || null;
  } catch (error) {
    console.error('Error getting server settings:', error);
    return null;
  }
}

export async function getAllServerSettings() {
  try {
    const settings = await db.collection(collections.serverSettings).find({}).toArray();
    const result = {};
    settings.forEach(setting => {
      const { guildId, _id, updatedAt, ...rest } = setting;
      result[guildId] = rest;
    });
    return result;
  } catch (error) {
    console.error('Error getting all server settings:', error);
    return {};
  }
}

// Chat History Operations
export async function saveChatHistory(id, history) {
  try {
    await db.collection(collections.chatHistories).updateOne(
      { id },
      { $set: { id, history, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error saving chat history:', error);
    throw error;
  }
}

export async function getChatHistory(id) {
  try {
    const record = await db.collection(collections.chatHistories).findOne({ id });
    return record ? record.history : null;
  } catch (error) {
    console.error('Error getting chat history:', error);
    return null;
  }
}

export async function getAllChatHistories() {
  try {
    const histories = await db.collection(collections.chatHistories).find({}).toArray();
    const result = {};
    histories.forEach(history => {
      result[history.id] = history.history;
    });
    return result;
  } catch (error) {
    console.error('Error getting all chat histories:', error);
    return {};
  }
}

export async function deleteChatHistory(id) {
  try {
    await db.collection(collections.chatHistories).deleteOne({ id });
  } catch (error) {
    console.error('Error deleting chat history:', error);
    throw error;
  }
}

// Custom Instructions Operations
export async function saveCustomInstructions(id, instructions) {
  try {
    await db.collection(collections.customInstructions).updateOne(
      { id },
      { $set: { id, instructions, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error saving custom instructions:', error);
    throw error;
  }
}

export async function getCustomInstructions(id) {
  try {
    const record = await db.collection(collections.customInstructions).findOne({ id });
    return record ? record.instructions : null;
  } catch (error) {
    console.error('Error getting custom instructions:', error);
    return null;
  }
}

export async function getAllCustomInstructions() {
  try {
    const instructions = await db.collection(collections.customInstructions).find({}).toArray();
    const result = {};
    instructions.forEach(instruction => {
      result[instruction.id] = instruction.instructions;
    });
    return result;
  } catch (error) {
    console.error('Error getting all custom instructions:', error);
    return {};
  }
}

// Blacklisted Users Operations
export async function saveBlacklistedUsers(guildId, users) {
  try {
    await db.collection(collections.blacklistedUsers).updateOne(
      { guildId },
      { $set: { guildId, users, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error saving blacklisted users:', error);
    throw error;
  }
}

export async function getBlacklistedUsers(guildId) {
  try {
    const record = await db.collection(collections.blacklistedUsers).findOne({ guildId });
    return record ? record.users : null;
  } catch (error) {
    console.error('Error getting blacklisted users:', error);
    return null;
  }
}

export async function getAllBlacklistedUsers() {
  try {
    const blacklists = await db.collection(collections.blacklistedUsers).find({}).toArray();
    const result = {};
    blacklists.forEach(blacklist => {
      result[blacklist.guildId] = blacklist.users;
    });
    return result;
  } catch (error) {
    console.error('Error getting all blacklisted users:', error);
    return {};
  }
}

// Channel Settings Operations (for alwaysRespondChannels, continuousReplyChannels, channelWideChatHistory)
export async function saveChannelSetting(channelId, settingType, value) {
  try {
    await db.collection(collections.channelSettings).updateOne(
      { channelId },
      { $set: { channelId, [settingType]: value, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error saving channel setting:', error);
    throw error;
  }
}

export async function getChannelSetting(channelId, settingType) {
  try {
    const record = await db.collection(collections.channelSettings).findOne({ channelId });
    return record ? record[settingType] : null;
  } catch (error) {
    console.error('Error getting channel setting:', error);
    return null;
  }
}

export async function getAllChannelSettings(settingType) {
  try {
    const settings = await db.collection(collections.channelSettings).find({}).toArray();
    const result = {};
    settings.forEach(setting => {
      if (setting[settingType] !== undefined) {
        result[setting.channelId] = setting[settingType];
      }
    });
    return result;
  } catch (error) {
    console.error('Error getting all channel settings:', error);
    return {};
  }
}

// Active Users in Channels (temporary data, may not need to persist)
export async function saveActiveUsersInChannels(data) {
  try {
    await db.collection('activeUsersInChannels').updateOne(
      { _id: 'active_users' },
      { $set: { data, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error saving active users:', error);
    throw error;
  }
}

export async function getActiveUsersInChannels() {
  try {
    const record = await db.collection('activeUsersInChannels').findOne({ _id: 'active_users' });
    return record ? record.data : {};
  } catch (error) {
    console.error('Error getting active users:', error);
    return {};
  }
}

// User Response Preference
export async function saveUserResponsePreference(userId, preference) {
  try {
    await db.collection('userResponsePreference').updateOne(
      { userId },
      { $set: { userId, preference, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('Error saving user response preference:', error);
    throw error;
  }
}

export async function getUserResponsePreference(userId) {
  try {
    const record = await db.collection('userResponsePreference').findOne({ userId });
    return record ? record.preference : null;
  } catch (error) {
    console.error('Error getting user response preference:', error);
    return null;
  }
}

export async function getAllUserResponsePreferences() {
  try {
    const prefs = await db.collection('userResponsePreference').find({}).toArray();
    const result = {};
    prefs.forEach(pref => {
      result[pref.userId] = pref.preference;
    });
    return result;
  } catch (error) {
    console.error('Error getting all user response preferences:', error);
    return {};
  }
}

export function getDB() {
  return db;
}
