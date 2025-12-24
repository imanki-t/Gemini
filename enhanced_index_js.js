// ============================================================================
// ULTRA-VERBOSE DISCORD BOT LOGGER
// Completely rewritten with maximum diagnostic information
// ============================================================================

// ============================================================================
// LOGGING SYSTEM
// ============================================================================
const LOG_STYLES = {
  HEADER: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  SUBHEADER: '─────────────────────────────────────────────────────────────────────',
};

const LOG_ICONS = {
  SYSTEM: '⚙️',
  SUCCESS: '✅',
  ERROR: '❌',
  WARNING: '⚠️',
  INFO: '🔵',
  DEBUG: '🔍',
  NETWORK: '🌐',
  DATABASE: '💾',
  DISCORD: '💬',
  WEBSOCKET: '🔌',
  GATEWAY: '🚪',
  INTENTS: '🎯',
  EVENTS: '📢',
  CRITICAL: '🚨',
  TICK: '⏱️',
  PROGRESS: '⏳'
};

let logCounter = 0;
const startTime = Date.now();

function getTimestamp() {
  const now = new Date();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  return `[${now.toISOString().split('T')[1].split('.')[0]}] (+${elapsed}s)`;
}

function log(icon, message, data = null, indentLevel = 0) {
  logCounter++;
  const indent = '  '.repeat(indentLevel);
  const prefix = `${icon} ${getTimestamp()} [#${logCounter.toString().padStart(4, '0')}]`;
  console.log(`${prefix} ${indent}${message}`);
  
  if (data !== null && data !== undefined) {
    if (typeof data === 'object') {
      console.log(JSON.stringify(data, null, 2).split('\n').map(line => `${indent}    ${line}`).join('\n'));
    } else {
      console.log(`${indent}    └─> ${data}`);
    }
  }
}

function logHeader(message) {
  console.log('');
  log(LOG_ICONS.SYSTEM, LOG_STYLES.HEADER);
  log(LOG_ICONS.SYSTEM, `  ${message}  `);
  log(LOG_ICONS.SYSTEM, LOG_STYLES.HEADER);
}

function logSubheader(message) {
  log(LOG_ICONS.INFO, LOG_STYLES.SUBHEADER);
  log(LOG_ICONS.INFO, message);
  log(LOG_ICONS.INFO, LOG_STYLES.SUBHEADER);
}

// ============================================================================
// STARTUP BANNER
// ============================================================================
console.clear();
console.log('\n\n');
console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║                                                                      ║');
console.log('║              🤖 DISCORD BOT ULTRA-DIAGNOSTIC MODE 🤖                 ║');
console.log('║                                                                      ║');
console.log('║                  Starting with maximum verbosity...                  ║');
console.log('║                                                                      ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');
console.log('\n');

log(LOG_ICONS.SYSTEM, '🚀 BOT DIAGNOSTIC SEQUENCE INITIATED');
log(LOG_ICONS.INFO, `Process ID: ${process.pid}`);
log(LOG_ICONS.INFO, `Node.js: ${process.version}`);
log(LOG_ICONS.INFO, `Platform: ${process.platform} ${process.arch}`);
log(LOG_ICONS.INFO, `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB used`);
log(LOG_ICONS.INFO, `Working Directory: ${process.cwd()}`);

// ============================================================================
// STEP 1: ENVIRONMENT VALIDATION
// ============================================================================
logHeader('STEP 1: ENVIRONMENT VALIDATION');

log(LOG_ICONS.INFO, 'Checking for .env file...');
try {
  const fs = await import('fs');
  if (fs.existsSync('.env')) {
    log(LOG_ICONS.SUCCESS, '.env file found');
  } else {
    log(LOG_ICONS.WARNING, '.env file not found (using system environment variables)');
  }
} catch (e) {
  log(LOG_ICONS.WARNING, 'Could not check for .env file');
}

log(LOG_ICONS.INFO, 'Scanning environment variables...');

// Check for Google API keys
const googleApiKeys = [];
let keyIndex = 1;
while (process.env[`GOOGLE_API_KEY${keyIndex}`]) {
  googleApiKeys.push(process.env[`GOOGLE_API_KEY${keyIndex}`]);
  keyIndex++;
}
if (googleApiKeys.length === 0 && process.env.GOOGLE_API_KEY) {
  googleApiKeys.push(process.env.GOOGLE_API_KEY);
}

