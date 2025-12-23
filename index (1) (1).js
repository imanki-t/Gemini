import { MessageFlags, EmbedBuilder, ChannelType, PermissionsBitField, ActivityType, REST, Routes } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import express from 'express';

// ============================================================================
// SUPER LOGGING SYSTEM
// ============================================================================
const LOG_COLORS = {
  INFO: '🔵',
  SUCCESS: '✅',
  WARNING: '⚠️',
  ERROR: '❌',
  DEBUG: '🔍',
  NETWORK: '🌐',
  DATABASE: '💾',
  DISCORD: '💬',
  PROCESS: '⚙️'
};

function log(type, message, data = null) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const prefix = `${LOG_COLORS[type] || '📝'} [${timestamp}] [${type}]`;
  
  console.log(`${prefix} ${message}`);
  if (data) {
    console.log('   └─>', JSON.stringify(data, null, 2));
  }
}

// ============================================================================
// STARTUP SEQUENCE
// ============================================================================
log('PROCESS', '🚀 BOT STARTUP INITIATED');
log('INFO', `Node.js Version: ${process.version}`);
log('INFO', `Platform: ${process.platform} ${process.arch}`);
log('INFO', `Working Directory: ${process.cwd()}`);

// ============================================================================
// STEP 1: ENVIRONMENT VALIDATION
// ============================================================================
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('DEBUG', 'STEP 1: VALIDATING ENVIRONMENT VARIABLES');
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const ENV_CHECKS = {
  'DISCORD_BOT_TOKEN': process.env.DISCORD_BOT_TOKEN,
  'GOOGLE_API_KEY': process.env.GOOGLE_API_KEY,
  'MONGODB_URI': process.env.MONGODB_URI,
  'PORT': process.env.PORT || '3000 (default)'
};

let envValid = true;
for (const [key, value] of Object.entries(ENV_CHECKS)) {
  if (!value || value.includes('default')) {
    log('INFO', `${key}: ${value || 'NOT SET'}`);
  } else if (key.includes('TOKEN') || key.includes('KEY') || key.includes('URI')) {
    log('SUCCESS', `${key}: ${value.substring(0, 10)}...${value.substring(value.length - 4)} (length: ${value.length})`);
  } else {
    log('SUCCESS', `${key}: ${value}`);
  }
  
  if (!value && key !== 'PORT') {
    log('ERROR', `Missing required environment variable: ${key}`);
    envValid = false;
  }
}

if (!envValid) {
  log('ERROR', 'CRITICAL: Missing required environment variables. Bot cannot start.');
  log('ERROR', 'Please check your .env file and ensure all required variables are set.');
  process.exit(1);
}

log('SUCCESS', 'All environment variables validated');

// ============================================================================
// STEP 2: IMPORT MODULES
// ============================================================================
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('DEBUG', 'STEP 2: LOADING MODULES');
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

let config, botManager, messageProcessor, settingsHandler, searchCommand, commands, commandHandlers;

try {
  log('INFO', 'Importing config.js...');
  config = (await import('./config.js')).default;
  log('SUCCESS', 'config.js loaded');

  log('INFO', 'Importing botManager.js...');
  botManager = await import('./botManager.js');
  log('SUCCESS', 'botManager.js loaded');

  log('INFO', 'Importing messageProcessor.js...');
  messageProcessor = await import('./modules/messageProcessor.js');
  log('SUCCESS', 'messageProcessor.js loaded');

  log('INFO', 'Importing settingsHandler.js...');
  settingsHandler = await import('./modules/settingsHandler.js');
  log('SUCCESS', 'settingsHandler.js loaded');

  log('INFO', 'Importing searchCommand.js...');
  searchCommand = await import('./modules/searchCommand.js');
  log('SUCCESS', 'searchCommand.js loaded');

  log('INFO', 'Importing commands.js...');
  commands = (await import('./commands.js')).commands;
  log('SUCCESS', 'commands.js loaded');

  log('INFO', 'Importing command handlers...');
  commandHandlers = await import('./commands/index.js');
  log('SUCCESS', 'Command handlers loaded');

} catch (error) {
  log('ERROR', 'Failed to load required modules', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
}

const { client, token, initialize, saveStateToFile, state, TEMP_DIR, initializeBlacklistForGuild } = botManager;
const { processUserQueue } = messageProcessor;
const { handleButtonInteraction, handleSelectMenuInteraction, handleModalSubmit } = settingsHandler;
const { handleSearchCommand } = searchCommand;
const { 
  initializeScheduledTasks,
  handleCommandInteraction: handleNewCommands,
  handleSelectMenuInteraction: handleNewSelectMenus,
  handleModalSubmission: handleNewModals,
  handleButtonInteraction: handleNewButtons,
  processMessageRoulette
} = commandHandlers;

// ============================================================================
// CONSTANTS
// ============================================================================
const HOUR_IN_MS = 3600000;
const DAY_IN_MS = 86400000;
const IGNORED_MESSAGE_TYPES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 20, 21, 22, 23, 24, 25, 
  26, 27, 28, 29, 30, 31, 36, 37, 38, 39, 46
];

