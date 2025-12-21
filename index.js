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

initialize().catch(console.error);

setInterval(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > ONE_HOUR) {
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
}, 60 * 60 * 1000);

(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    let cleaned = 0;
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > 60 * 60 * 1000) {
          await fs.unlink(filePath);
          cleaned++;
        }
      } catch (err) {}
    }
    if (cleaned > 0) console.log(`🧹 Startup: Cleaned ${cleaned} old temp files`);
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

    await rest.put(
      Routes.applicationCommands(client.user.id), {
        body: commands
      },
    );

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
  }, 30000);

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
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Ignore command messages
    if (message.content.startsWith('!')) return;
    
    // ✨ FIXED: Comprehensive system message filtering
    // Discord has many system message types that should be ignored
    // Message type 0 = DEFAULT (normal messages)
    // Message type 19 = REPLY (normal replies, should NOT be ignored)
    const ignoredSystemTypes = [
      1,  // RECIPIENT_ADD
      2,  // RECIPIENT_REMOVE
      3,  // CALL
      4,  // CHANNEL_NAME_CHANGE
      5,  // CHANNEL_ICON_CHANGE
      6,  // CHANNEL_PINNED_MESSAGE
      7,  // USER_JOIN (formerly GUILD_MEMBER_JOIN)
      8,  // USER_PREMIUM_GUILD_SUBSCRIPTION (boosts)
      9,  // USER_PREMIUM_GUILD_SUBSCRIPTION_TIER_1
      10, // USER_PREMIUM_GUILD_SUBSCRIPTION_TIER_2
      11, // USER_PREMIUM_GUILD_SUBSCRIPTION_TIER_3
      12, // CHANNEL_FOLLOW_ADD
      14, // GUILD_DISCOVERY_DISQUALIFIED
      15, // GUILD_DISCOVERY_REQUALIFIED
      18, // THREAD_CREATED
      20, // CHAT_INPUT_COMMAND
      21, // THREAD_STARTER_MESSAGE
      22, // GUILD_INVITE_REMINDER
      23, // CONTEXT_MENU_COMMAND
      24, // AUTO_MODERATION_ACTION
      25, // ROLE_SUBSCRIPTION_PURCHASE
      26, // INTERACTION_PREMIUM_UPSELL
      27, // STAGE_START
      28, // STAGE_END
      29, // STAGE_SPEAKER
      30, // STAGE_TOPIC
      31, // GUILD_APPLICATION_PREMIUM_SUBSCRIPTION
      36, // GUILD_INCIDENT_ALERT_MODE_ENABLED
      37, // GUILD_INCIDENT_ALERT_MODE_DISABLED
      38, // GUILD_INCIDENT_REPORT_RAID
      39, // GUILD_INCIDENT_REPORT_FALSE_ALARM
      46  // POLL_RESULT
    ];
    
    // Ignore system messages (but allow normal messages type 0 and replies type 19)
    if (ignoredSystemTypes.includes(message.type)) {
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
  // DM: respond if DMs enabled and (continuous OR mentioned)
  (isDM && config.workInDMs && (continuousReply || message.mentions.users.has(client.user.id))) ||
  
  // Guild + Mentioned: ALWAYS respond when bot is mentioned
  (guildId && message.mentions.users.has(client.user.id)) ||
  
  // Guild + Not Mentioned: respond only if continuous reply enabled
  (guildId && !message.mentions.users.has(client.user.id) && (channelContinuousReply || continuousReply)) ||
  
  // Special channel: always respond
  state.alwaysRespondChannels[channelId] ||
  
  // Active conversation: respond to users in conversation
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
    await handler(interaction);
  } else {
    console.log(`Unknown command: ${interaction.commandName}`);
  }
}

client.login(token);