const envVars = {
  'DISCORD_BOT_TOKEN': process.env.DISCORD_BOT_TOKEN,
  'MONGODB_URI': process.env.MONGODB_URI,
  'PORT': process.env.PORT || '3000',
  'NODE_ENV': process.env.NODE_ENV || 'development'
};

let envValid = true;
logSubheader('Environment Variables Status:');

for (const [key, value] of Object.entries(envVars)) {
  if (!value) {
    log(LOG_ICONS.ERROR, `${key}: NOT SET`, null, 1);
    if (key === 'DISCORD_BOT_TOKEN' || key === 'MONGODB_URI') {
      envValid = false;
    }
  } else if (key.includes('TOKEN') || key.includes('URI')) {
    const preview = `${value.substring(0, 12)}...${value.substring(value.length - 4)}`;
    log(LOG_ICONS.SUCCESS, `${key}: ${preview} (${value.length} chars)`, null, 1);
  } else {
    log(LOG_ICONS.SUCCESS, `${key}: ${value}`, null, 1);
  }
}

if (googleApiKeys.length === 0) {
  log(LOG_ICONS.ERROR, 'GOOGLE_API_KEY: NOT SET', null, 1);
  envValid = false;
} else {
  log(LOG_ICONS.SUCCESS, `GOOGLE_API_KEY: Found ${googleApiKeys.length} key(s)`, null, 1);
  googleApiKeys.forEach((key, idx) => {
    const num = idx === 0 && !process.env.GOOGLE_API_KEY1 ? '' : idx + 1;
    log(LOG_ICONS.INFO, `  Key ${idx + 1}: ${key.substring(0, 15)}... (${key.length} chars)`, null, 2);
  });
}