// ============================================================================
// GLOBAL ERROR HANDLERS
// ============================================================================
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('DEBUG', 'STEP 3: SETTING UP ERROR HANDLERS');
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

process.on('unhandledRejection', (reason, promise) => {
  log('ERROR', 'Unhandled Promise Rejection', {
    reason: reason,
    promise: promise
  });
});

process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught Exception', {
    message: error.message,
    stack: error.stack
  });
});

log('SUCCESS', 'Error handlers registered');

// ============================================================================
// STEP 4: INITIALIZE BOT SYSTEMS
// ============================================================================
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('DEBUG', 'STEP 4: INITIALIZING BOT SYSTEMS');
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

log('DATABASE', 'Connecting to MongoDB...');
let initializationStartTime = Date.now();

try {
  await initialize();
  const initTime = Date.now() - initializationStartTime;
  log('SUCCESS', `Bot systems initialized in ${initTime}ms`);
} catch (error) {
  log('ERROR', 'Initialization failed', {
    message: error.message,
    stack: error.stack,
    code: error.code
  });
  log('ERROR', 'CRITICAL: Cannot continue without proper initialization');
  process.exit(1);
}

// ============================================================================
// STEP 5: SETUP TEMP FILE CLEANUP
// ============================================================================
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('DEBUG', 'STEP 5: SETTING UP FILE CLEANUP');
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const cleanupTempFiles = async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    let cleaned = 0;
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > HOUR_IN_MS) {
          await fs.unlink(filePath);
          cleaned++;
        }
      } catch (err) {
        continue;
      }
    }
    
    if (cleaned > 0) {
      log('INFO', `🧹 Cleaned ${cleaned} temporary files`);
    }
  } catch (error) {
    log('WARNING', 'Temp file cleanup error', { error: error.message });
  }
};

// Initial cleanup
log('INFO', 'Running initial temp file cleanup...');
cleanupTempFiles().then(() => {
  log('SUCCESS', 'Initial cleanup complete');
});

// Schedule cleanup
setInterval(cleanupTempFiles, HOUR_IN_MS);
log('SUCCESS', 'Cleanup scheduler set (every 1 hour)');

