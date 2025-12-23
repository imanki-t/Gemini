import { MessageFlags, EmbedBuilder, ChannelType, PermissionsBitField, ActivityType, REST, Routes } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import express from 'express';

import config from './config.js';
import { client, token, initialize, saveStateToFile, state, TEMP_DIR, initializeBlacklistForGuild } from './botManager.js';
import { processUserQueue } from './modules/messageProcessor.js';
import { handleButtonInteraction, handleSelectMenuInteraction, handleModalSubmit } from './modules/settingsHandler.js';
import { handleSearchCommand } from './modules/searchCommand.js';
import { commands } from './commands.js';

import { 
  initializeScheduledTasks,
  handleCommandInteraction as handleNewCommands,
  handleSelectMenuInteraction as handleNewSelectMenus,
  handleModalSubmission as handleNewModals,
  handleButtonInteraction as handleNewButtons,
  processMessageRoulette
} from './commands/index.js';

const HOUR_IN_MS = 3600000;
const DAY_IN_MS = 86400000;
const STARTUP_TIMEOUT = 45000;
const LOGIN_TIMEOUT = 30000;

const IGNORED_MESSAGE_TYPES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 20, 21, 22, 23, 24, 25, 
  26, 27, 28, 29, 30, 31, 36, 37, 38, 39, 46
];

if (!token) {
  console.error('❌ CRITICAL: DISCORD_BOT_TOKEN is not set in environment variables!');
  process.exit(1);
}

console.log('🔑 Token validation: OK');

const app = express();
const PORT = process.env.PORT || 3000;

let serverReady = false;
let botReady = false;

app.get('/', (req, res) => {
  res.json({
    status: botReady ? 'online' : 'initializing',
    bot: client.user?.tag || 'Connecting...',
    uptime: process.uptime(),
    botReady: botReady,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  const healthStatus = serverReady && botReady;
  res.status(healthStatus ? 200 : 503).json({
    status: healthStatus ? 'healthy' : 'initializing',
    server: serverReady,
    bot: botReady,
    timestamp: new Date().toISOString(),
    botConnected: client.isReady()
  });
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

const server = app.listen(PORT, () => {
  console.log(`✅ Express server running on port ${PORT}`);
  serverReady = true;
});

const cleanupTempFiles = async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > HOUR_IN_MS) {
          await fs.unlink(filePath);
        }
      } catch (err) {
        continue;
      }
    }
  } catch (error) {
    console.error('Temp cleanup error:', error.message);
  }
};

setInterval(cleanupTempFiles, HOUR_IN_MS);

(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > HOUR_IN_MS) {
          await fs.unlink(filePath);
        }
      } catch (err) {}
    }
  } catch (error) {}
})();

const activities = config.activities.map(activity => ({
  name: activity.name,
  type: ActivityType[activity.type]
}));

let activityIndex = 0;

async function startBot() {
  const startTime = Date.now();
  
  try {
    console.log('🚀 Starting bot initialization...');
    
    const initPromise = (async () => {
      console.log('📦 Initializing database...');
      await initialize();
      console.log('✅ Database initialized');
    })();
    
    const initTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Database initialization timeout')), 30000)
    );
    
    await Promise.race([initPromise, initTimeout]);
    
    console.log('🔐 Logging into Discord...');
    
    const loginPromise = client.login(token);
    const loginTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Discord login timeout after 30 seconds')), LOGIN_TIMEOUT)
    );
    
    await Promise.race([loginPromise, loginTimeout]);
    console.log('✅ Login successful, waiting for ready event...');
    
    const readyTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Ready event timeout')), 15000)
    );
    
    const readyPromise = new Promise((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once('ready', resolve);
      }
    });
    
    await Promise.race([readyPromise, readyTimeout]);
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Bot fully initialized in ${(elapsed / 1000).toFixed(2)}s`);
    
  } catch (error) {
    console.error('❌ CRITICAL ERROR during bot startup:', error.message);
    
    if (error.message?.includes('timeout')) {
      console.error('🔴 Startup timeout. Possible causes:');
      console.error('  - Network connectivity issues on host platform');
      console.error('  - Discord API connectivity problems');
      console.error('  - MongoDB connection issues');
      console.error('  - Firewall blocking WebSocket connections');
    } else if (error.code === 'TokenInvalid') {
      console.error('🔴 Invalid Discord token! Verify DISCORD_BOT_TOKEN in environment');
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.error('🔴 Network error: Cannot connect to Discord/MongoDB');
    } else if (error.message?.includes('MongoDB')) {
      console.error('🔴 MongoDB connection failed. Verify MONGODB_URI');
    }
    
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}!`);
  console.log(`📊 Serving ${client.guilds.cache.size} guilds`);

  const rest = new REST().setToken(token);
  
  try {
    console.log('🔄 Refreshing application (/) commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error.message);
  }

  client.user.setPresence({
    activities: [activities[activityIndex]],
    status: 'idle',
  });

  setInterval(() => {
    activityIndex = (activityIndex + 1) % activities.length;
    client.user.setPresence({
      activities: [activities[activityIndex]],
      status: 'idle',
    });
  }, DAY_IN_MS);

  try {
    initializeScheduledTasks(client);
  } catch (error) {
    console.error('Error initializing scheduled tasks:', error.message);
  }
  
  botReady = true;
  console.log('🎉 Bot is fully operational!');
});

client.on('error', error => {
  console.error('❌ Discord client error:', error.message);
});

client.on('shardError', error => {
  console.error('❌ Shard error:', error.message);
});

client.on('warn', info => {
  console.warn('⚠️ Warning:', info);
});