if (!envValid) {
  log(LOG_ICONS.CRITICAL, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(LOG_ICONS.CRITICAL, 'FATAL: Missing required environment variables!');
  log(LOG_ICONS.CRITICAL, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(1);
}

log(LOG_ICONS.SUCCESS, '✓ All required environment variables present');

// ============================================================================
// STEP 2: MODULE IMPORTS
// ============================================================================
logHeader('STEP 2: IMPORTING MODULES');

const modules = {};
const imports = [
  { name: 'discord.js', path: 'discord.js' },
  { name: 'fs/promises', path: 'fs/promises' },
  { name: 'path', path: 'path' },
  { name: 'express', path: 'express' },
  { name: 'config', path: './config.js' },
  { name: 'botManager', path: './botManager.js' },
  { name: 'messageProcessor', path: './modules/messageProcessor.js' },
  { name: 'settingsHandler', path: './modules/settingsHandler.js' },
  { name: 'searchCommand', path: './modules/searchCommand.js' },
  { name: 'commands', path: './commands.js' },
  { name: 'commandHandlers', path: './commands/index.js' }
];

for (const imp of imports) {
  try {
    log(LOG_ICONS.INFO, `Importing ${imp.name}...`, null, 1);
    const imported = await import(imp.path);
    modules[imp.name] = imported;
    log(LOG_ICONS.SUCCESS, `✓ ${imp.name} loaded`, null, 1);
  } catch (error) {
    log(LOG_ICONS.ERROR, `✗ Failed to import ${imp.name}`, null, 1);
    log(LOG_ICONS.ERROR, error.message, null, 2);
    log(LOG_ICONS.ERROR, error.stack, null, 2);
    process.exit(1);
  }
}

log(LOG_ICONS.SUCCESS, '✓ All modules imported successfully');

// Extract imports
const { MessageFlags, EmbedBuilder, ChannelType, PermissionsBitField, ActivityType, REST, Routes } = modules['discord.js'];
const fs = modules['fs/promises'];
const path = modules['path'];
const express = modules['express'].default || modules['express'];
const config = modules['config'].default || modules['config'];
const { client, token, initialize, saveStateToFile, state, TEMP_DIR, initializeBlacklistForGuild } = modules['botManager'];
const { processUserQueue } = modules['messageProcessor'];
const { handleButtonInteraction, handleSelectMenuInteraction, handleModalSubmit } = modules['settingsHandler'];
const { handleSearchCommand } = modules['searchCommand'];
const { commands } = modules['commands'];
const { 
  initializeScheduledTasks,
  handleCommandInteraction: handleNewCommands,
  handleSelectMenuInteraction: handleNewSelectMenus,
  handleModalSubmission: handleNewModals,
  handleButtonInteraction: handleNewButtons,
  processMessageRoulette
} = modules['commandHandlers'];

// ============================================================================
// STEP 3: INSPECT DISCORD CLIENT
// ============================================================================
logHeader('STEP 3: DISCORD CLIENT INSPECTION');

log(LOG_ICONS.INFO, 'Analyzing Discord.js Client Configuration...');
log(LOG_ICONS.INFO, `Client instance: ${client ? 'CREATED' : 'MISSING'}`, null, 1);

if (client) {
  log(LOG_ICONS.INFO, 'Client Properties:', null, 1);
  log(LOG_ICONS.INFO, `- Ready State: ${client.isReady()}`, null, 2);
  log(LOG_ICONS.INFO, `- WebSocket: ${client.ws ? 'Initialized' : 'Not initialized'}`, null, 2);
  
  if (client.options && client.options.intents) {
    log(LOG_ICONS.INTENTS, 'Configured Intents:', null, 1);
    const intentBits = client.options.intents.bitfield || client.options.intents;
    log(LOG_ICONS.INFO, `- Intent Bitfield: ${intentBits}`, null, 2);
    
    // Decode intents
    const { GatewayIntentBits } = modules['discord.js'];
    const intents = [];
    if (intentBits & GatewayIntentBits.Guilds) intents.push('Guilds');
    if (intentBits & GatewayIntentBits.GuildMessages) intents.push('GuildMessages');
    if (intentBits & GatewayIntentBits.MessageContent) intents.push('MessageContent ⚠️ PRIVILEGED');
    if (intentBits & GatewayIntentBits.DirectMessages) intents.push('DirectMessages');
    if (intentBits & GatewayIntentBits.GuildMembers) intents.push('GuildMembers ⚠️ PRIVILEGED');
    
    intents.forEach(intent => {
      log(LOG_ICONS.INFO, `- ${intent}`, null, 2);
    });
    
    if (!intents.includes('MessageContent ⚠️ PRIVILEGED')) {
      log(LOG_ICONS.WARNING, '⚠️  MessageContent intent may be missing!', null, 2);
    }
  }
  
  if (client.options && client.options.partials) {
    log(LOG_ICONS.INFO, 'Configured Partials:', null, 1);
    log(LOG_ICONS.INFO, JSON.stringify(client.options.partials), null, 2);
  }
}

log(LOG_ICONS.INFO, `Token validation: ${token ? `${token.length} characters` : 'MISSING'}`, null, 1);
if (token) {
  log(LOG_ICONS.INFO, `Token preview: ${token.substring(0, 24)}...${token.substring(token.length - 8)}`, null, 2);
}

// ============================================================================
// STEP 4: ERROR HANDLERS
// ============================================================================
logHeader('STEP 4: REGISTERING ERROR HANDLERS');

process.on('unhandledRejection', (reason, promise) => {
  log(LOG_ICONS.ERROR, 'Unhandled Promise Rejection!');
  log(LOG_ICONS.ERROR, `Reason: ${reason}`, null, 1);
  if (reason && reason.stack) {
    log(LOG_ICONS.ERROR, reason.stack, null, 1);
  }
});

process.on('uncaughtException', (error) => {
  log(LOG_ICONS.ERROR, 'Uncaught Exception!');
  log(LOG_ICONS.ERROR, `Message: ${error.message}`, null, 1);
  log(LOG_ICONS.ERROR, error.stack, null, 1);
});

log(LOG_ICONS.SUCCESS, '✓ Global error handlers registered');

// ============================================================================
// STEP 5: INITIALIZE BOT SYSTEMS
// ============================================================================
logHeader('STEP 5: INITIALIZING BOT SYSTEMS');

log(LOG_ICONS.DATABASE, 'Connecting to MongoDB...');
log(LOG_ICONS.INFO, `MongoDB URI: ${process.env.MONGODB_URI?.substring(0, 30)}...`, null, 1);

try {
  const initStart = Date.now();
  await initialize();
  const initDuration = Date.now() - initStart;
  log(LOG_ICONS.SUCCESS, `✓ Bot systems initialized (${initDuration}ms)`);
} catch (error) {
  log(LOG_ICONS.ERROR, '✗ Initialization failed!');
  log(LOG_ICONS.ERROR, error.message, null, 1);
  log(LOG_ICONS.ERROR, error.stack, null, 1);
  process.exit(1);
}

// ============================================================================
// STEP 6: EXPRESS SERVER
// ============================================================================
logHeader('STEP 6: EXPRESS SERVER SETUP');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  log(LOG_ICONS.NETWORK, `Health check from ${req.ip}`);
  res.json({
    status: 'online',
    bot: client.user?.tag || 'Starting...',
    ready: client.isReady(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  log(LOG_ICONS.SUCCESS, `✓ Express server listening on port ${PORT}`);
});

// ============================================================================
// STEP 7: DISCORD EVENT HANDLERS - CRITICAL DIAGNOSTICS
// ============================================================================
logHeader('STEP 7: DISCORD EVENT SYSTEM');

log(LOG_ICONS.EVENTS, 'Registering comprehensive event listeners...');

// Track connection state
let connectionState = {
  loginSent: false,
  wsConnecting: false,
  wsConnected: false,
  authenticated: false,
  ready: false,
  guildsLoaded: false
};

// Critical WebSocket Events
log(LOG_ICONS.WEBSOCKET, 'Setting up WebSocket diagnostics...', null, 1);

client.ws.on('debug', (info) => {
  // Filter out noisy logs
  if (info.includes('Heartbeat') || info.includes('heartbeat')) return;
  
  log(LOG_ICONS.DEBUG, `WS Debug: ${info}`, null, 1);
  
  // Track important state changes
  if (info.includes('Identifying')) {
    connectionState.wsConnecting = true;
    log(LOG_ICONS.GATEWAY, '→ Sending identification to Discord Gateway...', null, 2);
  }
  if (info.includes('Ready')) {
    connectionState.authenticated = true;
    log(LOG_ICONS.GATEWAY, '→ Discord accepted authentication!', null, 2);
  }
});

// Shard Events (very important)
client.on('shardReady', (id, unavailableGuilds) => {
  log(LOG_ICONS.SUCCESS, `✓ Shard ${id} is READY!`);
  log(LOG_ICONS.INFO, `Unavailable guilds: ${unavailableGuilds ? unavailableGuilds.size : 0}`, null, 1);
  connectionState.wsConnected = true;
});

client.on('shardResume', (id, replayedEvents) => {
  log(LOG_ICONS.INFO, `Shard ${id} resumed (replayed ${replayedEvents} events)`);
});

client.on('shardDisconnect', (event, id) => {
  log(LOG_ICONS.WARNING, `Shard ${id} disconnected!`);
  log(LOG_ICONS.WARNING, `Code: ${event.code}, Reason: ${event.reason || 'Unknown'}`, null, 1);
  connectionState.wsConnected = false;
});

client.on('shardError', (error, id) => {
  log(LOG_ICONS.ERROR, `Shard ${id} ERROR!`);
  log(LOG_ICONS.ERROR, error.message, null, 1);
  if (error.stack) log(LOG_ICONS.ERROR, error.stack, null, 1);
});

client.on('shardReconnecting', (id) => {
  log(LOG_ICONS.INFO, `Shard ${id} is reconnecting...`);
});

// General Discord Events
client.on('ready', () => {
  log(LOG_ICONS.SUCCESS, `✓ 'ready' event fired! Bot: ${client.user.tag}`);
  connectionState.ready = true;
});

client.on('error', (error) => {
  log(LOG_ICONS.ERROR, 'Discord Client Error!');
  log(LOG_ICONS.ERROR, error.message, null, 1);
  if (error.stack) log(LOG_ICONS.ERROR, error.stack, null, 1);
});

client.on('warn', (warning) => {
  log(LOG_ICONS.WARNING, `Discord Warning: ${warning}`);
});

client.on('disconnect', () => {
  log(LOG_ICONS.WARNING, 'Client disconnected from Discord');
  connectionState.wsConnected = false;
  connectionState.ready = false;
});

client.on('reconnecting', () => {
  log(LOG_ICONS.INFO, 'Client attempting to reconnect...');
});

client.on('invalidated', () => {
  log(LOG_ICONS.ERROR, 'Session invalidated! Bot needs to re-authenticate');
});

client.on('rateLimit', (rateLimitData) => {
  log(LOG_ICONS.WARNING, 'Rate limit hit!', rateLimitData);
});

log(LOG_ICONS.SUCCESS, '✓ All event listeners registered');

// ============================================================================
// MAIN READY EVENT
// ============================================================================
log(LOG_ICONS.EVENTS, 'Setting up clientReady handler...', null, 1);

const activities = config.activities.map(activity => ({
  name: activity.name,
  type: ActivityType[activity.type]
}));
let activityIndex = 0;

client.once('clientReady', async () => {
  connectionState.ready = true;
  connectionState.guildsLoaded = true;
  
  log(LOG_ICONS.SUCCESS, '═══════════════════════════════════════════════════════════');
  log(LOG_ICONS.SUCCESS, '');
  log(LOG_ICONS.SUCCESS, '         ✨ BOT IS FULLY ONLINE AND READY! ✨');
  log(LOG_ICONS.SUCCESS, '');
  log(LOG_ICONS.SUCCESS, '═══════════════════════════════════════════════════════════');
  log(LOG_ICONS.DISCORD, `Logged in as: ${client.user.tag}`);
  log(LOG_ICONS.DISCORD, `Bot ID: ${client.user.id}`);
  log(LOG_ICONS.DISCORD, `Connected to ${client.guilds.cache.size} servers`);
  log(LOG_ICONS.DISCORD, `Serving ${client.users.cache.size} users`);
  log(LOG_ICONS.DISCORD, `Total channels: ${client.channels.cache.size}`);
  log(LOG_ICONS.SUCCESS, '═══════════════════════════════════════════════════════════');

  // Register commands
  const rest = new REST().setToken(token);
  try {
    log(LOG_ICONS.INFO, 'Registering slash commands...');
    const cmdStart = Date.now();
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    const cmdDuration = Date.now() - cmdStart;
    log(LOG_ICONS.SUCCESS, `✓ Registered ${commands.length} commands (${cmdDuration}ms)`);
  } catch (error) {
    log(LOG_ICONS.ERROR, '✗ Command registration failed', error.message);
  }

  // Set presence
  try {
    client.user.setPresence({
      activities: [activities[activityIndex]],
      status: 'idle',
    });
    log(LOG_ICONS.SUCCESS, `✓ Activity set: ${activities[activityIndex].name}`);
  } catch (error) {
    log(LOG_ICONS.ERROR, '✗ Failed to set presence', error.message);
  }

  // Activity rotation
  setInterval(() => {
    activityIndex = (activityIndex + 1) % activities.length;
    client.user.setPresence({
      activities: [activities[activityIndex]],
      status: 'idle',
    });
    log(LOG_ICONS.INFO, `🔄 Activity: ${activities[activityIndex].name}`);
  }, 86400000);

  // Initialize scheduled tasks
  try {
    initializeScheduledTasks(client);
    log(LOG_ICONS.SUCCESS, '✓ Scheduled tasks initialized');
  } catch (error) {
    log(LOG_ICONS.ERROR, '✗ Scheduled tasks failed', error.message);
  }
});

// ============================================================================
// OTHER EVENT HANDLERS
// ============================================================================
const IGNORED_MESSAGE_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 36, 37, 38, 39, 46];

client.on('guildCreate', async (guild) => {
  log(LOG_ICONS.DISCORD, `📥 Joined server: ${guild.name} (${guild.memberCount} members)`);
});

client.on('guildDelete', (guild) => {
  log(LOG_ICONS.DISCORD, `📤 Left server: ${guild.name}`);
});

let messageCounter = 0;
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.startsWith('!')) return;
  if (IGNORED_MESSAGE_TYPES.includes(message.type)) return;

  messageCounter++;
  if (messageCounter % 10 === 0) {
    log(LOG_ICONS.INFO, `Processed ${messageCounter} messages`);
  }

  // Your existing message processing logic here
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
      await message.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    userQueueData.queue.push(message);
    if (!userQueueData.isProcessing) {
      processUserQueue(userId);
    }
  }

  processMessageRoulette(message);
});

