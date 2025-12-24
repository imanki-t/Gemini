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

const IGNORED_MESSAGE_TYPES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 20, 21, 22, 23, 24, 25, 
  26, 27, 28, 29, 30, 31, 36, 37, 38, 39, 46
];

// Initialize Database and State
initialize().catch(console.error);

// Clean up temp files periodically
async function cleanupTempFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > HOUR_IN_MS) {
          await fs.unlink(filePath);
          console.log(`清 Cleaned: ${file}`);
        }
      } catch (err) {
        continue;
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

setInterval(cleanupTempFiles, HOUR_IN_MS);

// Initial cleanup on startup
(async () => {
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
      } catch (err) {}
    }
    
    if (cleaned > 0) {
      console.log(`清 Startup: Cleaned ${cleaned} old temp files`);
    }
  } catch (error) {}
})();

// Express Server for Uptime Monitoring
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user?.tag || 'Starting...',
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});

// Bot Activities
const activities = config.activities.map(activity => ({
  name: activity.name,
  type: ActivityType[activity.type]
}));

let activityIndex = 0;

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rest = new REST().setToken(token);
  
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
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
    console.log(`🔄 Activity changed to: ${activities[activityIndex].name}`);
  }, DAY_IN_MS);

  initializeScheduledTasks(client);
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
    console.error('Error sending welcome message:', error);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.content.startsWith('!')) return;
    if (IGNORED_MESSAGE_TYPES.includes(message.type)) {
      console.log(`🔕 Ignored system message type: ${message.type}`);
      return;
    }

    const isDM = message.channel.type === ChannelType.DM;
    const guildId = message.guild?.id;
    const channelId = message.channelId;
    const userId = message.author.id;

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
    console.error('Error processing the message:', error);
  }
});

// Fixed Interaction Handler - Replaces Fragile Array Checks with Sequential Logic
client.on('interactionCreate', async (interaction) => {
  try {
    // 1. Handle Slash Commands
    if (interaction.isChatInputCommand()) {
      await handleCommandInteraction(interaction);
    } 
    // 2. Handle Buttons
    else if (interaction.isButton()) {
      // Try the new command modules first
      await handleNewButtons(interaction);
      
      // If not handled (not replied/deferred), try the settings handler
      if (!interaction.replied && !interaction.deferred) {
        await handleButtonInteraction(interaction);
      }
    } 
    // 3. Handle Modal Submits
    else if (interaction.isModalSubmit()) {
      // Try specific modal handlers first (reminders, timezone)
      await handleNewModals(interaction);
      
      // Fallback to settings/generic modals
      if (!interaction.replied && !interaction.deferred) {
        await handleModalSubmit(interaction);
      }
    } 
    // 4. Handle Select Menus
    else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
      // Try command menus first
      await handleNewSelectMenus(interaction);
      
      // Fallback to settings menus
      if (!interaction.replied && !interaction.deferred) {
        await handleSelectMenuInteraction(interaction);
      }
    }
  } catch (error) {
    console.error('CRITICAL: Error handling interaction:', error);
    
    // Safety Net: Attempt to inform user if interaction crashed silently
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ An unexpected error occurred while processing this request.',
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (e) {
      // Ignore if reply fails (e.g. unknown interaction)
    }
  }
});

async function handleCommandInteraction(interaction) {
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
    try {
      await handler(interaction);
    } catch (err) {
      console.error(`Error in command ${interaction.commandName}:`, err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Command failed to execute.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  } else {
    console.log(`Unknown command: ${interaction.commandName}`);
  }
}

client.login(token);