client.on('disconnect', () => {
  console.warn('⚠️ Bot disconnected from Discord');
  botReady = false;
});

client.on('reconnecting', () => {
  console.log('🔄 Reconnecting to Discord...');
});

client.on('resume', () => {
  console.log('✅ Connection resumed');
  botReady = true;
});

client.on('guildCreate', async (guild) => {
  try {
    const channel = guild.channels.cache.find(
      channel => 
        channel.type === ChannelType.GuildText &&
        channel.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)
    );
    
    if (channel) {
      await channel.send(`Glad to be in **${guild.name}** !!`);
    }
  } catch (error) {
    console.error('Error sending guild join message:', error.message);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.content.startsWith('!')) return;
    if (IGNORED_MESSAGE_TYPES.includes(message.type)) return;

    const isDM = message.channel.type === ChannelType.DM;
    const guildId = message.guild?.id;
    const channelId = message.channelId;
    const userId = message.author.id;

    if (guildId) {
      initializeBlacklistForGuild(guildId);
      
      if (state.blacklistedUsers[guildId]?.includes(userId)) return;

      const allowedChannels = state.serverSettings[guildId]?.allowedChannels;
      if (allowedChannels && allowedChannels.length > 0 && !allowedChannels.includes(channelId)) return;
    }

    const userSettings = state.userSettings[userId] || {};
    const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
    const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;
    const continuousReply = effectiveSettings.continuousReply ?? true;
    const channelContinuousReply = state.continuousReplyChannels?.[channelId] || false;

    const shouldRespond = (
      (isDM && config.workInDMs && (continuousReply || message.mentions.users.has(client.user.id))) ||
      (guildId && message.mentions.users.has(client.user.id)) ||
      (guildId && !message.mentions.users.has(client.user.id) && (channelContinuousReply || continuousReply)) ||
      state.alwaysRespondChannels[channelId] ||
      state.activeUsersInChannels[channelId]?.[userId]
    );

    if (shouldRespond) {
      if (!state.requestQueues.has(userId)) {
        state.requestQueues.set(userId, { queue: [], isProcessing: false });
      }

      const userQueueData = state.requestQueues.get(userId);

      if (userQueueData.queue.length >= 5) {
        const embed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle('⏳ Queue Full')
          .setDescription('You have 5 requests pending. Please wait for them to finish.');
        
        await message.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });
        return; 
      }

      userQueueData.queue.push(message);

      if (!userQueueData.isProcessing) {
        processUserQueue(userId);
      }
    }

    processMessageRoulette(message);

  } catch (error) {
    console.error('Error processing message:', error.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommandInteraction(interaction);
    } else if (interaction.isButton()) {
      const newCommandButtons = [
        'tod_again', 'akinator_yes_', 'akinator_no_', 'akinator_maybe_',
        'akinator_correct_', 'akinator_wrong_', 'akinator_again',
        'tds_again', 'nhie_next', 'wyr_option1', 'wyr_option2', 'wyr_next',
        'wyr_results_', 'timezone_next_page', 'timezone_prev_page', 
        'timezone_custom', 'reminder_action_delete'
      ];
      
      const isNewCommandButton = newCommandButtons.some(prefix => 
        interaction.customId.startsWith(prefix)
      );
      
      if (isNewCommandButton) {
        await handleNewButtons(interaction);
      } else {
        await handleButtonInteraction(interaction);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('reminder_modal_') || interaction.customId === 'timezone_modal') {
        await handleNewModals(interaction);
      } else {
        await handleModalSubmit(interaction);
      }
    } else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
      const newCommandMenus = [
        'birthday_month', 'birthday_day_', 'birthday_name_', 'birthday_pref_', 'birthday_delete_select',
        'reminder_action', 'reminder_type', 'reminder_location_', 'reminder_delete_select',
        'quote_action', 'quote_category', 'quote_time_', 'quote_location_', 'quote_channel_', 'quote_remove_select',
        'roulette_action', 'roulette_rarity',
        'game_select', 'tod_choice', 'tds_choice', 'akinator_mode',
        'timezone_region', 'timezone_select'
      ];
      
      const isNewCommandMenu = newCommandMenus.some(prefix => 
        interaction.customId.startsWith(prefix)
      );
      
      if (isNewCommandMenu) {
        await handleNewSelectMenus(interaction);
      } else {
        await handleSelectMenuInteraction(interaction);
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error.message);
  }
});

const handleCommandInteraction = async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const commandHandlers = {
    settings: async (interaction) => {
      const { showMainSettings } = await import('./modules/settingsHandler.js');
      await showMainSettings(interaction, false);
    },
    search: handleSearchCommand,
    birthday: handleNewCommands,
    reminder: handleNewCommands,
    quote: handleNewCommands,
    roulette: handleNewCommands,
    anniversary: handleNewCommands,
    digest: handleNewCommands,
    starter: handleNewCommands,
    compliment: handleNewCommands,
    game: handleNewCommands,
    timezone: handleNewCommands,
    summary: handleNewCommands,
    realive: handleNewCommands
  };

  const handler = commandHandlers[interaction.commandName];
  
  if (handler) {
    await handler(interaction);
  } else {
    console.log(`Unknown command: ${interaction.commandName}`);
  }
};

const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  try {
    await saveStateToFile();
    console.log('✅ State saved');
  } catch (error) {
    console.error('Error saving state:', error.message);
  }
  
  try {
    client.destroy();
    console.log('✅ Discord client destroyed');
  } catch (error) {
    console.error('Error destroying client:', error.message);
  }
  
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
  
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

startBot();
