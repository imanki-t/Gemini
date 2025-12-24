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

initialize().catch(console.error);

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
          console.log(`🧹 Cleaned: ${file}`);
        }
      } catch (err) {
        continue;
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
};

setInterval(cleanupTempFiles, HOUR_IN_MS);

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
      console.log(`🧹 Startup: Cleaned ${cleaned} old temp files`);
    }
  } catch (error) {}
})();

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

client.login(token);