let interactionCounter = 0;
client.on('interactionCreate', async (interaction) => {
  interactionCounter++;
  if (interactionCounter % 5 === 0) {
    log(LOG_ICONS.INFO, `Processed ${interactionCounter} interactions`);
  }

  try {
    if (interaction.isChatInputCommand()) {
      await handleCommandInteraction(interaction);
    } else if (interaction.isButton()) {
      const newCommandButtons = ['tod_again', 'akinator_yes_', 'akinator_no_', 'akinator_maybe_', 'akinator_correct_', 'akinator_wrong_', 'akinator_again', 'tds_again', 'nhie_next', 'wyr_option1', 'wyr_option2', 'wyr_next', 'wyr_results_', 'timezone_next_page', 'timezone_prev_page', 'timezone_custom', 'reminder_action_delete'];
      const isNewCommandButton = newCommandButtons.some(prefix => interaction.customId.startsWith(prefix));
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
      const newCommandMenus = ['birthday_month', 'birthday_day_', 'birthday_name_', 'birthday_pref_', 'birthday_delete_select', 'reminder_action', 'reminder_type', 'reminder_location_', 'reminder_delete_select', 'quote_action', 'quote_category', 'quote_time_', 'quote_location_', 'quote_channel_', 'quote_remove_select', 'roulette_action', 'roulette_rarity', 'game_select', 'tod_choice', 'tds_choice', 'akinator_mode', 'timezone_region', 'timezone_select'];
      const isNewCommandMenu = newCommandMenus.some(prefix => interaction.customId.startsWith(prefix));
      if (isNewCommandMenu) {
        await handleNewSelectMenus(interaction);
      } else {
        await handleSelectMenuInteraction(interaction);
      }
    }
  } catch (error) {
    log(LOG_ICONS.ERROR, 'Interaction error', { type: interaction.type, error: error.message });
  }
});