// ============================================================================
// STEP 6: EXPRESS SERVER SETUP
// ============================================================================
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('DEBUG', 'STEP 6: STARTING EXPRESS SERVER');
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  log('NETWORK', `Health check from ${req.ip}`);
  res.json({
    status: 'online',
    bot: client.user?.tag || 'Starting...',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

try {
  app.listen(PORT, () => {
    log('SUCCESS', `Express server listening on port ${PORT}`);
  });
} catch (error) {
  log('ERROR', 'Failed to start Express server', { error: error.message });
}

// ============================================================================
// STEP 7: DISCORD CLIENT EVENT HANDLERS
// ============================================================================
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('DEBUG', 'STEP 7: REGISTERING DISCORD EVENT HANDLERS');
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Activity rotation setup
const activities = config.activities.map(activity => ({
  name: activity.name,
  type: ActivityType[activity.type]
}));
let activityIndex = 0;

log('INFO', `Loaded ${activities.length} activities for rotation`);

// ============================================================================
// CLIENT READY EVENT
// ============================================================================
client.once('clientReady', async () => {
  log('SUCCESS', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('DISCORD', `🎉 BOT IS ONLINE! Logged in as ${client.user.tag}`);
  log('DISCORD', `Bot ID: ${client.user.id}`);
  log('DISCORD', `Connected to ${client.guilds.cache.size} servers`);
  log('DISCORD', `Serving ${client.users.cache.size} users`);
  log('SUCCESS', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Register slash commands
  const rest = new REST().setToken(token);
  
  try {
    log('INFO', 'Registering slash commands...');
    const startTime = Date.now();
    
    await rest.put(
      Routes.applicationCommands(client.user.id), 
      { body: commands }
    );
    
    const regTime = Date.now() - startTime;
    log('SUCCESS', `Registered ${commands.length} slash commands in ${regTime}ms`);
  } catch (error) {
    log('ERROR', 'Failed to register slash commands', {
      message: error.message,
      code: error.code
    });
  }

  // Set initial presence
  try {
    client.user.setPresence({
      activities: [activities[activityIndex]],
      status: 'idle',
    });
    log('SUCCESS', `Set initial activity: ${activities[activityIndex].name}`);
  } catch (error) {
    log('ERROR', 'Failed to set presence', { error: error.message });
  }

  // Activity rotation
  setInterval(() => {
    activityIndex = (activityIndex + 1) % activities.length;
    client.user.setPresence({
      activities: [activities[activityIndex]],
      status: 'idle',
    });
    log('INFO', `🔄 Activity: ${activities[activityIndex].name}`);
  }, DAY_IN_MS);

  // Initialize scheduled tasks
  try {
    log('INFO', 'Initializing scheduled tasks...');
    initializeScheduledTasks(client);
    log('SUCCESS', 'Scheduled tasks initialized');
  } catch (error) {
    log('ERROR', 'Failed to initialize scheduled tasks', { error: error.message });
  }
});

// ============================================================================
// GUILD CREATE EVENT
// ============================================================================
client.on('guildCreate', async (guild) => {
  log('DISCORD', `📥 Joined new server: ${guild.name} (${guild.id})`);
  log('INFO', `Server member count: ${guild.memberCount}`);
  
  try {
    const channel = guild.channels.cache.find(
      channel => 
        channel.type === ChannelType.GuildText &&
        channel.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)
    );
    
    if (channel) {
      await channel.send(`Glad to be in **${guild.name}** !!`);
      log('SUCCESS', `Sent welcome message in ${channel.name}`);
    } else {
      log('WARNING', 'No suitable channel found to send welcome message');
    }
  } catch (error) {
    log('ERROR', 'Failed to send welcome message', { error: error.message });
  }
});

// ============================================================================
// GUILD DELETE EVENT
// ============================================================================
client.on('guildDelete', (guild) => {
  log('DISCORD', `📤 Left server: ${guild.name} (${guild.id})`);
});

// ============================================================================
// MESSAGE CREATE EVENT
// ============================================================================
let messageCount = 0;
client.on('messageCreate', async (message) => {
  messageCount++;
  
  try {
    // Basic filters
    if (message.author.bot) return;
    if (message.content.startsWith('!')) return;
    
    if (IGNORED_MESSAGE_TYPES.includes(message.type)) {
      if (messageCount % 10 === 0) { // Log every 10th ignored message to reduce spam
        log('DEBUG', `Ignored system message type: ${message.type}`);
      }
      return;
    }

    const isDM = message.channel.type === ChannelType.DM;
    const guildId = message.guild?.id;
    const channelId = message.channelId;
    const userId = message.author.id;

    // Guild-specific checks
    if (guildId) {
      initializeBlacklistForGuild(guildId);
      
      if (state.blacklistedUsers[guildId]?.includes(userId)) {
        return;
      }

      const allowedChannels = state.serverSettings[guildId]?.allowedChannels;
      if (allowedChannels && allowedChannels.length > 0 && !allowedChannels.includes(channelId)) {
        return;
      }
    }

    // Determine if bot should respond
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
      if (messageCount % 5 === 0) { // Log every 5th message to reduce spam
        log('DISCORD', `Processing message from ${message.author.tag} in ${isDM ? 'DM' : message.guild.name}`);
      }
      
      // Queue management
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
        log('WARNING', `Queue full for user ${message.author.tag}`);
        return;
      }

      userQueueData.queue.push(message);

      if (!userQueueData.isProcessing) {
        processUserQueue(userId);
      }
    }

    // Process roulette
    processMessageRoulette(message);

  } catch (error) {
    log('ERROR', 'Error processing message', {
      messageId: message.id,
      author: message.author.tag,
      error: error.message,
      stack: error.stack
    });
  }
});

// ============================================================================
// INTERACTION CREATE EVENT
// ============================================================================
let interactionCount = 0;
client.on('interactionCreate', async (interaction) => {
  interactionCount++;
  
  try {
    const interactionType = interaction.isChatInputCommand() ? 'Command' :
                           interaction.isButton() ? 'Button' :
                           interaction.isModalSubmit() ? 'Modal' :
                           interaction.isStringSelectMenu() ? 'SelectMenu' : 'Unknown';
    
    if (interactionCount % 3 === 0) { // Log every 3rd interaction
      log('DISCORD', `${interactionType} interaction from ${interaction.user.tag}`);
    }

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
    log('ERROR', 'Error handling interaction', {
      type: interaction.type,
      customId: interaction.customId || 'N/A',
      user: interaction.user.tag,
      error: error.message,
      stack: error.stack
    });
  }
});

// ============================================================================
// ERROR EVENT
// ============================================================================
client.on('error', (error) => {
  log('ERROR', 'Discord client error', {
    message: error.message,
    code: error.code,
    stack: error.stack
  });
});

// ============================================================================
// WARNING EVENT
// ============================================================================
client.on('warn', (warning) => {
  log('WARNING', `Discord warning: ${warning}`);
});

// ============================================================================
// DISCONNECT EVENT
// ============================================================================
client.on('disconnect', () => {
  log('WARNING', 'Bot disconnected from Discord');
});

// ============================================================================
// RECONNECTING EVENT
// ============================================================================
client.on('reconnecting', () => {
  log('INFO', 'Bot attempting to reconnect to Discord...');
});

// ============================================================================
// COMMAND HANDLER
// ============================================================================
const handleCommandInteraction = async (interaction) => {
  const commandHandlers = {
    settings: async (interaction) => {
      const { showMainSettings } = settingsHandler;
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
    log('INFO', `Executing command: /${interaction.commandName} by ${interaction.user.tag}`);
    await handler(interaction);
  } else {
    log('WARNING', `Unknown command: /${interaction.commandName}`);
  }
};

// ============================================================================
// STEP 8: DISCORD LOGIN
// ============================================================================
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('DEBUG', 'STEP 8: LOGGING INTO DISCORD');
log('DEBUG', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

log('DISCORD', 'Attempting Discord login...');
log('INFO', `Token length: ${token?.length || 0} characters`);
log('INFO', `Token preview: ${token?.substring(0, 20)}...`);

const loginStartTime = Date.now();

client.login(token)
  .then(() => {
    const loginTime = Date.now() - loginStartTime;
    log('SUCCESS', `Login request sent successfully in ${loginTime}ms`);
    log('INFO', 'Waiting for clientReady event...');
  })
  .catch(error => {
    const loginTime = Date.now() - loginStartTime;
    log('ERROR', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('ERROR', `LOGIN FAILED after ${loginTime}ms`);
    log('ERROR', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('ERROR', 'Error details:', {
      message: error.message,
      code: error.code,
      httpStatus: error.httpStatus,
      method: error.method,
      path: error.path,
      stack: error.stack
    });
    
    // Provide helpful error messages
    if (error.code === 'TokenInvalid') {
      log('ERROR', '⚠️  Your Discord bot token is invalid!');
      log('ERROR', '   Solutions:');
      log('ERROR', '   1. Go to https://discord.com/developers/applications');
      log('ERROR', '   2. Select your bot application');
      log('ERROR', '   3. Go to Bot section → Reset Token');
      log('ERROR', '   4. Update DISCORD_BOT_TOKEN in your .env file');
    } else if (error.code === 'DisallowedIntents') {
      log('ERROR', '⚠️  Missing required intents!');
      log('ERROR', '   Solutions:');
      log('ERROR', '   1. Go to https://discord.com/developers/applications');
      log('ERROR', '   2. Select your bot → Bot section');
      log('ERROR', '   3. Enable "Message Content Intent"');
      log('ERROR', '   4. Save changes and restart bot');
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('ETIMEDOUT')) {
      log('ERROR', '⚠️  Network connection issue!');
      log('ERROR', '   Solutions:');
      log('ERROR', '   1. Check your internet connection');
      log('ERROR', '   2. Check if Discord is blocked by firewall');
      log('ERROR', '   3. Try using a VPN if Discord is blocked in your region');
    }
    
    process.exit(1);
  });

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
const shutdown = async (signal) => {
  log('INFO', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log('INFO', `Received ${signal} - Starting graceful shutdown...`);
  log('INFO', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  try {
    log('INFO', 'Saving state to database...');
    await saveStateToFile();
    log('SUCCESS', 'State saved successfully');
    
    log('INFO', 'Destroying Discord client...');
    client.destroy();
    log('SUCCESS', 'Discord client destroyed');
    
    log('SUCCESS', 'Shutdown complete. Goodbye! 👋');
    process.exit(0);
  } catch (error) {
    log('ERROR', 'Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============================================================================
// STARTUP COMPLETE
// ============================================================================
log('SUCCESS', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log('SUCCESS', '✨ BOT STARTUP SEQUENCE COMPLETE');
log('SUCCESS', 'All systems initialized and ready');
log('SUCCESS', 'Waiting for Discord connection...');
log('SUCCESS', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');