const handleCommandInteraction = async (interaction) => {
  const commandHandlers = {
    settings: async (i) => {
      const { showMainSettings } = modules['settingsHandler'];
      await showMainSettings(i, false);
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
  }
};

// ============================================================================
// STEP 8: DISCORD LOGIN WITH COMPREHENSIVE DIAGNOSTICS
// ============================================================================
logHeader('STEP 8: DISCORD LOGIN SEQUENCE');

log(LOG_ICONS.DISCORD, 'Initiating Discord Gateway connection...');
log(LOG_ICONS.INFO, `Token length: ${token.length} characters`, null, 1);
log(LOG_ICONS.INFO, `Token format: ${token.split('.').length} parts (should be 3)`, null, 1);

// Connection timeout tracker
const timeoutDuration = 45000; // 45 seconds
let timeoutHandle;
let progressInterval;

const loginStart = Date.now();
connectionState.loginSent = true;

log(LOG_ICONS.PROGRESS, 'Starting connection timer...', null, 1);

// Progress indicator
let progressDots = 0;
progressInterval = setInterval(() => {
  progressDots = (progressDots + 1) % 4;
  const dots = '.'.repeat(progressDots) + ' '.repeat(3 - progressDots);
  const elapsed = ((Date.now() - loginStart) / 1000).toFixed(1);
  log(LOG_ICONS.TICK, `Waiting for connection${dots} (${elapsed}s elapsed)`, null, 1);
  
  log(LOG_ICONS.DEBUG, 'Connection State:', null, 2);
  log(LOG_ICONS.DEBUG, `  - Login sent: ${connectionState.loginSent}`, null, 2);
  log(LOG_ICONS.DEBUG, `  - WS connecting: ${connectionState.wsConnecting}`, null, 2);
  log(LOG_ICONS.DEBUG, `  - WS connected: ${connectionState.wsConnected}`, null, 2);
  log(LOG_ICONS.DEBUG, `  - Authenticated: ${connectionState.authenticated}`, null, 2);
  log(LOG_ICONS.DEBUG, `  - Ready: ${connectionState.ready}`, null, 2);
}, 5000);

// Timeout handler
timeoutHandle = setTimeout(() => {
  clearInterval(progressInterval);
  
  if (!client.isReady()) {
    const elapsed = ((Date.now() - loginStart) / 1000).toFixed(1);
    log(LOG_ICONS.ERROR, '═══════════════════════════════════════════════════════════');
    log(LOG_ICONS.ERROR, '');
    log(LOG_ICONS.CRITICAL, `⏰ CONNECTION TIMEOUT (${elapsed}s elapsed)`);
    log(LOG_ICONS.ERROR, '');
    log(LOG_ICONS.ERROR, '═══════════════════════════════════════════════════════════');
    
    log(LOG_ICONS.INFO, 'Final Connection State:', null, 1);
    log(LOG_ICONS.INFO, JSON.stringify(connectionState, null, 2), null, 1);
    
    log(LOG_ICONS.ERROR, '');
    log(LOG_ICONS.ERROR, '📋 TROUBLESHOOTING CHECKLIST:', null, 1);
    log(LOG_ICONS.ERROR, '');
    
    if (!connectionState.wsConnecting) {
      log(LOG_ICONS.ERROR, '1. ❌ WebSocket never initiated connection', null, 1);
      log(LOG_ICONS.ERROR, '   → Check if Discord Gateway is accessible', null, 2);
      log(LOG_ICONS.ERROR, '   → Verify network/firewall allows WSS connections', null, 2);
      log(LOG_ICONS.ERROR, '   → Check https://discordstatus.com', null, 2);
    }
    
    if (connectionState.wsConnecting && !connectionState.authenticated) {
      log(LOG_ICONS.ERROR, '2. ❌ Authentication failed', null, 1);
      log(LOG_ICONS.ERROR, '   → Token might be invalid or revoked', null, 2);
      log(LOG_ICONS.ERROR, '   → Check Discord Developer Portal', null, 2);
      log(LOG_ICONS.ERROR, '   → Verify bot token hasn\'t been regenerated', null, 2);
    }
    
    if (connectionState.authenticated && !connectionState.ready) {
      log(LOG_ICONS.ERROR, '3. ❌ Missing Privileged Gateway Intents', null, 1);
      log(LOG_ICONS.ERROR, '   → Go to: https://discord.com/developers/applications', null, 2);
      log(LOG_ICONS.ERROR, '   → Select your bot → Bot section', null, 2);
      log(LOG_ICONS.ERROR, '   → Enable "Message Content Intent" ⚠️ REQUIRED', null, 2);
      log(LOG_ICONS.ERROR, '   → Enable "Server Members Intent" (recommended)', null, 2);
      log(LOG_ICONS.ERROR, '   → Save changes and restart bot', null, 2);
    }
    
    log(LOG_ICONS.ERROR, '');
    log(LOG_ICONS.ERROR, '4. Other checks:', null, 1);
    log(LOG_ICONS.ERROR, '   → Bot might be rate-limited', null, 2);
    log(LOG_ICONS.ERROR, '   → Check if hosting provider blocks Discord', null, 2);
    log(LOG_ICONS.ERROR, '   → Verify bot hasn\'t been disabled in Developer Portal', null, 2);
    log(LOG_ICONS.ERROR, '');
    log(LOG_ICONS.ERROR, '═══════════════════════════════════════════════════════════');
  }
}, timeoutDuration);

// Perform login
log(LOG_ICONS.GATEWAY, 'Sending login request to Discord...', null, 1);

client.login(token)
  .then(() => {
    const loginDuration = Date.now() - loginStart;
    log(LOG_ICONS.SUCCESS, `✓ Login request accepted (${loginDuration}ms)`);
    log(LOG_ICONS.INFO, 'Establishing WebSocket connection to Gateway...', null, 1);
    log(LOG_ICONS.INFO, 'This may take 3-10 seconds...', null, 1);
  })
  .catch(error => {
    clearTimeout(timeoutHandle);
    clearInterval(progressInterval);
    
    const loginDuration = Date.now() - loginStart;
    log(LOG_ICONS.ERROR, '═══════════════════════════════════════════════════════════');
    log(LOG_ICONS.CRITICAL, `LOGIN FAILED (${loginDuration}ms)`);
    log(LOG_ICONS.ERROR, '═══════════════════════════════════════════════════════════');
    log(LOG_ICONS.ERROR, `Error Code: ${error.code || 'Unknown'}`);
    log(LOG_ICONS.ERROR, `Message: ${error.message}`);
    
    if (error.code === 'TOKEN_INVALID' || error.message.includes('token')) {
      log(LOG_ICONS.ERROR, '');
      log(LOG_ICONS.ERROR, '🔑 TOKEN ISSUE DETECTED', null, 1);
      log(LOG_ICONS.ERROR, '');
      log(LOG_ICONS.ERROR, 'Your Discord bot token is invalid or revoked.', null, 1);
      log(LOG_ICONS.ERROR, 'Steps to fix:', null, 1);
      log(LOG_ICONS.ERROR, '1. Go to https://discord.com/developers/applications', null, 2);
      log(LOG_ICONS.ERROR, '2. Select your application', null, 2);
      log(LOG_ICONS.ERROR, '3. Go to Bot section', null, 2);
      log(LOG_ICONS.ERROR, '4. Click "Reset Token"', null, 2);
      log(LOG_ICONS.ERROR, '5. Update DISCORD_BOT_TOKEN in your environment', null, 2);
    }
    
    if (error.code === 'DISALLOWED_INTENTS') {
      log(LOG_ICONS.ERROR, '');
      log(LOG_ICONS.ERROR, '🎯 INTENT ISSUE DETECTED', null, 1);
      log(LOG_ICONS.ERROR, '');
      log(LOG_ICONS.ERROR, 'Required privileged intents are not enabled.', null, 1);
      log(LOG_ICONS.ERROR, 'Steps to fix:', null, 1);
      log(LOG_ICONS.ERROR, '1. Go to https://discord.com/developers/applications', null, 2);
      log(LOG_ICONS.ERROR, '2. Select your bot → Bot section', null, 2);
      log(LOG_ICONS.ERROR, '3. Enable "Message Content Intent" ⚠️', null, 2);
      log(LOG_ICONS.ERROR, '4. Save changes', null, 2);
    }
    
    if (error.stack) {
      log(LOG_ICONS.DEBUG, 'Stack trace:', null, 1);
      log(LOG_ICONS.DEBUG, error.stack, null, 1);
    }
    
    log(LOG_ICONS.ERROR, '═══════════════════════════════════════════════════════════');
    process.exit(1);
  });

// Clear timeout on successful ready
client.once('clientReady', () => {
  clearTimeout(timeoutHandle);
  clearInterval(progressInterval);
  const totalDuration = ((Date.now() - loginStart) / 1000).toFixed(2);
  log(LOG_ICONS.SUCCESS, `✓ Total connection time: ${totalDuration}s`);
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
const shutdown = async (signal) => {
  log(LOG_ICONS.INFO, '');
  log(LOG_ICONS.INFO, '═══════════════════════════════════════════════════════════');
  log(LOG_ICONS.INFO, `Shutdown signal received: ${signal}`);
  log(LOG_ICONS.INFO, '═══════════════════════════════════════════════════════════');
  
  try {
    await saveStateToFile();
    log(LOG_ICONS.SUCCESS, '✓ State saved');
    
    client.destroy();
    log(LOG_ICONS.SUCCESS, '✓ Discord client destroyed');
    
    log(LOG_ICONS.SUCCESS, 'Goodbye! 👋');
    process.exit(0);
  } catch (error) {
    log(LOG_ICONS.ERROR, 'Shutdown error', error.message);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============================================================================
// FINAL STATUS
// ============================================================================
log(LOG_ICONS.SUCCESS, '');
log(LOG_ICONS.SUCCESS, '═══════════════════════════════════════════════════════════');
log(LOG_ICONS.SUCCESS, '✨ DIAGNOSTIC SYSTEM READY');
log(LOG_ICONS.SUCCESS, 'All monitoring systems active');
log(LOG_ICONS.SUCCESS, 'Awaiting Discord Gateway connection...');
log(LOG_ICONS.SUCCESS, '═══════════════════════════════════════════════════════════');
log(LOG_ICONS.SUCCESS, '');