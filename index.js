import {
MessageFlags,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
ChannelType,
TextInputBuilder,
TextInputStyle,
ModalBuilder,
PermissionsBitField,
EmbedBuilder,
AttachmentBuilder,
ActivityType,
ComponentType,
REST,
Routes,
StringSelectMenuBuilder,
StringSelectMenuOptionBuilder,
ChannelSelectMenuBuilder,
} from 'discord.js';
import {
HarmBlockThreshold,
HarmCategory
} from '@google/genai';
import fs from 'fs/promises';
import {
createWriteStream
} from 'fs';
import path from 'path';
import {
getTextExtractor
} from 'office-text-extractor';
import osu from 'node-os-utils';
const {
mem,
cpu
} = osu;
import axios from 'axios';
import express from 'express';
import ffmpeg from 'fluent-ffmpeg';

import config from './config.js';

import {
  client,
  genAI,
  createPartFromUri,
  token,
  requestQueues, 
  chatHistoryLock,
  state,
  TEMP_DIR,
  initialize,
  saveStateToFile,
  getHistory,
  updateChatHistory,
  getUserResponsePreference,
  initializeBlacklistForGuild,
  checkImageRateLimit,  
  incrementImageUsage   
} from './botManager.js';

import { memorySystem } from './memorySystem.js';

initialize().catch(console.error);

// Periodic temp file cleanup
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

// Run once on startup
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

const MODELS = {
'gemini-2.0-flash': 'gemini-2.0-flash-exp',
'gemini-2.5-flash': 'gemini-2.5-flash',
'gemini-2.5-pro': 'gemini-2.5-pro',
'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
'gemini-2.0-flash-lite': 'gemini-2.0-flash-lite'
};

const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
    threshold: HarmBlockThreshold.BLOCK_NONE,  // ✅ Fixed - no line break
  },
];

const generationConfig = {
temperature: 1.0,
topP: 0.95,
thinkingConfig: {
  thinkingBudget: -1
}
};

const defaultResponseFormat = config.defaultResponseFormat;
const hexColour = config.hexColour;
const activities = config.activities.map(activity => ({
name: activity.name,
type: ActivityType[activity.type]
}));

// ========== ADD THIS ENTIRE SECTION ==========
// Poll rate limiting system
const pollRateLimits = {
  polls: new Map(), // channelId -> { count, resetTime }
  results: new Map(), // channelId -> { count, resetTime }
  maxPollsPerMinute: 3,
  maxResultsPerMinute: 5,
  processedPolls: new Set(), // Store processed poll message IDs to avoid duplicates
  processedResults: new Set() // Store processed result message IDs
};

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  
  // Clean poll rate limits
  for (const [channelId, data] of pollRateLimits.polls.entries()) {
    if (now > data.resetTime) {
      pollRateLimits.polls.delete(channelId);
    }
  }
  
  // Clean result rate limits
  for (const [channelId, data] of pollRateLimits.results.entries()) {
    if (now > data.resetTime) {
      pollRateLimits.results.delete(channelId);
    }
  }
  
  // Clean old processed IDs (keep last 1000)
  if (pollRateLimits.processedPolls.size > 1000) {
    const arr = Array.from(pollRateLimits.processedPolls);
    pollRateLimits.processedPolls = new Set(arr.slice(-1000));
  }
  if (pollRateLimits.processedResults.size > 1000) {
    const arr = Array.from(pollRateLimits.processedResults);
    pollRateLimits.processedResults = new Set(arr.slice(-1000));
  }
}, 300000);

/**
 * Check if a poll can be processed in this channel
 */
function canProcessPoll(channelId) {
  const now = Date.now();
  const limit = pollRateLimits.polls.get(channelId);
  
  if (!limit || now > limit.resetTime) {
    pollRateLimits.polls.set(channelId, {
      count: 1,
      resetTime: now + 60000 // 1 minute
    });
    return true;
  }
  
  if (limit.count >= pollRateLimits.maxPollsPerMinute) {
    return false;
  }
  
  limit.count++;
  return true;
}

/**
 * Check if poll results can be processed in this channel
 */
function canProcessPollResults(channelId) {
  const now = Date.now();
  const limit = pollRateLimits.results.get(channelId);
  
  if (!limit || now > limit.resetTime) {
    pollRateLimits.results.set(channelId, {
      count: 1,
      resetTime: now + 60000 // 1 minute
    });
    return true;
  }
  
  if (limit.count >= pollRateLimits.maxResultsPerMinute) {
    return false;
  }
  
  limit.count++;
  return true;
}

/**
 * Extract poll data from a message
 */
function extractPollData(message) {
  if (!message.poll) return null;
  
  const poll = message.poll;
  const question = poll.question.text;
  const answers = poll.answers.map(answer => ({
    id: answer.answerId,
    text: answer.text,
    voteCount: answer.voteCount || 0
  }));
  
  const totalVotes = answers.reduce((sum, answer) => sum + answer.voteCount, 0);
  const isExpired = poll.expiresAt ? new Date(poll.expiresAt) < new Date() : false;
  const allowMultiselect = poll.allowMultiselect || false;
  
  return {
    question,
    answers,
    totalVotes,
    isExpired,
    allowMultiselect,
    expiresAt: poll.expiresAt,
    layoutType: poll.layoutType
  };
}

/**
 * Format poll data into readable text for AI
 */
function formatPollForAI(pollData, messageId, isResults = false) {
  const header = isResults ? 
    `[Poll Results - Final]` : 
    `[Active Poll${pollData.isExpired ? ' (Expired)' : ''}]`;
  
  let text = `${header}\n`;
  text += `Question: ${pollData.question}\n`;
  text += `Total Votes: ${pollData.totalVotes}\n`;
  text += `Multiselect: ${pollData.allowMultiselect ? 'Yes' : 'No'}\n`;
  
  if (pollData.expiresAt) {
    text += `Expires: ${new Date(pollData.expiresAt).toLocaleString()}\n`;
  }
  
  text += `\nAnswers:\n`;
  pollData.answers.forEach((answer, index) => {
    const percentage = pollData.totalVotes > 0 
      ? ((answer.voteCount / pollData.totalVotes) * 100).toFixed(1)
      : '0.0';
    text += `${index + 1}. ${answer.text}: ${answer.voteCount} votes (${percentage}%)\n`;
  });
  
  if (isResults) {
    text += `\n[This poll has ended and these are the final results]`;
  }
  
  return text;
}



const defaultPersonality = config.defaultPersonality;
const workInDMs = config.workInDMs;

import {
delay,
retryOperation,
} from './tools/others.js';

import {
commands
} from './commands.js';

/**
 * Extracts custom emojis from message content
 * Returns array of {id, name, animated} objects
 */
function extractCustomEmojis(content) {
  const emojiRegex = /<a?:(\w+):(\d+)>/g;
  const emojis = [];
  let match;
  
  while ((match = emojiRegex.exec(content)) !== null) {
    const animated = match[0].startsWith('<a:');
    emojis.push({
      name: match[1],
      id: match[2],
      animated: animated,
      fullMatch: match[0]
    });
  }
  
  return emojis;
}

/**
 * Converts stickers to attachments
 */
async function processStickerAsAttachment(sticker) {
  try {
    // sticker.format: 1 = PNG, 2 = APNG, 3 = LOTTIE, 4 = GIF
    const isAnimated = sticker.format === 2 || sticker.format === 3 || sticker.format === 4;
    let contentType = 'image/png'; // Default for format 1
    let fileExtension = '.png';
    let url = sticker.url; // Use the URL directly from discord.js

    if (sticker.format === 2) { // APNG
      contentType = 'image/png';
      fileExtension = '.png';
    } else if (sticker.format === 3) { // LOTTIE
      contentType = 'application/json';
      fileExtension = '.json';
    } else if (sticker.format === 4) { // GIF
      contentType = 'image/gif';
      fileExtension = '.gif';
      // Per Discord docs, GIF stickers must use the media.discordapp.net endpoint
      url = `https://media.discordapp.net/stickers/${sticker.id}.gif`;
    }
    
    // Ensure the file name has the correct extension
    const name = sticker.name.endsWith(fileExtension) ? sticker.name : `${sticker.name}${fileExtension}`;

    return {
      name: name,
      url: url,
      contentType: contentType,
      isAnimated: isAnimated,
      isSticker: true
    };
  } catch (error) {
    console.error('Error processing sticker:', error);
    return null;
  }
}



/**
 * Converts custom emoji to attachment
 */
async function processEmojiAsAttachment(emoji) {
  try {
    const extension = emoji.animated ? 'gif' : 'png';
    const url = `https://cdn.discordapp.com/emojis/${emoji.id}.${extension}`;
    
    return {
      name: `${emoji.name}.${extension}`,
      url: url,
      contentType: emoji.animated ? 'image/gif' : 'image/png',
      isAnimated: emoji.animated,
      isEmoji: true,
      emojiName: emoji.name
    };
  } catch (error) {
    console.error('Error processing emoji:', error);
    return null;
  }
}

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
});

// Add this NEW event handler for when bot joins a server
client.on('guildCreate', async (guild) => {
  try {
    // Find the first available text channel where the bot can send messages
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
  // Changed || false to ?? true to match config.js default and fix boolean logic
  const continuousReply = effectiveSettings.continuousReply ?? true;
  
  const channelContinuousReply = state.continuousReplyChannels?.[channelId] || false;

  const shouldRespond = (
  // In DMs: only respond if continuous reply is enabled OR bot is mentioned
  (isDM && workInDMs && (continuousReply || message.mentions.users.has(client.user.id))) ||
  // In servers: existing logic for server-level continuous reply
  (guildId && (channelContinuousReply || continuousReply) && !message.mentions.users.has(client.user.id)) ||
  // Channel-specific always respond setting
  state.alwaysRespondChannels[channelId] ||
  // Mentioned in server (and not already handled above)
  (message.mentions.users.has(client.user.id) && !isDM) ||
  // Active conversation mode
  state.activeUsersInChannels[channelId]?.[userId]
);

    if (shouldRespond) {
    // Initialize queue for user if it doesn't exist
    if (!state.requestQueues.has(userId)) {
      state.requestQueues.set(userId, { queue: [], isProcessing: false });
    }

    const userQueueData = state.requestQueues.get(userId);

    // Check Limit (Max 3 messages in queue)
    if (userQueueData.queue.length >= 5) {
      const embed = new EmbedBuilder()
        .setColor(0xFFAA00)
        .setTitle('⏳ Queue Full')
        .setDescription('You have 5 requests pending. Please wait for them to finish.');
      
      // Reply to the specific message trying to be added
      await message.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return; 
    }

    // Add to queue
    userQueueData.queue.push(message);

    // If not currently processing, start the loop
    if (!userQueueData.isProcessing) {
      processUserQueue(userId);
    }
  }
} catch (error) {
  console.error('Error processing the message:', error);
  // Cleanup on error is handled in processUserQueue now
}
});

client.on('interactionCreate', async (interaction) => {
try {
  if (interaction.isChatInputCommand()) {
    await handleCommandInteraction(interaction);
  } else if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
  } else if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction);
  } else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
    await handleSelectMenuInteraction(interaction);
  }
} catch (error) {
  console.error('Error handling interaction:', error.message);
}
});


async function handleCommandInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const commandHandlers = {
    settings: showMainSettings,
    search: handleSearchCommand,
    imagine: handleImagineCommand // Connects the /imagine command
  };

  const handler = commandHandlers[interaction.commandName];
  if (handler) {
    await handler(interaction);
  } else {
    console.log(`Unknown command: ${interaction.commandName}`);
  }
}

async function handleSearchCommand(interaction) {
  try {
    // 1. Validate Input
    const prompt = interaction.options.getString('prompt');
    const attachment = interaction.options.getAttachment('file');

    if (!prompt && !attachment) {
      return interaction.reply({
        content: '❌ Please provide a prompt or an attachment.',
        flags: MessageFlags.Ephemeral
      });
    }

    // 2. Defer immediately so the bot doesn't say "Interaction Failed" while waiting
    await interaction.deferReply();

    const userId = interaction.user.id;

    // 3. Initialize Queue if needed
    if (!state.requestQueues.has(userId)) {
      state.requestQueues.set(userId, { queue: [], isProcessing: false });
    }

    const userQueueData = state.requestQueues.get(userId);

    // 4. Check Queue Size (Optional Limit)
    if (userQueueData.queue.length >= 5) {
      return interaction.editReply({
        content: '⏳ **Queue Full:** You have too many requests processing. Please wait.'
      });
    }

    // 5. Add to Queue
    userQueueData.queue.push(interaction);

    // 6. Start Processor if idle
    if (!userQueueData.isProcessing) {
      processUserQueue(userId);
    }

  } catch (error) {
    console.error('Error queuing search:', error);
  }
        }


async function executeSearchInteraction(interaction) {
try {
  

  const prompt = interaction.options.getString('prompt') || '';
  const attachment = interaction.options.getAttachment('file');

  if (!prompt && !attachment) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Invalid Input')
      .setDescription('Please provide either a text prompt or a file attachment.');
    return interaction.editReply({
      embeds: [embed]
    });
  }

  const userId = interaction.user.id;
  const guildId = interaction.guild?.id;
  const channelId = interaction.channelId;

  if (guildId) {
    initializeBlacklistForGuild(guildId);
    if (state.blacklistedUsers[guildId]?.includes(userId)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚫 Blacklisted')
        .setDescription('You are blacklisted and cannot use this command.');
      return interaction.editReply({
        embeds: [embed]
      });
    }

    const allowedChannels = state.serverSettings[guildId]?.allowedChannels;
    if (allowedChannels && allowedChannels.length > 0 && !allowedChannels.includes(channelId)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Channel Restricted')
        .setDescription('This bot can only be used in specific channels set by server admins.');
      return interaction.editReply({
        embeds: [embed]
      });
    }
  }

    let parts = [];
  let hasMedia = false;
  if (prompt) {
    // Force web search execution
    const forcedSearchPrompt = `IMPERATIVE: You must use the 'googleSearch' tool to find the most current information for this request. Do not answer from internal memory. Query: ${prompt}`;
    parts.push({
      text: forcedSearchPrompt
    });
          }
  

  if (attachment) {
  try {
    const processedPart = await processAttachment(attachment, interaction.user.id, interaction.id);
    if (processedPart) {
      if (Array.isArray(processedPart)) {
        parts.push(...processedPart);
        if (processedPart.some(part => part.text === undefined || part.fileUri || part.fileData)) {
          hasMedia = true;
        }
      } else {
        parts.push(processedPart);
        if (processedPart.text === undefined) {
          hasMedia = true;
        }
      }
    }
    } catch (error) {
      console.error(`Error processing attachment:`, error);
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Processing Error')
        .setDescription(`Failed to process the attachment: ${error.message}`);
      return interaction.editReply({
        embeds: [embed]
      });
    }
  }

  const userSettings = state.userSettings[userId] || {};
  const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
  const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;

  const selectedModel = effectiveSettings.selectedModel || 'gemini-2.5-flash';
const modelName = MODELS[selectedModel];

// ✅ FIXED: Use core rules + custom personality
let finalInstructions = config.coreSystemRules;

const customPersonality = effectiveSettings.customPersonality || state.customInstructions[userId];
if (customPersonality) {
  finalInstructions += `\n\nADDITIONAL PERSONALITY:\n${customPersonality}`;
} else {
  finalInstructions += `\n\n${config.defaultPersonality}`;
}

// Add server/user context
let infoStr = '';
if (guildId) {
  const userInfo = {
    username: interaction.user.username,
    displayName: interaction.user.displayName
  };
  infoStr = `\nYou are currently engaging with users in the ${interaction.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
}

finalInstructions += infoStr;

const isServerChatHistoryEnabled = guildId ? state.serverSettings[guildId]?.serverChatHistory : false;
const isChannelChatHistoryEnabled = guildId ? state.channelWideChatHistory[channelId] : false;
  const historyId = isServerChatHistoryEnabled ? guildId : (isChannelChatHistoryEnabled ? channelId : userId);

  // FIXED: Always include search tools - let the AI decide when to use them
  const tools = [
    { googleSearch: {} },
    { urlContext: {} }
  ];

  if (!hasMedia) {
    tools.push({ codeExecution: {} });
  }

  // In handleSearchCommand, replace:
const chat = genAI.chats.create({
  model: modelName,
  config: {
    systemInstruction: finalInstructions,
    ...generationConfig,
    safetySettings,
    tools
  },
  history: await memorySystem.getOptimizedHistory(
    historyId, 
    prompt || 'search query', 
    modelName
  )
});
  

    // Fetch the deferred reply object to use for updates
  let botMessage = await interaction.fetchReply();

  const responseFormat = effectiveSettings.responseFormat || 'Normal';
  
  const maxCharacterLimit = responseFormat === 'Embedded' ? 3900 : 1900;
  let attempts = 3;

  let updateTimeout;
  let tempResponse = '';
  let groundingMetadata = null;
  let urlContextMetadata = null;
  let stopGeneration = false;

  const updateSearchMessage = () => {
    if (stopGeneration) return;
    try {
      if (tempResponse.trim() === "") {} else if (responseFormat === 'Embedded') {
        updateEmbedForInteraction(interaction, botMessage, tempResponse, groundingMetadata, urlContextMetadata, effectiveSettings);
      } else {
        interaction.editReply({
          content: tempResponse,
          embeds: []
        }).catch(() => {});
      }
    } catch (e) {
      console.error("Error updating search reply:", e);
    }

    clearTimeout(updateTimeout);
    updateTimeout = null;
  };

  while (attempts > 0 && !stopGeneration) {
    try {
      let finalResponse = '';
      let isLargeResponse = false;
      const newHistory = [];
      newHistory.push({
        role: 'user',
        content: parts
      });

      const messageResult = await chat.sendMessageStream({
        message: parts
      });

      for await (const chunk of messageResult) {
        const chunkText = (chunk.text || (chunk.codeExecutionResult?.output ? `\n\`\`\`py\n${chunk.codeExecutionResult.output}\n\`\`\`\n` : "") || (chunk.executableCode ? `\n\`\`\`\n${chunk.executableCode}\n\`\`\`\n` : ""));
        if (chunkText && chunkText !== '') {
          finalResponse += chunkText;
          tempResponse += chunkText;
        }

        if (chunk.candidates && chunk.candidates[0]?.groundingMetadata) {
          groundingMetadata = chunk.candidates[0].groundingMetadata;
        }
        if (chunk.candidates && chunk.candidates[0]?.url_context_metadata) {
          urlContextMetadata = chunk.candidates[0].url_context_metadata;
        }

        if (finalResponse.length > maxCharacterLimit) {
          if (!isLargeResponse) {
            isLargeResponse = true;
            const embed = new EmbedBuilder().setColor(0xFFAA00).setTitle('📄 Large Response').setDescription('The response is too large. It will be sent as a text file once completed.');
            await interaction.editReply({
              content: ' ',
              embeds: [embed],
              components: []
            });
          }
        } else if (!updateTimeout) {
          updateTimeout = setTimeout(updateSearchMessage, 500);
        }
      }

      clearTimeout(updateTimeout);

      newHistory.push({
        role: 'assistant',
        content: [{
          text: finalResponse
        }]
      });

            botMessage = await interaction.fetchReply();

      await chatHistoryLock.runExclusive(async () => {
        const username = interaction.user.username;
        const displayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
        updateChatHistory(historyId, newHistory, interaction.user.id, username, displayName);
        await saveStateToFile();
      });
      

      if (!isLargeResponse) {
        if (responseFormat === 'Embedded') {
          updateEmbedForInteraction(interaction, botMessage, finalResponse, groundingMetadata, urlContextMetadata, effectiveSettings);
        } else {
          await interaction.editReply({
            content: finalResponse.slice(0, 2000),
            embeds: []
          });
        }
      } else {
        await sendAsTextFile(finalResponse, interaction, botMessage.id, false);
      }

      botMessage = await interaction.fetchReply();
      const showActionButtons = effectiveSettings.showActionButtons === true;
      
      if (showActionButtons && !isLargeResponse) {
        const components = [];
        const actionRow = new ActionRowBuilder();
        actionRow.addComponents(new ButtonBuilder().setCustomId('download_message').setLabel('Save').setEmoji('💾').setStyle(ButtonStyle.Secondary));
        actionRow.addComponents(new ButtonBuilder().setCustomId(`delete_message-${botMessage.id}`).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger));
        components.push(actionRow);
        await interaction.editReply({
          components
        });
      } else if (!isLargeResponse) {
        await interaction.editReply({
          components: []
        });
      }

      break;

    } catch (error) {
      console.error('Error generating response:', error);
      attempts--;
      if (attempts === 0) {
        const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Generation Error').setDescription(`Failed to generate response: ${error.message}`);
        await interaction.editReply({
          embeds: [embed],
          content: ' '
        });
      }
    }
  }

} catch (error) {
  console.error('Error in search command:', error);
  if (interaction.deferred) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Command Error')
      .setDescription('An error occurred while processing your search request.');
    await interaction.editReply({
      embeds: [embed],
      content: ' '
    });
  }
}
}

          
function updateEmbedForInteraction(interaction, botMessage, finalResponse, groundingMetadata, urlContextMetadata, effectiveSettings) {
try {
  const isGuild = interaction.guild !== null;
  const embedColor = effectiveSettings.embedColor || hexColour;

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setDescription(finalResponse.slice(0, 4096))
    .setTimestamp()
    .setAuthor({
      name: `To ${interaction.user.displayName}`,
      iconURL: interaction.user.displayAvatarURL()
    });

  if (groundingMetadata && effectiveSettings.responseFormat === 'Embedded') {
    addGroundingMetadataToEmbed(embed, groundingMetadata);
  }

  if (urlContextMetadata && effectiveSettings.responseFormat === 'Embedded') {
    addUrlContextMetadataToEmbed(embed, urlContextMetadata);
  }

  if (isGuild) {
    embed.setFooter({
      text: interaction.guild.name,
      iconURL: interaction.guild.iconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
    });
  }

  interaction.editReply({
    content: ' ',
    embeds: [embed]
  }).catch(() => {});
} catch (error) {
  console.error("Error updating interaction embed:", error.message);
}
}

// Replace the entire processAttachment function in index.js with this version

async function processAttachment(attachment, userId, interactionId) {
  const contentType = (attachment.contentType || "").toLowerCase();
  const fileExtension = path.extname(attachment.name).toLowerCase();

  // Define file types that can be DIRECTLY uploaded to Gemini API
  const apiUploadableTypes = {
    // Images
    images: {
      extensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heif', '.tiff', '.bmp'],
      mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heif', 'image/tiff', 'image/bmp']
    },
    // Video
    video: {
      extensions: ['.mp4', '.mov', '.mpeg', '.mpg', '.webm', '.avi', '.wmv', '.3gpp', '.flv'],
      mimeTypes: ['video/mp4', 'video/quicktime', 'video/mpeg', 'video/mpg', 'video/webm', 
                  'video/x-msvideo', 'video/x-ms-wmv', 'video/3gpp', 'video/x-flv', 'video/mpegps']
    },
    // Audio
    audio: {
      extensions: ['.mp3', '.wav', '.aiff', '.aac', '.ogg', '.flac', '.m4a', '.opus'],
      mimeTypes: ['audio/mp3', 'audio/wav', 'audio/aiff', 'audio/aac', 'audio/ogg', 
                  'audio/flac', 'audio/m4a', 'audio/mpeg', 'audio/mpga', 'audio/opus', 
                  'audio/pcm', 'audio/webm', 'audio/mp4']
    },
    // Documents that can be uploaded
    uploadableDocs: {
      extensions: ['.pdf'],
      mimeTypes: ['application/pdf', 'application/x-pdf']
    },
    // Plain text that can be uploaded
    plainText: {
      extensions: ['.txt'],
      mimeTypes: ['text/plain']
    }
  };

  // Convertible image formats (will be converted to PNG)
  const convertibleImages = {
    extensions: ['.svg', '.avif', '.ico', '.psd', '.eps', '.raw', '.cr2', '.nef'],
    mimeTypes: ['image/svg+xml', 'image/avif', 'image/x-icon', 'image/vnd.adobe.photoshop']
  };

  // Convertible audio formats (will be converted to MP3)
  const convertibleAudio = {
    extensions: ['.wma', '.amr', '.mid', '.midi', '.ra'],
    mimeTypes: ['audio/x-ms-wma', 'audio/amr', 'audio/midi', 'audio/x-realaudio']
  };

  // Convertible video formats (will be converted to MP4)
  const convertibleVideo = {
    extensions: ['.mkv', '.vob', '.ogv', '.ts', '.m2ts', '.divx'],
    mimeTypes: ['video/x-matroska', 'video/mpeg', 'video/ogg', 'video/mp2t']
  };

  // Files that need text extraction and upload as TXT
  const textExtractionTypes = {
    extensions: ['.doc', '.docx', '.xls', '.xlsx', '.csv', '.tsv', '.pptx', '.rtf', 
                 '.html', '.py', '.java', '.js', '.css', '.json', '.xml', '.sql', '.log', '.md',
                 '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs', '.swift', 
                 '.kt', '.scala', '.sh', '.bat', '.yml', '.yaml', '.ini', '.cfg', '.conf'],
    mimeTypes: ['application/msword', 
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'text/csv', 'text/tab-separated-values',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'application/rtf', 'text/html', 'text/markdown', 'application/json',
                'application/xml', 'text/x-python', 'text/x-java', 'text/javascript',
                'text/css', 'application/x-sql']
  };

  // Truly unsupported files (archives, executables, etc.)
  const unsupportedTypes = {
    extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', 
                 '.exe', '.dll', '.bin', '.dmg', '.pkg', '.deb', '.rpm',
                 '.iso', '.img', '.msi', '.apk', '.jar',
                 '.db', '.sqlite', '.mdb', '.accdb'],
    mimeTypes: ['application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
                'application/x-tar', 'application/gzip', 'application/x-executable',
                'application/x-msdownload', 'application/vnd.microsoft.portable-executable',
                'application/x-iso9660-image']
  };

  const sanitizedFileName = sanitizeFileName(attachment.name);
  const uniqueTempFilename = `${userId}-${interactionId}-${Date.now()}-${sanitizedFileName}`;
  const filePath = path.join(TEMP_DIR, uniqueTempFilename);

  // Check if file is truly unsupported
  const isUnsupported = 
    unsupportedTypes.extensions.includes(fileExtension) ||
    unsupportedTypes.mimeTypes.includes(contentType);

  if (isUnsupported) {
    console.warn(`Unsupported file type: ${attachment.name} (${contentType})`);
    return {
      text: `\n\n[❌ Unsupported File Type: ${attachment.name}]\nThis file format cannot be processed. Supported formats include: images, videos, audio, PDFs, text files, and office documents.`
    };
  }

  // Check if file can be uploaded directly to API
  const canUploadToAPI = 
    apiUploadableTypes.images.extensions.includes(fileExtension) ||
    apiUploadableTypes.images.mimeTypes.includes(contentType) ||
    apiUploadableTypes.video.extensions.includes(fileExtension) ||
    apiUploadableTypes.video.mimeTypes.includes(contentType) ||
    apiUploadableTypes.audio.extensions.includes(fileExtension) ||
    apiUploadableTypes.audio.mimeTypes.includes(contentType) ||
    apiUploadableTypes.uploadableDocs.extensions.includes(fileExtension) ||
    apiUploadableTypes.uploadableDocs.mimeTypes.includes(contentType) ||
    apiUploadableTypes.plainText.extensions.includes(fileExtension) ||
    apiUploadableTypes.plainText.mimeTypes.includes(contentType);

  // ==================== DIRECT UPLOAD PATH ====================
  if (canUploadToAPI) {
    try {
      await downloadFile(attachment.url, filePath);
      
      // Special handling for GIFs and animated stickers/emojis - convert to MP4
      const isGif = contentType === 'image/gif' || fileExtension === '.gif';
      const isAnimatedSticker = attachment.isSticker && attachment.isAnimated;
      const isAnimatedEmoji = attachment.isEmoji && attachment.isAnimated;

      if ((isGif || isAnimatedSticker || isAnimatedEmoji) && !contentType.includes('video')) {
        const mp4FilePath = filePath.replace(/\.(gif|png|jpg|jpeg)$/i, '.mp4');
        
        try {
          await new Promise((resolve, reject) => {
            ffmpeg(filePath)
              .outputOptions([
                '-movflags', 'faststart',
                '-pix_fmt', 'yuv420p',
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
              ])
              .output(mp4FilePath)
              .on('end', resolve)
              .on('error', reject)
              .run();
          });
          
          const uploadResult = await genAI.files.upload({
            file: mp4FilePath,
            config: {
              mimeType: 'video/mp4',
              displayName: sanitizedFileName.replace(/\.gif$/i, '.mp4'),
            }
          });

          const name = uploadResult.name;
          if (!name) {
            throw new Error(`Unable to extract file name from upload result.`);
          }

          let file = await genAI.files.get({ name: name });
          let attempts = 0;
          while (file.state === 'PROCESSING' && attempts < 60) {
            await delay(10000);
            file = await genAI.files.get({ name: name });
            attempts++;
          }
          
          if (file.state === 'FAILED') {
            throw new Error(`Video processing failed for ${sanitizedFileName}.`);
          }

          await fs.unlink(filePath).catch(() => {});
          await fs.unlink(mp4FilePath).catch(() => {});
          
          let metadata = '';
          if (isAnimatedSticker) {
            metadata = `[Animated Sticker converted to video: ${attachment.name} (video/mp4)]`;
          } else if (isAnimatedEmoji) {
            metadata = `[Animated Emoji (:${attachment.emojiName}:) converted to video (video/mp4)]`;
          } else {
            metadata = `[Animated GIF converted to video: ${sanitizedFileName} (video/mp4)]`;
          }
          
          return [
            { text: metadata },
            createPartFromUri(uploadResult.uri, uploadResult.mimeType)
          ];
          
        } catch (gifError) {
          console.error('Error converting GIF to MP4:', gifError);
          
          try {
            const sharp = (await import('sharp')).default;
            const pngFilePath = filePath.replace(/\.gif$/i, '.png');
            await sharp(filePath, { animated: false })
              .png()
              .toFile(pngFilePath);
            
            const uploadResult = await genAI.files.upload({
              file: pngFilePath,
              config: {
                mimeType: 'image/png',
                displayName: sanitizedFileName.replace(/\.gif$/i, '.png'),
              }
            });
            
            await fs.unlink(filePath).catch(() => {});
            await fs.unlink(pngFilePath).catch(() => {});
            
            let fallbackMetadata = '';
            if (isAnimatedSticker) {
              fallbackMetadata = `[Static frame from Animated Sticker: ${attachment.name} (image/png)]`;
            } else if (isAnimatedEmoji) {
              fallbackMetadata = `[Static frame from Animated Emoji: :${attachment.emojiName}: (image/png)]`;
            } else {
              fallbackMetadata = `[Static frame from GIF: ${sanitizedFileName} (image/png)]`;
            }
            
            return [
              { text: fallbackMetadata },
              createPartFromUri(uploadResult.uri, uploadResult.mimeType)
            ];
          } catch (fallbackError) {
            throw gifError;
          }
        }
      }
      
      // Determine correct MIME type
      let mimeType = contentType || attachment.contentType;
      
      if (!mimeType || mimeType === 'application/octet-stream') {
        const mimeMap = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.heif': 'image/heif',
          '.tiff': 'image/tiff',
          '.bmp': 'image/bmp',
          '.mp4': 'video/mp4',
          '.mov': 'video/quicktime',
          '.avi': 'video/x-msvideo',
          '.webm': 'video/webm',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
          '.aac': 'audio/aac',
          '.ogg': 'audio/ogg',
          '.flac': 'audio/flac',
          '.m4a': 'audio/mp4',
          '.pdf': 'application/pdf',
          '.txt': 'text/plain'
        };
        mimeType = mimeMap[fileExtension] || 'application/octet-stream';
      }
      
      const uploadResult = await genAI.files.upload({
        file: filePath,
        config: {
          mimeType: mimeType,
          displayName: sanitizedFileName,
        }
      });

      const name = uploadResult.name;
      if (!name) {
        throw new Error(`Unable to extract file name from upload result.`);
      }

      // Only wait for video processing
      if (apiUploadableTypes.video.extensions.includes(fileExtension) || 
          apiUploadableTypes.video.mimeTypes.includes(contentType)) {
        let file = await genAI.files.get({ name: name });
        let attempts = 0;
        while (file.state === 'PROCESSING' && attempts < 60) {
          await delay(10000);
          file = await genAI.files.get({ name: name });
          attempts++;
        }
        if (file.state === 'FAILED') {
          throw new Error(`Video processing failed for ${sanitizedFileName}.`);
        }
      }

      await fs.unlink(filePath).catch(() => {});
      
      // ✅ ENHANCED: Add descriptive metadata based on file type
      let fileTypeDescription = 'File';
      if (apiUploadableTypes.images.extensions.includes(fileExtension) || 
          apiUploadableTypes.images.mimeTypes.includes(mimeType)) {
        fileTypeDescription = 'Image';
      } else if (apiUploadableTypes.video.extensions.includes(fileExtension) || 
                 apiUploadableTypes.video.mimeTypes.includes(mimeType)) {
        fileTypeDescription = 'Video';
      } else if (apiUploadableTypes.audio.extensions.includes(fileExtension) || 
                 apiUploadableTypes.audio.mimeTypes.includes(mimeType)) {
        fileTypeDescription = 'Audio';
      } else if (apiUploadableTypes.uploadableDocs.extensions.includes(fileExtension) || 
                 apiUploadableTypes.uploadableDocs.mimeTypes.includes(mimeType)) {
        fileTypeDescription = 'PDF Document';
      } else if (apiUploadableTypes.plainText.extensions.includes(fileExtension) || 
                 apiUploadableTypes.plainText.mimeTypes.includes(mimeType)) {
        fileTypeDescription = 'Text File';
      }
      
      return [
        { text: `[${fileTypeDescription} uploaded: ${sanitizedFileName} (${mimeType})]` },
        createPartFromUri(uploadResult.uri, uploadResult.mimeType)
      ];
      
    } catch (uploadError) {
      console.error(`Error uploading ${attachment.name} to API:`, uploadError);
      await fs.unlink(filePath).catch(() => {});
      throw uploadError;
    }
  }

  // ==================== CONVERTIBLE IMAGE PATH ====================
  const isConvertibleImage = 
    convertibleImages.extensions.includes(fileExtension) ||
    convertibleImages.mimeTypes.includes(contentType);

  if (isConvertibleImage) {
    try {
      await downloadFile(attachment.url, filePath);
      const sharp = (await import('sharp')).default;
      const pngFilePath = filePath.replace(/\.[^.]+$/, '.png');
      
      await sharp(filePath)
        .png()
        .toFile(pngFilePath);
      
      const uploadResult = await genAI.files.upload({
        file: pngFilePath,
        config: {
          mimeType: 'image/png',
          displayName: sanitizedFileName.replace(/\.[^.]+$/, '.png'),
        }
      });

      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(pngFilePath).catch(() => {});
      
      return [
        { text: `[Image converted from ${fileExtension.toUpperCase()} to PNG: ${attachment.name} (image/png)]` },
        createPartFromUri(uploadResult.uri, 'image/png')
      ];
      
    } catch (conversionError) {
      console.error(`Error converting image ${attachment.name}:`, conversionError);
      await fs.unlink(filePath).catch(() => {});
      return {
        text: `\n\n[❌ Failed to convert image: ${attachment.name}]`
      };
    }
  }

  // ==================== CONVERTIBLE AUDIO PATH ====================
  const isConvertibleAudio = 
    convertibleAudio.extensions.includes(fileExtension) ||
    convertibleAudio.mimeTypes.includes(contentType);

  if (isConvertibleAudio) {
    try {
      await downloadFile(attachment.url, filePath);
      const mp3FilePath = filePath.replace(/\.[^.]+$/, '.mp3');
      
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .toFormat('mp3')
          .audioCodec('libmp3lame')
          .audioBitrate('192k')
          .output(mp3FilePath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      const uploadResult = await genAI.files.upload({
        file: mp3FilePath,
        config: {
          mimeType: 'audio/mpeg',
          displayName: sanitizedFileName.replace(/\.[^.]+$/, '.mp3'),
        }
      });

      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(mp3FilePath).catch(() => {});
      
      return [
        { text: `[Audio converted from ${fileExtension.toUpperCase()} to MP3: ${attachment.name} (audio/mpeg)]` },
        createPartFromUri(uploadResult.uri, 'audio/mpeg')
      ];
      
    } catch (conversionError) {
      console.error(`Error converting audio ${attachment.name}:`, conversionError);
      await fs.unlink(filePath).catch(() => {});
      return {
        text: `\n\n[❌ Failed to convert audio: ${attachment.name}]`
      };
    }
  }

  // ==================== CONVERTIBLE VIDEO PATH ====================
  const isConvertibleVideo = 
    convertibleVideo.extensions.includes(fileExtension) ||
    convertibleVideo.mimeTypes.includes(contentType);

  if (isConvertibleVideo) {
    try {
      await downloadFile(attachment.url, filePath);
      const mp4FilePath = filePath.replace(/\.[^.]+$/, '.mp4');
      
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .outputOptions([
            '-movflags', 'faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
          ])
          .videoCodec('libx264')
          .audioCodec('aac')
          .output(mp4FilePath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      const uploadResult = await genAI.files.upload({
        file: mp4FilePath,
        config: {
          mimeType: 'video/mp4',
          displayName: sanitizedFileName.replace(/\.[^.]+$/, '.mp4'),
        }
      });

      const name = uploadResult.name;
      let file = await genAI.files.get({ name: name });
      let attempts = 0;
      while (file.state === 'PROCESSING' && attempts < 60) {
        await delay(10000);
        file = await genAI.files.get({ name: name });
        attempts++;
      }
      
      if (file.state === 'FAILED') {
        throw new Error(`Video processing failed.`);
      }

      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(mp4FilePath).catch(() => {});
      
      return [
        { text: `[Video converted from ${fileExtension.toUpperCase()} to MP4: ${attachment.name} (video/mp4)]` },
        createPartFromUri(uploadResult.uri, 'video/mp4')
      ];
      
    } catch (conversionError) {
      console.error(`Error converting video ${attachment.name}:`, conversionError);
      await fs.unlink(filePath).catch(() => {});
      return {
        text: `\n\n[❌ Failed to convert video: ${attachment.name}]`
      };
    }
  }

  // ==================== TEXT EXTRACTION PATH ====================
  const needsTextExtraction = 
    textExtractionTypes.extensions.includes(fileExtension) ||
    textExtractionTypes.mimeTypes.includes(contentType);

  if (needsTextExtraction) {
    try {
      let fileContent = await downloadAndReadFile(attachment.url, fileExtension);
      
      // Always upload as TXT file with metadata
      const txtFileName = sanitizedFileName.replace(/\.[^.]+$/, '.txt');
      const txtFilePath = path.join(TEMP_DIR, `extracted-${uniqueTempFilename}.txt`);
      
      await fs.writeFile(txtFilePath, fileContent, 'utf8');
      
      const uploadResult = await genAI.files.upload({
        file: txtFilePath,
        config: {
          mimeType: 'text/plain',
          displayName: txtFileName,
        }
      });

      await fs.unlink(txtFilePath).catch(() => {});
      
      // Determine original file type for metadata
      let originalType = 'Document';
      if (['.doc', '.docx', '.rtf'].includes(fileExtension)) {
        originalType = 'Word Document';
      } else if (['.xls', '.xlsx', '.csv', '.tsv'].includes(fileExtension)) {
        originalType = 'Spreadsheet';
      } else if (fileExtension === '.pptx') {
        originalType = 'PowerPoint Presentation';
      } else if (['.html', '.xml'].includes(fileExtension)) {
        originalType = 'Markup Document';
      } else if (['.py', '.java', '.js', '.css', '.json', '.sql', '.c', '.cpp', '.cs', '.php', '.rb', '.go'].includes(fileExtension)) {
        originalType = 'Code File';
      } else if (['.md', '.log', '.yml', '.yaml', '.ini', '.cfg', '.conf'].includes(fileExtension)) {
        originalType = 'Text Configuration File';
      }
      
      return [
        { text: `[${originalType} extracted to text: ${attachment.name} (converted to text/plain)]` },
        createPartFromUri(uploadResult.uri, 'text/plain')
      ];
      
    } catch (extractionError) {
      console.error(`Error extracting text from ${attachment.name}:`, extractionError);
      return {
        text: `\n\n[❌ Failed to extract text from: ${attachment.name}]`
      };
    }
  }

  // Final fallback - should rarely reach here
  console.warn(`Unhandled file type: ${attachment.name} (${contentType})`);
  return {
    text: `\n\n[⚠️ Unknown file format: ${attachment.name}]`
  };
}


async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return;

  const guildId = interaction.guild?.id;
  const userId = interaction.user.id;

  if (guildId) {
    initializeBlacklistForGuild(guildId);
    if (state.blacklistedUsers[guildId]?.includes(userId)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚫 Blacklisted')
        .setDescription('You are blacklisted and cannot use this interaction.');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }
  }

  const buttonHandlers = {
    // User Settings Navigation
    'user_settings_page3': showUserSettingsPage3, // NEW
    'user_settings_page2': showUserSettingsPage2,
    'user_settings_p1': showUserSettings,
    'user_settings': showUserSettings,
    'back_to_user_p2': showUserSettingsPage2, // NEW
    'back_to_user': showUserSettings,

    // Server Settings Navigation
    'server_settings_page5': showServerSettingsPage5, // NEW
    'server_settings_page4': showServerSettingsPage4,
    'server_settings_page3': showServerSettingsPage3,
    'server_settings_page2': showServerSettingsPage2,
    'server_settings_p1': showServerSettings,
    'server_settings': showServerSettings,
    
    // Server Back Buttons
    'back_to_server_p4': showServerSettingsPage4, // NEW
    'back_to_server_p3': showServerSettingsPage3,
    'back_to_server_p2': showServerSettingsPage2,
    'back_to_server': showServerSettings,

    // Main Menu
    'back_to_main': showMainSettings,

    // Actions
    'clear_user_memory': clearUserMemory,
    'download_user_conversation': downloadUserConversation,
    'clear_server_memory': clearServerMemory,
    'download_server_conversation': downloadServerConversation,
    'user_custom_personality': showUserPersonalityModal,
    'user_remove_personality': removeUserPersonality,
    'server_custom_personality': showServerPersonalityModal,
    'server_remove_personality': removeServerPersonality,
    'user_embed_color': showUserEmbedColorModal,
    'server_embed_color': showServerEmbedColorModal,
    'toggle_continuous_reply': toggleContinuousReplyChannel,
    'manage_allowed_channels': showChannelManagementMenu,
    'set_all_channels': handleSetAllChannels,
    'download_message': downloadMessage,
    'settings_btn': showMainSettings,
    'stopGenerating': stopGeneration,
  };

  const updateableMenus = [
    'user_settings', 'user_settings_page2', 'user_settings_page3', 'user_settings_p1',
    'server_settings', 'server_settings_p1', 'server_settings_page2', 
    'server_settings_page3', 'server_settings_page4', 'server_settings_page5',
    'back_to_main', 'back_to_user', 'back_to_user_p2',
    'back_to_server', 'back_to_server_p2', 'back_to_server_p3', 'back_to_server_p4',
    'manage_allowed_channels', 'set_all_channels'
  ];

  for (const [key, handler] of Object.entries(buttonHandlers)) {
    if (interaction.customId.startsWith(key)) {
      if (updateableMenus.includes(key)) {
        await handler(interaction, true);
      } else {
        await handler(interaction);
      }
      return;
    }
  }

  if (interaction.customId.startsWith('delete_message-')) {
    const msgId = interaction.customId.replace('delete_message-', '');
    await handleDeleteMessageInteraction(interaction, msgId);
  }
}


  

async function handleSelectMenuInteraction(interaction) {
if (!interaction.isStringSelectMenu() && !interaction.isChannelSelectMenu()) return;

const guildId = interaction.guild?.id;
const userId = interaction.user.id;

if (guildId) {
  initializeBlacklistForGuild(guildId);
  if (state.blacklistedUsers[guildId]?.includes(userId)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Blacklisted')
      .setDescription('You are blacklisted and cannot use this interaction.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}

if (interaction.customId === 'user_model_select') {
  const selectedModel = interaction.values[0];
  if (!state.userSettings[userId]) {
    state.userSettings[userId] = {};
  }
  state.userSettings[userId].selectedModel = selectedModel;
  await saveStateToFile();
  await showUserSettings(interaction, true);
} else if (interaction.customId === 'server_model_select') {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server settings.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  const selectedModel = interaction.values[0];
  if (!state.serverSettings[guildId]) {
    state.serverSettings[guildId] = {};
  }
  state.serverSettings[guildId].selectedModel = selectedModel;
  await saveStateToFile();
  await showServerSettings(interaction, true);
} else if (interaction.customId === 'user_response_format') {
  const selectedFormat = interaction.values[0];
  if (!state.userSettings[userId]) {
    state.userSettings[userId] = {};
  }
  state.userSettings[userId].responseFormat = selectedFormat;
  await saveStateToFile();
  await showUserSettings(interaction, true);
} else if (interaction.customId === 'server_response_format') {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server settings.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  const selectedFormat = interaction.values[0];
  if (!state.serverSettings[guildId]) {
    state.serverSettings[guildId] = {};
  }
  state.serverSettings[guildId].responseFormat = selectedFormat;
  await saveStateToFile();
  await showServerSettings(interaction, true);
} else if (interaction.customId === 'user_action_buttons') {
  const selectedValue = interaction.values[0];
  if (!state.userSettings[userId]) {
    state.userSettings[userId] = {};
  }
  state.userSettings[userId].showActionButtons = selectedValue === 'show';
  await saveStateToFile();
  await showUserSettings(interaction, true);
} else if (interaction.customId === 'server_action_buttons') {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server settings.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  const selectedValue = interaction.values[0];
  if (!state.serverSettings[guildId]) {
    state.serverSettings[guildId] = {};
  }
  state.serverSettings[guildId].showActionButtons = selectedValue === 'show';
  await saveStateToFile();
  await showServerSettings(interaction, true);
} else if (interaction.customId === 'user_continuous_reply') {
  const selectedValue = interaction.values[0];
  if (!state.userSettings[userId]) {
    state.userSettings[userId] = {};
  }
  state.userSettings[userId].continuousReply = selectedValue === 'enabled';
  await saveStateToFile();
  await showUserSettingsPage2(interaction, true);
} else if (interaction.customId === 'server_continuous_reply') {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server settings.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  const selectedValue = interaction.values[0];
  if (!state.serverSettings[guildId]) {
    state.serverSettings[guildId] = {};
  }
  state.serverSettings[guildId].continuousReply = selectedValue === 'enabled';
  await saveStateToFile();
  await showServerSettingsPage2(interaction, true);
} else if (interaction.customId === 'server_override') {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server settings.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  const selectedValue = interaction.values[0];
  if (!state.serverSettings[guildId]) {
    state.serverSettings[guildId] = {};
  }
  state.serverSettings[guildId].overrideUserSettings = selectedValue === 'enabled';
  await saveStateToFile();
  await showServerSettingsPage2(interaction, true);
} else if (interaction.customId === 'server_chat_history') {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server settings.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  const selectedValue = interaction.values[0];
  if (!state.serverSettings[guildId]) {
    state.serverSettings[guildId] = {};
  }
  state.serverSettings[guildId].serverChatHistory = selectedValue === 'enabled';
  await saveStateToFile();
  await showServerSettingsPage2(interaction, true);
} else if (interaction.customId === 'channel_manage_select') {
  await handleChannelManageSelect(interaction);
}
}

async function handleModalSubmit(interaction) {
const userId = interaction.user.id;
const guildId = interaction.guild?.id;

if (interaction.customId === 'user_personality_modal') {
  try {
    const personalityInput = interaction.fields.getTextInputValue('personality_input');
    if (!state.userSettings[userId]) {
      state.userSettings[userId] = {};
    }
    state.userSettings[userId].customPersonality = personalityInput.trim();
    await saveStateToFile();

    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Success')
      .setDescription('Your custom personality has been saved!');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error('Error saving user personality:', error);
  }
} else if (interaction.customId === 'server_personality_modal') {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server settings.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  try {
    const personalityInput = interaction.fields.getTextInputValue('personality_input');
    if (!state.serverSettings[guildId]) {
      state.serverSettings[guildId] = {};
    }
    state.serverSettings[guildId].customPersonality = personalityInput.trim();
    await saveStateToFile();

    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Success')
      .setDescription('Server custom personality has been saved!');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error('Error saving server personality:', error);
  }
} else if (interaction.customId === 'user_embed_color_modal') {
  try {
    const colorInput = interaction.fields.getTextInputValue('color_input').trim();
    const hexPattern = /^#?([0-9A-Fa-f]{6})$/;
    if (!hexPattern.test(colorInput)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Invalid Color')
        .setDescription('Please provide a valid hex color code (e.g., #FF5733 or FF5733).');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }
    const hexColor = colorInput.startsWith('#') ? colorInput : `#${colorInput}`;
    if (!state.userSettings[userId]) {
      state.userSettings[userId] = {};
    }
    state.userSettings[userId].embedColor = hexColor;
    await saveStateToFile();

    const embed = new EmbedBuilder()
      .setColor(hexColor)
      .setTitle('✅ Color Updated')
      .setDescription(`Your embed color has been set to \`${hexColor}\``);
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error('Error saving user embed color:', error);
  }
} else if (interaction.customId === 'server_embed_color_modal') {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server settings.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  try {
    const colorInput = interaction.fields.getTextInputValue('color_input').trim();
    const hexPattern = /^#?([0-9A-Fa-f]{6})$/;
    if (!hexPattern.test(colorInput)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Invalid Color')
        .setDescription('Please provide a valid hex color code (e.g., #FF5733 or FF5733).');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }
    const hexColor = colorInput.startsWith('#') ? colorInput : `#${colorInput}`;
    if (!state.serverSettings[guildId]) {
      state.serverSettings[guildId] = {};
    }
    state.serverSettings[guildId].embedColor = hexColor;
    await saveStateToFile();

    const embed = new EmbedBuilder()
      .setColor(hexColor)
      .setTitle('✅ Color Updated')
      .setDescription(`Server embed color has been set to \`${hexColor}\``);
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.error('Error saving server embed color:', error);
  }
}
}

async function showMainSettings(interaction, isUpdate = false) {
try {
  const guildId = interaction.guild?.id;
  const hasManageServer = guildId ? interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) : false;

  const buttons = [
    new ButtonBuilder()
    .setCustomId('user_settings')
    .setLabel('User Settings')
    .setEmoji('👤')
    .setStyle(ButtonStyle.Primary)
  ];

  if (hasManageServer) {
    buttons.push(
      new ButtonBuilder()
      .setCustomId('server_settings')
      .setLabel('Server Settings')
      .setEmoji('🏰')
      .setStyle(ButtonStyle.Success)
    );
  }

  const row = new ActionRowBuilder().addComponents(...buttons);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚙️ Settings Dashboard')
    .setDescription('Choose a settings category to configure:')
    .addFields({
      name: '👤 User Settings',
      value: 'Configure your personal bot preferences',
      inline: true
    })
    .setTimestamp();

  if (hasManageServer) {
    embed.addFields({
      name: '🏰 Server Settings',
      value: 'Manage server-wide bot configuration',
      inline: true
    });
  }

  const payload = {
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral
  };

  let reply;
  if (isUpdate) {
    reply = await interaction.update(payload);
  } else {
    reply = await interaction.reply({...payload,
      fetchReply: true
    });
  }

  setTimeout(async () => {
    try {
      // Check if interaction exists before trying to delete
      const currentReply = await interaction.fetchReply().catch(() => null);
      if (currentReply) {
        await interaction.deleteReply();
      }
    } catch (error) {
      if (error.code !== 10008) { // Ignore "Unknown Message" error
        console.error('Error deleting expired settings message:', error);
      }
    }
  }, 300000);
} catch (error) {
  console.error('Error showing main settings:', error);
}
}

async function showUserSettings(interaction, isUpdate = false) {
  try {
    const userId = interaction.user.id;
    const userSettings = state.userSettings[userId] || {};
    const guildId = interaction.guild?.id;

    if (guildId) {
      const serverSettings = state.serverSettings[guildId] || {};
      if (serverSettings.overrideUserSettings && !isUpdate) {
        try {
          const embed = new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('🔒 Server Override Active')
            .setDescription(`The settings on this server, **${interaction.guild.name}**, are being overridden by server administrators.\n\n` +
              'Your personal user settings will not apply here. However, you can still edit them, and they will apply in your DMs and other servers that do not have override enabled.');
          await interaction.user.send({
            embeds: [embed]
          });
        } catch (dmError) {
          console.error("Failed to send override DM:", dmError);
          // Fallback if DMs are closed is handled silently or by ephemeral reply below
        }
      }
    }

    const selectedModel = userSettings.selectedModel || 'gemini-2.5-flash';
    const responseFormat = userSettings.responseFormat || 'Normal';
    const showActionButtons = userSettings.showActionButtons === true;
    
    const embedColor = userSettings.embedColor || hexColour;

    const modelSelect = new StringSelectMenuBuilder()
      .setCustomId('user_model_select')
      .setPlaceholder('Select AI Model')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Gemini 2.5 Flash').setDescription('Balanced and efficient model').setValue('gemini-2.5-flash').setEmoji('⚡').setDefault(selectedModel === 'gemini-2.5-flash'),
        new StringSelectMenuOptionBuilder().setLabel('Gemini 2.5 Flash Lite').setDescription('Lightweight and quick').setValue('gemini-2.5-flash-lite').setEmoji('💨').setDefault(selectedModel === 'gemini-2.5-flash-lite'),
      );

    const responseFormatSelect = new StringSelectMenuBuilder()
      .setCustomId('user_response_format')
      .setPlaceholder('Response Format')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Normal').setDescription('Plain text responses').setValue('Normal').setEmoji('📝').setDefault(responseFormat === 'Normal'),
        new StringSelectMenuOptionBuilder().setLabel('Embedded').setDescription('Rich embed responses').setValue('Embedded').setEmoji('📊').setDefault(responseFormat === 'Embedded')
      );

    const actionButtonsSelect = new StringSelectMenuBuilder()
      .setCustomId('user_action_buttons')
      .setPlaceholder('Action Buttons')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Show Buttons').setDescription('Display Stop/Save/Delete buttons').setValue('show').setEmoji('✅').setDefault(showActionButtons),
        new StringSelectMenuOptionBuilder().setLabel('Hide Buttons').setDescription('Hide action buttons').setValue('hide').setEmoji('❌').setDefault(!showActionButtons)
      );

    const buttons = [
      new ButtonBuilder().setCustomId('user_settings_page2').setLabel('Next Page').setEmoji('➡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('back_to_main').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(modelSelect),
      new ActionRowBuilder().addComponents(responseFormatSelect),
      new ActionRowBuilder().addComponents(actionButtonsSelect),
      new ActionRowBuilder().addComponents(...buttons)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('👤 User Settings (Page 1/3)')
      .setDescription('Configure your personal bot preferences')
      .addFields({
        name: '🤖 Current Model',
        value: `\`${selectedModel}\``,
        inline: true
      }, {
        name: '📋 Response Format',
        value: `\`${responseFormat}\``,
        inline: true
      }, {
        name: '🔘 Action Buttons',
        value: `\`${showActionButtons ? 'Visible' : 'Hidden'}\``,
        inline: true
      })
      .setFooter({
        text: 'Page 1: Core Preferences'
      })
      .setTimestamp();

    const payload = {
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral
    };

    let reply;
    if (isUpdate) {
      reply = await interaction.update(payload);
    } else {
      reply = await interaction.reply({ ...payload,
        fetchReply: true
      });
    }

    setTimeout(async () => {
      try {
        const currentReply = await interaction.fetchReply().catch(() => null);
        if (currentReply) {
          await interaction.deleteReply();
        }
      } catch (error) {
        if (error.code !== 10008) console.error('Error deleting expired settings message:', error);
      }
    }, 300000);
  } catch (error) {
    console.error('Error showing user settings:', error);
  }
}

async function showUserSettingsPage2(interaction, isUpdate = false) {
  try {
    const userId = interaction.user.id;
    const userSettings = state.userSettings[userId] || {};
    const continuousReply = userSettings.continuousReply ?? true; // Changed || to ??
    const embedColor = userSettings.embedColor || hexColour;
    
    const hasPersonality = !!userSettings.customPersonality;

    // 1. Continuous Reply (Select Menu)
    const continuousReplySelect = new StringSelectMenuBuilder()
      .setCustomId('user_continuous_reply')
      .setPlaceholder('Continuous Reply')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Enabled').setDescription('Bot replies without mentions').setValue('enabled').setEmoji('🔄').setDefault(continuousReply),
        new StringSelectMenuOptionBuilder().setLabel('Disabled').setDescription('Bot requires mentions').setValue('disabled').setEmoji('⏸️').setDefault(!continuousReply)
      );

    // 2. Embed Color (Button Row)
    const colorButton = new ButtonBuilder()
      .setCustomId('user_embed_color')
      .setLabel('Set Embed Color')
      .setEmoji('🎨')
      .setStyle(ButtonStyle.Secondary);

    // 3. Personality (Button Row)
    const personalityBtn = new ButtonBuilder()
      .setCustomId('user_custom_personality')
      .setLabel('Set Personality')
      .setEmoji('🎭')
      .setStyle(ButtonStyle.Primary);

    const removePersonalityBtn = new ButtonBuilder()
      .setCustomId('user_remove_personality')
      .setLabel('Reset')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasPersonality);

    // Navigation
    const navButtons = [
      new ButtonBuilder().setCustomId('user_settings_page3').setLabel('Next Page').setEmoji('➡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('user_settings_p1').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(continuousReplySelect),
      new ActionRowBuilder().addComponents(colorButton),
      new ActionRowBuilder().addComponents(personalityBtn, removePersonalityBtn),
      new ActionRowBuilder().addComponents(...navButtons)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('👤 User Settings (Page 2/3)')
      .setDescription('Configure behavior and appearance.')
      .addFields({
        name: '🔄 Continuous Reply',
        value: `\`${continuousReply ? 'Enabled' : 'Disabled'}\``,
        inline: true
      }, {
        name: '🎨 Embed Color',
        value: `\`${embedColor}\``,
        inline: true
      }, {
        name: '🎭 Personality',
        value: `\`${hasPersonality ? 'Active' : 'Default'}\``,
        inline: true
      })
      .setFooter({
        text: 'Page 2: Behavior & Appearance'
      })
      .setTimestamp();

    const payload = {
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral
    };

    if (isUpdate) await interaction.update(payload);
    else await interaction.reply({ ...payload,
      fetchReply: true
    });

  } catch (error) {
    console.error('Error showing user settings page 2:', error);
  }
}

async function showUserSettingsPage3(interaction, isUpdate = false) {
  try {
    const userId = interaction.user.id;
    const userSettings = state.userSettings[userId] || {};
    const embedColor = userSettings.embedColor || hexColour;

    // 1. Memory Management
    const clearMemBtn = new ButtonBuilder()
      .setCustomId('clear_user_memory')
      .setLabel('Clear Conversation Memory')
      .setEmoji('🧹')
      .setStyle(ButtonStyle.Danger);

    // 2. Data Export
    const downloadBtn = new ButtonBuilder()
      .setCustomId('download_user_conversation')
      .setLabel('Download History')
      .setEmoji('💾')
      .setStyle(ButtonStyle.Secondary);

    // Navigation
    const navButtons = [
      new ButtonBuilder().setCustomId('back_to_user_p2').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(clearMemBtn),
      new ActionRowBuilder().addComponents(downloadBtn),
      new ActionRowBuilder().addComponents(...navButtons)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('👤 User Settings (Page 3/3)')
      .setDescription('Manage your conversation data.')
      .addFields({
        name: '🧹 Memory',
        value: 'Clear current conversation context',
        inline: true
      }, {
        name: '💾 History',
        value: 'Download chat log as text file',
        inline: true
      })
      .setFooter({
        text: 'Page 3: Data Management'
      })
      .setTimestamp();

    const payload = {
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral
    };

    if (isUpdate) await interaction.update(payload);
    else await interaction.reply({ ...payload,
      fetchReply: true
    });

  } catch (error) {
    console.error('Error showing user settings page 3:', error);
  }
}

async function showServerSettings(interaction, isUpdate = false) {
  try {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return sendPermError(interaction);

    const guildId = interaction.guild.id;
    const serverSettings = state.serverSettings[guildId] || {};
    const selectedModel = serverSettings.selectedModel || 'gemini-2.5-flash';
    const responseFormat = serverSettings.responseFormat || 'Normal';
    const showActionButtons = serverSettings.showActionButtons === true;
    
    const embedColor = serverSettings.embedColor || hexColour;

    const modelSelect = new StringSelectMenuBuilder()
      .setCustomId('server_model_select')
      .setPlaceholder('Select AI Model')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Gemini 2.5 Flash').setDescription('Balanced and efficient model').setValue('gemini-2.5-flash').setEmoji('⚡').setDefault(selectedModel === 'gemini-2.5-flash'),
        new StringSelectMenuOptionBuilder().setLabel('Gemini 2.5 Flash Lite').setDescription('Lightweight and quick').setValue('gemini-2.5-flash-lite').setEmoji('💨').setDefault(selectedModel === 'gemini-2.5-flash-lite'),
      );

    const responseFormatSelect = new StringSelectMenuBuilder()
      .setCustomId('server_response_format')
      .setPlaceholder('Response Format')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Normal').setDescription('Plain text responses').setValue('Normal').setEmoji('📝').setDefault(responseFormat === 'Normal'),
        new StringSelectMenuOptionBuilder().setLabel('Embedded').setDescription('Rich embed responses').setValue('Embedded').setEmoji('📊').setDefault(responseFormat === 'Embedded')
      );

    const actionButtonsSelect = new StringSelectMenuBuilder()
      .setCustomId('server_action_buttons')
      .setPlaceholder('Action Buttons')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Show Buttons').setDescription('Display Stop/Save/Delete buttons').setValue('show').setEmoji('✅').setDefault(showActionButtons),
        new StringSelectMenuOptionBuilder().setLabel('Hide Buttons').setDescription('Hide action buttons').setValue('hide').setEmoji('❌').setDefault(!showActionButtons)
      );

    const buttons = [
      new ButtonBuilder().setCustomId('server_settings_page2').setLabel('Next Page').setEmoji('➡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('back_to_main').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(modelSelect),
      new ActionRowBuilder().addComponents(responseFormatSelect),
      new ActionRowBuilder().addComponents(actionButtonsSelect),
      new ActionRowBuilder().addComponents(...buttons)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🏰 Server Settings (Page 1/5)')
      .setDescription('Configure server-wide bot preferences')
      .addFields({
        name: '🤖 Current Model',
        value: `\`${selectedModel}\``,
        inline: true
      }, {
        name: '📋 Response Format',
        value: `\`${responseFormat}\``,
        inline: true
      }, {
        name: '🔘 Action Buttons',
        value: `\`${showActionButtons ? 'Visible' : 'Hidden'}\``,
        inline: true
      })
      .setFooter({
        text: 'Page 1: Core Preferences'
      })
      .setTimestamp();

    const payload = {
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral
    };

    if (isUpdate) await interaction.update(payload);
    else await interaction.reply({ ...payload,
      fetchReply: true
    });

  } catch (error) {
    console.error('Error showing server settings:', error);
  }
}

async function showServerSettingsPage2(interaction, isUpdate = false) {
  try {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return sendPermError(interaction);
    const guildId = interaction.guild.id;
    const serverSettings = state.serverSettings[guildId] || {};
    const embedColor = serverSettings.embedColor || hexColour;
    const overrideUserSettings = serverSettings.overrideUserSettings || false;
    const continuousReply = serverSettings.continuousReply || false;
    const serverChatHistory = serverSettings.serverChatHistory || false;

    const overrideSelect = new StringSelectMenuBuilder()
      .setCustomId('server_override')
      .setPlaceholder('Override User Settings')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Enabled').setDescription('Server settings override user settings').setValue('enabled').setEmoji('🔒').setDefault(overrideUserSettings),
        new StringSelectMenuOptionBuilder().setLabel('Disabled').setDescription('Users can use their own settings').setValue('disabled').setEmoji('🔓').setDefault(!overrideUserSettings)
      );

    const continuousReplySelect = new StringSelectMenuBuilder()
      .setCustomId('server_continuous_reply')
      .setPlaceholder('Continuous Reply (Server-Wide)')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Enabled').setDescription('Bot replies without mentions in all channels').setValue('enabled').setEmoji('🔄').setDefault(continuousReply),
        new StringSelectMenuOptionBuilder().setLabel('Disabled').setDescription('Bot requires mentions (default)').setValue('disabled').setEmoji('⏸️').setDefault(!continuousReply)
      );

    const chatHistorySelect = new StringSelectMenuBuilder()
      .setCustomId('server_chat_history')
      .setPlaceholder('Server-Wide Chat History')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Enabled').setDescription('Share chat history across server').setValue('enabled').setEmoji('📚').setDefault(serverChatHistory),
        new StringSelectMenuOptionBuilder().setLabel('Disabled').setDescription('Individual user histories').setValue('disabled').setEmoji('📖').setDefault(!serverChatHistory)
      );

    const buttons = [
      new ButtonBuilder().setCustomId('server_settings_page3').setLabel('Next Page').setEmoji('➡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('back_to_server').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(overrideSelect),
      new ActionRowBuilder().addComponents(continuousReplySelect),
      new ActionRowBuilder().addComponents(chatHistorySelect),
      new ActionRowBuilder().addComponents(...buttons)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🏰 Server Settings (Page 2/5)')
      .setDescription('Configure logic and overrides')
      .addFields({
        name: '🔒 Override',
        value: `\`${overrideUserSettings ? 'Yes' : 'No'}\``,
        inline: true
      }, {
        name: '🔄 Continuous',
        value: `\`${continuousReply ? 'Yes' : 'No'}\``,
        inline: true
      }, {
        name: '📚 History',
        value: `\`${serverChatHistory ? 'Yes' : 'No'}\``,
        inline: true
      })
      .setFooter({
        text: 'Page 2: Logic & Overrides'
      })
      .setTimestamp();

    const payload = {
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral
    };

    if (isUpdate) await interaction.update(payload);
    else await interaction.reply({ ...payload,
      fetchReply: true
    });

  } catch (error) {
    console.error('Error showing server settings page 2:', error);
  }
}

async function showServerSettingsPage3(interaction, isUpdate = false) {
  try {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return sendPermError(interaction);
    const guildId = interaction.guild.id;
    const serverSettings = state.serverSettings[guildId] || {};
    const embedColor = serverSettings.embedColor || hexColour;
    const hasPersonality = !!serverSettings.customPersonality;

    // 1. Embed Color
    const colorBtn = new ButtonBuilder()
      .setCustomId('server_embed_color')
      .setLabel('Set Server Embed Color')
      .setEmoji('🎨')
      .setStyle(ButtonStyle.Secondary);

    // 2. Personality
    const personalityBtn = new ButtonBuilder()
      .setCustomId('server_custom_personality')
      .setLabel('Set Server Personality')
      .setEmoji('🎭')
      .setStyle(ButtonStyle.Primary);

    const removePersonalityBtn = new ButtonBuilder()
      .setCustomId('server_remove_personality')
      .setLabel('Reset Personality')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasPersonality);

    // Navigation
    const navButtons = [
      new ButtonBuilder().setCustomId('server_settings_page4').setLabel('Next Page').setEmoji('➡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('back_to_server_p2').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(colorBtn),
      new ActionRowBuilder().addComponents(personalityBtn, removePersonalityBtn),
      new ActionRowBuilder().addComponents(...navButtons)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🏰 Server Settings (Page 3/5)')
      .setDescription('Configure server appearance and personality.')
      .addFields({
        name: '🎨 Embed Color',
        value: `\`${embedColor}\``,
        inline: true
      }, {
        name: '🎭 Custom Personality',
        value: `\`${hasPersonality ? 'Active' : 'Default'}\``,
        inline: true
      })
      .setFooter({
        text: 'Page 3: Appearance & Personality'
      })
      .setTimestamp();

    const payload = {
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral
    };

    if (isUpdate) await interaction.update(payload);
    else await interaction.reply({ ...payload,
      fetchReply: true
    });

  } catch (error) {
    console.error('Error showing server settings page 3:', error);
  }
}

function sendPermError(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🚫 Permission Denied')
    .setDescription('You need "Manage Server" permission to access server settings.');
  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
      }

async function showServerSettingsPage4(interaction, isUpdate = false) {
  try {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚫 Permission Denied')
        .setDescription('You need "Manage Server" permission to access server settings.');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    const guildId = interaction.guild.id;
    const serverSettings = state.serverSettings[guildId] || {};
    const embedColor = serverSettings.embedColor || hexColour;
    const allowedChannels = serverSettings.allowedChannels || [];

    // 1. Manage Channels Button
    const manageChannelsBtn = new ButtonBuilder()
      .setCustomId('manage_allowed_channels')
      .setLabel('Manage Allowed Channels')
      .setEmoji('📢')
      .setStyle(ButtonStyle.Primary);

    // 2. Toggle Current Channel Continuous
    const toggleContinuousBtn = new ButtonBuilder()
      .setCustomId('toggle_continuous_reply')
      .setLabel('Toggle Channel Continuous')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary);

    // Navigation
    const navButtons = [
      new ButtonBuilder().setCustomId('server_settings_page5').setLabel('Next Page').setEmoji('➡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('back_to_server_p3').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(manageChannelsBtn),
      new ActionRowBuilder().addComponents(toggleContinuousBtn),
      new ActionRowBuilder().addComponents(...navButtons)
    ];

    const channelList = allowedChannels.length > 0 ?
      allowedChannels.map(id => `<#${id}>`).slice(0, 5).join(', ') + (allowedChannels.length > 5 ? '...' : '') :
      'All channels';

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🏰 Server Settings (Page 4/5)')
      .setDescription('Configure channel restrictions.')
      .addFields({
        name: '📢 Allowed Channels',
        value: channelList,
        inline: false
      }, {
        name: '🔄 Channel Continuous',
        value: 'Enable/Disable continuous mode for *this* channel specifically.',
        inline: false
      })
      .setFooter({
        text: 'Page 4: Channel Management'
      })
      .setTimestamp();

    const payload = {
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral
    };

    if (isUpdate) await interaction.update(payload);
    else await interaction.reply({ ...payload,
      fetchReply: true
    });

  } catch (error) {
    console.error('Error showing server settings page 4:', error);
  }
}

async function showServerSettingsPage5(interaction, isUpdate = false) {
  try {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚫 Permission Denied')
        .setDescription('You need "Manage Server" permission to access server settings.');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    const guildId = interaction.guild.id;
    const serverSettings = state.serverSettings[guildId] || {};
    const embedColor = serverSettings.embedColor || hexColour;

    // 1. Clear Memory
    const clearMemBtn = new ButtonBuilder()
      .setCustomId('clear_server_memory')
      .setLabel('Clear Server Memory')
      .setEmoji('🧹')
      .setStyle(ButtonStyle.Danger);

    // 2. Download History
    const downloadBtn = new ButtonBuilder()
      .setCustomId('download_server_conversation')
      .setLabel('Download Server History')
      .setEmoji('💾')
      .setStyle(ButtonStyle.Secondary);

    // Navigation
    const navButtons = [
      new ButtonBuilder().setCustomId('back_to_server_p4').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(clearMemBtn),
      new ActionRowBuilder().addComponents(downloadBtn),
      new ActionRowBuilder().addComponents(...navButtons)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🏰 Server Settings (Page 5/5)')
      .setDescription('Manage server-wide data.')
      .addFields({
        name: '🧹 Clear Memory',
        value: 'Reset context for the whole server',
        inline: true
      }, {
        name: '💾 Download History',
        value: 'Export server chat log',
        inline: true
      })
      .setFooter({
        text: 'Page 5: Data Management'
      })
      .setTimestamp();

    const payload = {
      embeds: [embed],
      components: components,
      flags: MessageFlags.Ephemeral
    };

    if (isUpdate) await interaction.update(payload);
    else await interaction.reply({ ...payload,
      fetchReply: true
    });

  } catch (error) {
    console.error('Error showing server settings page 5:', error);
  }
}

async function showChannelManagementMenu(interaction, isUpdate = false) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to manage channels.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  const serverSettings = state.serverSettings[guildId] || {};
  const allowedChannels = serverSettings.allowedChannels || [];

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('channel_manage_select')
    .setPlaceholder('Select channels the bot can be used in')
    .setMinValues(0)
    .setMaxValues(25)
    .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]);

  if (allowedChannels.length > 0) {
    const validDefaultChannels = [];
    for (const channelId of allowedChannels) {
      if (interaction.guild.channels.cache.has(channelId)) {
        validDefaultChannels.push(channelId);
      }
    }
    if (validDefaultChannels.length > 0) {
      channelSelect.setDefaultChannels(validDefaultChannels.slice(0, 25));
    }
  }

  const row = new ActionRowBuilder().addComponents(channelSelect);

  const buttons = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
      .setCustomId('set_all_channels')
      .setLabel('Allow in All Channels')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🌍'),
      new ButtonBuilder()
      .setCustomId('back_to_server_p4') // Go back to page 4
      .setLabel('Back to Server Settings')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('◀️')
    );

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📢 Manage Allowed Channels')
    .setDescription('Select the channels where the bot should be allowed to respond. \n\n' +
      'If **no channels** are selected, the bot will respond in **all** channels that it can see.\n\n' +
      'Use the "Allow in All Channels" button to quickly clear the list.')
    .setFooter({
      text: 'Changes are saved automatically when you select.'
    });

  if (allowedChannels.length > 0) {
    embed.addFields({
      name: 'Currently Allowed',
      value: allowedChannels.map(id => `<#${id}>`).join(', ') || 'None'
    });
  } else {
    embed.addFields({
      name: 'Currently Allowed',
      value: 'All Channels'
    });
  }

  const payload = {
    embeds: [embed],
    components: [row, buttons],
    flags: MessageFlags.Ephemeral
  };

  let reply;
  if (isUpdate) {
    reply = await interaction.update(payload);
  } else {
    reply = await interaction.reply({ ...payload,
      fetchReply: true
    });
  }

  setTimeout(async () => {
    try {
      const currentReply = await interaction.fetchReply().catch(() => null);
      if (currentReply) {
        await interaction.deleteReply();
      }
    } catch (error) {
      if (error.code !== 10008) {
        console.error('Error deleting expired settings message:', error);
      }
    }
  }, 300000);
}


      

async function clearUserMemory(interaction) {
try {
  const userId = interaction.user.id;
  state.chatHistories[userId] = {};
  await saveStateToFile();

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Memory Cleared')
    .setDescription('Your chat history has been cleared successfully!');
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
} catch (error) {
  console.error('Error clearing user memory:', error);
}
}

async function clearServerMemory(interaction) {
try {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to clear server memory.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  state.chatHistories[guildId] = {};
  await saveStateToFile();

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Server Memory Cleared')
    .setDescription('Server-wide chat history has been cleared successfully!');
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
} catch (error) {
  console.error('Error clearing server memory:', error);
}
}

async function downloadUserConversation(interaction) {
  try {
    const userId = interaction.user.id;
    const conversationHistory = getHistory(userId);

    if (!conversationHistory || conversationHistory.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ No History Found')
        .setDescription('You don\'t have any conversation history to download.');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    let conversationText = conversationHistory.map(entry => {
      const role = entry.role === 'user' ? '[User]' : '[Model]';
      const content = entry.parts.map(c => c.text).join('\n');
      return `${role}:\n${content}\n\n`;
    }).join('');

    const tempFileName = path.join(TEMP_DIR, `conversation_${interaction.id}.txt`);
    await fs.writeFile(tempFileName, conversationText, 'utf8');

    const stats = await fs.stat(tempFileName);
    const fileSizeMB = stats.size / (1024 * 1024);
    const MAX_DISCORD_MB = 9.5; // Safety margin below 10MB free limit

    const isDM = interaction.channel.type === ChannelType.DM;
    const historyType = isDM ? 'DM History' : 'Personal History';
    
    let fileSent = false;
    let fallbackEmbed;

    if (fileSizeMB <= MAX_DISCORD_MB) {
      const file = new AttachmentBuilder(tempFileName, {
        name: 'conversation_history.txt'
      });

      try {
        await interaction.user.send({
          content: `📥 **Your Conversation History**\n\`${historyType}\``,
          files: [file]
        });
        
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('✅ History Sent').setDescription('Your conversation history has been sent to your DMs!')],
          flags: MessageFlags.Ephemeral
        });
        fileSent = true;
      } catch (error) {
        // DM failed (DMs blocked) or actual small-file upload error
        console.error(`Discord Send Error for ${tempFileName}:`, error);
        fallbackEmbed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle('❌ DM Failed / Upload Error')
          .setDescription('Could not send the history file via DM. Attempting external upload fallback.');
      }
    } else {
      // File too large for Discord limits
      fallbackEmbed = new EmbedBuilder()
        .setColor(0xFFAA00)
        .setTitle('🔗 History Too Large')
        .setDescription(`The conversation history is too large (${fileSizeMB.toFixed(2)} MB) to send directly via Discord. It will be uploaded to an external site.`);
    }

    if (!fileSent) {
      const msgUrlText = await uploadText(conversationText); // Upload to external service
      const msgUrl = msgUrlText.match(/🔗 URL: (.+)/)?.[1] || 'URL generation failed.';

      const finalEmbed = fallbackEmbed || new EmbedBuilder()
        .setColor(0xFFAA00)
        .setTitle('🔗 History Upload Fallback');
        
      finalEmbed.addFields({
        name: 'External Link',
        value: `[View History Content](${msgUrl})`,
        inline: false
      });

      await interaction.reply({
        embeds: [finalEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    await fs.unlink(tempFileName).catch(() => {});
  } catch (error) {
    console.error('Error downloading user conversation:', error);
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Error')
      .setDescription('An unexpected error occurred while processing your history download.');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}


// Replace the downloadServerConversation function in index.js with this fixed version:

async function downloadServerConversation(interaction) {
  try {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('🚫 Permission Denied')
        .setDescription('You need "Manage Server" permission to download server history.');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    const guildId = interaction.guild.id;
    const serverSettings = state.serverSettings[guildId] || {};
    
    if (!serverSettings.serverChatHistory) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Server Chat History Disabled')
        .setDescription('Server-wide chat history is not enabled. Enable it in server settings to use this feature.');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    const historyObject = state.chatHistories[guildId];
    
    if (!historyObject || Object.keys(historyObject).length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ No History Found')
        .setDescription('No server-wide conversation history found. Start chatting with the bot to build history!');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    let conversationText = '';
    let messageCount = 0;
    
    for (const messagesId in historyObject) {
      if (historyObject.hasOwnProperty(messagesId)) {
        const messages = historyObject[messagesId];
        
        for (const entry of messages) {
          const role = entry.role === 'user' ? '[User]' : '[Assistant]';
          const contentParts = [];
          
          for (const part of entry.content) {
            if (part.text !== undefined && part.text !== '') {
              contentParts.push(part.text);
            } else if (part.fileUri || part.fileData) {
              contentParts.push('[Media File Attached]');
            }
          }
          
          if (contentParts.length > 0) {
            const content = contentParts.join('\n');
            conversationText += `${role}:\n${content}\n\n`;
            messageCount++;
          }
        }
      }
    }

    if (conversationText === '' || messageCount === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ No Readable History')
        .setDescription('History exists but contains no readable content (possibly only media without text).');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    const tempFileName = path.join(TEMP_DIR, `server_conversation_${interaction.id}.txt`);
    const header = `Server Conversation History\nServer: ${interaction.guild.name}\nMessages: ${messageCount}\nExported: ${new Date().toLocaleString()}\n${'='.repeat(50)}\n\n`;
    await fs.writeFile(tempFileName, header + conversationText, 'utf8');

    const stats = await fs.stat(tempFileName);
    const fileSizeMB = stats.size / (1024 * 1024);
    const MAX_DISCORD_MB = 9.5; // Safety margin below 10MB free limit
    const serverName = interaction.guild.name;
    
    let fileSent = false;
    let fallbackEmbed;

    if (fileSizeMB <= MAX_DISCORD_MB) {
      const file = new AttachmentBuilder(tempFileName, {
        name: `${serverName.replace(/[^a-z0-9]/gi, '_')}_history.txt`
      });

      try {
        await interaction.user.send({
          content: `📥 **Server Conversation History**\n\`Server: ${serverName}\`\n\`Messages: ${messageCount}\``,
          files: [file]
        });
        
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('✅ History Sent').setDescription(`Server conversation history (${messageCount} messages) has been sent to your DMs!`)],
          flags: MessageFlags.Ephemeral
        });
        fileSent = true;
      } catch (error) {
        // DM failed (DMs blocked) or actual small-file upload error
        console.error(`Discord Send Error for ${tempFileName}:`, error);
        fallbackEmbed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle('❌ DM Failed / Upload Error')
          .setDescription('Could not send the history file via DM. Attempting external upload fallback.');
      }
    } else {
      // File too large for Discord limits
      fallbackEmbed = new EmbedBuilder()
        .setColor(0xFFAA00)
        .setTitle('🔗 History Too Large')
        .setDescription(`The server history is too large (${fileSizeMB.toFixed(2)} MB) to send directly via Discord. It will be uploaded to an external site.`);
    }

    if (!fileSent) {
      const msgUrlText = await uploadText(conversationText); // Upload to external service
      const msgUrl = msgUrlText.match(/🔗 URL: (.+)/)?.[1] || 'URL generation failed.';

      const finalEmbed = fallbackEmbed || new EmbedBuilder()
        .setColor(0xFFAA00)
        .setTitle('🔗 History Upload Fallback');
        
      finalEmbed.addFields({
        name: 'External Link',
        value: `[View History Content](${msgUrl})`,
        inline: false
      });
      
      await interaction.reply({
        embeds: [finalEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    await fs.unlink(tempFileName).catch(() => {});
  } catch (error) {
    console.error('Error downloading server conversation:', error);
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Error')
      .setDescription('An unexpected error occurred while processing your server history download.');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}

// Replace the existing showUserPersonalityModal function with this:
async function showUserPersonalityModal(interaction) {
  const userId = interaction.user.id;
  const userSettings = state.userSettings[userId] || {};
  const existingPersonality = userSettings.customPersonality || '';

  const input = new TextInputBuilder()
    .setCustomId('personality_input')
    .setLabel("What should the bot's personality be like?")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Enter your custom personality instructions...")
    .setMinLength(10)
    .setMaxLength(4000);

  // Pre-fill with existing personality if it exists
  if (existingPersonality) {
    input.setValue(existingPersonality);
  }

  const modal = new ModalBuilder()
    .setCustomId('user_personality_modal')
    .setTitle('Custom Personality')
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

// Replace the existing showServerPersonalityModal function with this:
async function showServerPersonalityModal(interaction) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to set server personality.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  const serverSettings = state.serverSettings[guildId] || {};
  const existingPersonality = serverSettings.customPersonality || '';

  const input = new TextInputBuilder()
    .setCustomId('personality_input')
    .setLabel("What should the bot's personality be like?")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Enter server custom personality instructions...")
    .setMinLength(10)
    .setMaxLength(4000);

  // Pre-fill with existing personality if it exists
  if (existingPersonality) {
    input.setValue(existingPersonality);
  }

  const modal = new ModalBuilder()
    .setCustomId('server_personality_modal')
    .setTitle('Server Custom Personality')
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function removeUserPersonality(interaction) {
try {
  const userId = interaction.user.id;
  if (state.userSettings[userId]) {
    delete state.userSettings[userId].customPersonality;
  }
  if (state.customInstructions && state.customInstructions[userId]) {
    delete state.customInstructions[userId]; 
  }
  await saveStateToFile();

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Personality Removed')
    .setDescription('Your custom personality has been removed!');
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
} catch (error) {
  console.error('Error removing user personality:', error);
}
}


async function removeServerPersonality(interaction) {
try {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to remove server personality.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  if (state.serverSettings[guildId]) {
    delete state.serverSettings[guildId].customPersonality;
  }
  if (state.customInstructions && state.customInstructions[guildId]) {
    delete state.customInstructions[guildId];
  }
  await saveStateToFile();

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Server Personality Removed')
    .setDescription('Server custom personality has been removed!');
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
} catch (error) {
  console.error('Error removing server personality:', error);
}
      }


async function showUserEmbedColorModal(interaction) {
  const userId = interaction.user.id;
  const userSettings = state.userSettings[userId] || {};
  const existingColor = userSettings.embedColor || hexColour;

  const input = new TextInputBuilder()
    .setCustomId('color_input')
    .setLabel('Enter Hex Color Code')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('#FF5733 or FF5733')
    .setMinLength(6)
    .setMaxLength(7);

  // Pre-fill with existing color if it exists
  if (existingColor) {
    input.setValue(existingColor);
  }

  const modal = new ModalBuilder()
    .setCustomId('user_embed_color_modal')
    .setTitle('Embed Color Customization')
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function showServerEmbedColorModal(interaction) {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to change server embed color.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }

  const guildId = interaction.guild.id;
  const serverSettings = state.serverSettings[guildId] || {};
  const existingColor = serverSettings.embedColor || hexColour;

  const input = new TextInputBuilder()
    .setCustomId('color_input')
    .setLabel('Enter Hex Color Code')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('#FF5733 or FF5733')
    .setMinLength(6)
    .setMaxLength(7);

  // Pre-fill with existing color if it exists
  if (existingColor) {
    input.setValue(existingColor);
  }

  const modal = new ModalBuilder()
    .setCustomId('server_embed_color_modal')
    .setTitle('Server Embed Color')
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}



async function handleChannelManageSelect(interaction) {
if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🚫 Permission Denied')
    .setDescription('You need "Manage Server" permission to manage channels.');
  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
}

const guildId = interaction.guild.id;
const selectedChannelIds = interaction.values;

if (!state.serverSettings[guildId]) {
  state.serverSettings[guildId] = {};
}

state.serverSettings[guildId].allowedChannels = selectedChannelIds;
await saveStateToFile();

await showChannelManagementMenu(interaction, true);
}

async function handleSetAllChannels(interaction) {
if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🚫 Permission Denied')
    .setDescription('You need "Manage Server" permission to manage channels.');
  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
}

const guildId = interaction.guild.id;
if (!state.serverSettings[guildId]) {
  state.serverSettings[guildId] = {};
}

state.serverSettings[guildId].allowedChannels = [];
await saveStateToFile();

await showChannelManagementMenu(interaction, true);
}

async function toggleContinuousReplyChannel(interaction) {
try {
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('🚫 Permission Denied')
      .setDescription('You need "Manage Server" permission to toggle continuous reply for channels.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }

  const channelId = interaction.channelId;
  if (!state.continuousReplyChannels) {
    state.continuousReplyChannels = {};
  }

  if (state.continuousReplyChannels[channelId]) {
    delete state.continuousReplyChannels[channelId];
    const embed = new EmbedBuilder()
      .setColor(0xFFAA00)
      .setTitle('📢 Continuous Reply Disabled')
      .setDescription(`The bot will no longer reply to all messages in <#${channelId}>.`);
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } else {
    state.continuousReplyChannels[channelId] = true;
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('📢 Continuous Reply Enabled')
      .setDescription(`The bot will now reply to all messages in <#${channelId}> without requiring mentions.`);
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }

  await saveStateToFile();
} catch (error) {
  console.error('Error toggling continuous reply channel:', error);
}
}

async function handleDeleteMessageInteraction(interaction, msgId) {
const userId = interaction.user.id;
const userChatHistory = state.chatHistories[userId];
const channel = interaction.channel;
const message = channel ? (await channel.messages.fetch(msgId).catch(() => false)) : false;

if (userChatHistory) {
  if (userChatHistory[msgId]) {
    delete userChatHistory[msgId];
    await deleteMsg();
  } else {
    try {
      const replyingTo = message ? (message.reference ? (await message.channel.messages.fetch(message.reference.messageId)).author.id : 0) : 0;
      if (userId === replyingTo) {
        await deleteMsg();
      } else {
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('🚫 Not Authorized')
          .setDescription('This button is not meant for you.');
        return interaction.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      console.error('Error checking message ownership:', error);
    }
  }
}

async function deleteMsg() {
  await interaction.message.delete()
    .catch(err => console.error('Error deleting interaction message:', err));

  if (channel && message) {
    message.delete().catch(() => {});
  }
}
}

async function downloadMessage(interaction) {
try {
  const message = interaction.message;
  let textContent = message.content;
  if (!textContent && message.embeds.length > 0) {
    textContent = message.embeds[0].description;
  }

  if (!textContent) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Empty Message')
      .setDescription('The message appears to be empty.');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const filePath = path.join(TEMP_DIR, `message_content_${interaction.id}.txt`);
  await fs.writeFile(filePath, textContent, 'utf8');

  const attachment = new AttachmentBuilder(filePath, {
    name: 'message_content.txt'
  });

  const initialEmbed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('💾 Message Saved')
    .setDescription('The message content has been prepared for download.');

  let response;
  if (interaction.channel.type === ChannelType.DM) {
    response = await interaction.reply({
      embeds: [initialEmbed],
      files: [attachment],
      fetchReply: true
    });
  } else {
    try {
      response = await interaction.user.send({
        embeds: [initialEmbed],
        files: [attachment]
      });
      const dmSentEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ Sent to DMs')
        .setDescription('The message content has been sent to your DMs!');
      await interaction.reply({
        embeds: [dmSentEmbed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      const failDMEmbed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ DM Failed')
        .setDescription('Could not send to DMs. Here is the file:');
      response = await interaction.reply({
        embeds: [failDMEmbed],
        files: [attachment],
        flags: MessageFlags.Ephemeral,
        fetchReply: true
      });
    }
  }

  await fs.unlink(filePath).catch(() => {});

  const msgUrl = await uploadText(textContent);
  const updatedEmbed = EmbedBuilder.from(response.embeds[0])
    .setDescription(`The message content has been saved.\n${msgUrl}`);

  if (interaction.channel.type === ChannelType.DM) {
    await interaction.editReply({
      embeds: [updatedEmbed]
    });
  } else {
    await response.edit({
      embeds: [updatedEmbed]
    });
  }

} catch (error) {
  console.error('Failed to process download:', error);
}
}

const uploadText = async (text) => {
const siteUrl = 'https://bin.mudfish.net';
try {
  const response = await axios.post(`${siteUrl}/api/text`, {
    text: text,
    ttl: 10080
  }, {
    timeout: 3000
  });

  const key = response.data.tid;
  return `\n🔗 URL: ${siteUrl}/t/${key}`;
} catch (error) {
  console.error('Upload text error:', error);
  return '\n❌ URL generation failed';
}
};

async function stopGeneration(interaction) {
const embed = new EmbedBuilder()
  .setColor(0xFFAA00)
  .setTitle('⏹️ Stopping Generation')
  .setDescription('The response generation has been stopped.');
await interaction.reply({
  embeds: [embed],
  flags: MessageFlags.Ephemeral
});
}

async function fetchMessagesForSummary(message, messageLink, count = 1) {
  try {
    const parsed = parseDiscordMessageLink(messageLink);
    if (!parsed) {
      return null;
    }

    const { guildId, channelId, messageId } = parsed;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return { error: "I don't have access to that server." };
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      return { error: "I don't have access to that channel." };
    }

    const permissions = channel.permissionsFor(client.user);
    if (!permissions.has(PermissionsBitField.Flags.ViewChannel) || 
        !permissions.has(PermissionsBitField.Flags.ReadMessageHistory)) {
      return { error: "I don't have permission to read messages in that channel." };
    }

    const startMessage = await channel.messages.fetch(messageId).catch(() => null);
    if (!startMessage) {
      return { error: "Could not find that message. It may have been deleted." };
    }

    let messagesToSummarize = [startMessage];

    if (count > 1) {
      try {
        const messagesToFetch = Math.min(count - 1, 99);
        const halfCount = Math.floor(messagesToFetch / 2);
        
        const [olderMessages, newerMessages] = await Promise.all([
          channel.messages.fetch({
            before: messageId,
            limit: halfCount
          }).catch(() => null),
          channel.messages.fetch({
            after: messageId,
            limit: messagesToFetch - halfCount
          }).catch(() => null)
        ]);

        const sortedOlder = olderMessages ? 
          Array.from(olderMessages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp) : [];
        
        const sortedNewer = newerMessages ? 
          Array.from(newerMessages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp) : [];
        
        messagesToSummarize = [...sortedOlder, startMessage, ...sortedNewer];
      } catch (fetchError) {
        console.error('Error fetching additional messages:', fetchError);
      }
    }

    const formattedMessages = messagesToSummarize.map((msg, index) => {
      let content = `**Message ${index + 1}** - **${msg.author.username}** (${msg.createdAt.toLocaleString()}):\n`;
      
      if (msg.content) {
        content += msg.content;
      }
      
      if (msg.attachments.size > 0) {
        const attachmentList = Array.from(msg.attachments.values())
          .map(att => `[Attachment: ${att.name}]`)
          .join(', ');
        content += `\n${attachmentList}`;
      }
      
      if (msg.embeds.length > 0) {
        content += `\n[Contains ${msg.embeds.length} embed(s)]`;
      }
      
      return content;
    }).join('\n\n---\n\n');

    return {
      success: true,
      content: formattedMessages,
      messageCount: messagesToSummarize.length,
      channelName: channel.name,
      guildName: guild.name
    };

  } catch (error) {
    console.error('Error fetching messages for summary:', error);
    return { error: "An error occurred while fetching the messages." };
  }
}


function extractForwardedContent(message) {
  let forwardedText = '';
  let forwardedAttachments = [];
  let forwardedStickers = [];
  
  if (message.messageSnapshots && message.messageSnapshots.size > 0) {
    const snapshot = message.messageSnapshots.first();
    
    if (snapshot.content) {
      forwardedText = snapshot.content;
    }
    
    if (snapshot.embeds && snapshot.embeds.length > 0) {
      const embedTexts = snapshot.embeds
        .map(embed => {
          let text = '';
          if (embed.title) text += `**${embed.title}**\n`;
          if (embed.description) text += embed.description;
          return text;
        })
        .filter(t => t)
        .join('\n\n');
      
      if (embedTexts) {
        forwardedText += '\n\n' + embedTexts;
      }
    }
    
    if (snapshot.attachments && snapshot.attachments.size > 0) {
      forwardedAttachments = Array.from(snapshot.attachments.values());
    }
    
    // Extract stickers from forwarded message
    if (snapshot.stickers && snapshot.stickers.size > 0) {
      forwardedStickers = Array.from(snapshot.stickers.values());
    }
  }
  
  return { forwardedText, forwardedAttachments, forwardedStickers };
}



// REPLACE your existing processUserQueue function with this:
async function processUserQueue(userId) {
  const userQueueData = requestQueues.get(userId);
  if (!userQueueData) return;

  userQueueData.isProcessing = true;

  while (userQueueData.queue.length > 0) {
    const currentItem = userQueueData.queue[0]; // Get first item

    try {
      // If it is a Command (Search), run the search logic
      if (currentItem.isChatInputCommand && currentItem.isChatInputCommand()) {
        await executeSearchInteraction(currentItem);
      } 
      // Otherwise, it's a normal Message
      else {
        await handleTextMessage(currentItem);
      }
    } catch (error) {
      console.error(`Error processing queued item for ${userId}:`, error);
    } finally {
      userQueueData.queue.shift(); // Remove item from queue
    }
  }

  userQueueData.isProcessing = false;
  requestQueues.delete(userId);
}



async function handleTextMessage(message) {
  const botId = client.user.id;
  const userId = message.author.id;
  const guildId = message.guild?.id;
  const channelId = message.channel.id;
  
  // Clean up the mention from the user's current message
  let messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

  // ==========================================================================================
  // 1. GIF EMBED FIX: Wait for Discord to unfurl Tenor/Giphy embeds
  // ==========================================================================================
  const gifRegex = /https?:\/\/(?:www\.)?(tenor\.com|giphy\.com)/i;
  if (gifRegex.test(messageContent) && (!message.embeds || message.embeds.length === 0)) {
    await delay(1500);
    try {
      message = await message.channel.messages.fetch(message.id);
      messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();
    } catch (e) {}
  }

  // ==========================================================================================
  // 2. ENHANCED REPLY FEATURE (Fixes "Empty Message" & Context Issues)
  // ==========================================================================================
  let repliedMessageText = '';
  let repliedAttachments = [];

  if (message.reference && message.reference.messageId) {
    try {
      // Fetch the original message being replied to
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);

      if (repliedMsg) {
        let contextBuffer = `[Context - Replying to ${repliedMsg.author.username}]:\n`;

        // A. Extract Plain Text
        if (repliedMsg.content) {
          contextBuffer += `${repliedMsg.content}\n`;
        }

        // B. Extract Text from Embeds (Crucial for replying to bots)
        if (repliedMsg.embeds.length > 0) {
          repliedMsg.embeds.forEach((embed, index) => {
            contextBuffer += `[Embed ${index + 1} Content]:\n`;
            if (embed.title) contextBuffer += `Title: ${embed.title}\n`;
            if (embed.description) contextBuffer += `Description: ${embed.description}\n`;
            if (embed.fields && embed.fields.length > 0) {
              embed.fields.forEach(field => {
                contextBuffer += `${field.name}: ${field.value}\n`;
              });
            }
          });
        }

        // C. Extract Attachments (Images/Files) from the parent message
        if (repliedMsg.attachments.size > 0) {
          repliedAttachments = Array.from(repliedMsg.attachments.values());
          contextBuffer += `[Contains ${repliedMsg.attachments.size} attachment(s)]\n`;
        }

        // D. Extract Stickers from the parent message
        if (repliedMsg.stickers.size > 0) {
           repliedMsg.stickers.forEach(sticker => {
             contextBuffer += `[Sticker: ${sticker.name}]\n`;
           });
        }

        repliedMessageText = contextBuffer + "\n" + "-".repeat(20) + "\n";
      }
    } catch (error) {
      console.error("Error processing reply context:", error);
    }
  }

  // Combine Reply Context + User's Current Message
  if (repliedMessageText) {
    // If messageContent is empty (user just posted an image), label it cleanly
    const userText = messageContent ? messageContent : "[No text provided in reply, only attachments/interaction]";
    messageContent = `${repliedMessageText}[User's Response]:\n${userText}`;
  }

  // ==========================================================================================
  // GIF LINK PROCESSING
  // ==========================================================================================
  const gifLinks = [];
  const tenorGiphyRegex = /https?:\/\/(?:www\.)?(tenor\.com\/view\/[^\s]+|giphy\.com\/gifs\/[^\s]+|media\.tenor\.com\/[^\s]+\.gif|media\.giphy\.com\/media\/[^\s]+\/giphy\.gif)/gi;
  let gifMatch;

  while ((gifMatch = tenorGiphyRegex.exec(messageContent)) !== null) {
    gifLinks.push(gifMatch[0]);
  }

  // Check for GIFs in embeds
  if (message.embeds && message.embeds.length > 0) {
    for (const embed of message.embeds) {
      const isTenor = embed.provider?.name?.toLowerCase() === 'tenor';
      const isGiphy = embed.provider?.name?.toLowerCase() === 'giphy';

      if (isTenor || isGiphy) {
        const mediaUrl = embed.video?.url || embed.video?.proxyURL ||
          embed.image?.url || embed.image?.proxyURL ||
          embed.thumbnail?.url || embed.thumbnail?.proxyURL;

        if (mediaUrl) {
          gifLinks.push(mediaUrl);
          const gifDescription = embed.description || embed.title || embed.url || 'GIF';
          const contextText = `[User sent a ${embed.provider?.name || 'GIF'}${gifDescription !== 'GIF' ? ': ' + gifDescription : ''}]`;
          if (!messageContent.includes(contextText)) {
            messageContent += `\n${contextText}`;
          }
        }
      }
    }
  }

  const gifLinkAttachments = [];
  for (const gifUrl of gifLinks) {
    try {
      let gifName = 'tenor_gif.gif';
      if (gifUrl.includes('tenor.com')) {
        const nameMatch = gifUrl.match(/\/view\/([^\/\-]+)/);
        gifName = nameMatch ? `${nameMatch[1]}.gif` : 'tenor_gif.gif';
      } else if (gifUrl.includes('giphy.com')) {
        const nameMatch = gifUrl.match(/\/gifs\/([^\/\-]+)/);
        gifName = nameMatch ? `${nameMatch[1]}.gif` : 'giphy_gif.gif';
      }

      let directGifUrl = gifUrl;

      if (gifUrl.includes('media.tenor.com') || gifUrl.includes('media.giphy.com')) {
        directGifUrl = gifUrl;
      } else if (gifUrl.includes('tenor.com/view/')) {
        try {
          if (!gifUrl.endsWith('.gif')) {
            directGifUrl = gifUrl + '.gif';
          }
          const testResponse = await axios.head(directGifUrl, {
            timeout: 3000
          }).catch(() => null);
          if (!testResponse || testResponse.status !== 200) {
            const response = await axios.get(gifUrl, {
              timeout: 5000
            });
            const htmlContent = response.data;
            const mp4Match = htmlContent.match(/"url":"(https:\/\/media\.tenor\.com\/[^"]+\.mp4)"/);
            const gifMatch = htmlContent.match(/"url":"(https:\/\/media\.tenor\.com\/[^"]+\.gif)"/);

            if (mp4Match) {
              directGifUrl = mp4Match[1].replace(/\\u002F/g, '/');
            } else if (gifMatch) {
              directGifUrl = gifMatch[1].replace(/\\u002F/g, '/');
            }
          }
        } catch (error) {
          continue;
        }
      } else if (gifUrl.includes('giphy.com/gifs/')) {
        try {
          const response = await axios.get(gifUrl, {
            timeout: 5000
          });
          const htmlContent = response.data;
          const gifMatch = htmlContent.match(/"url":"(https:\/\/media\.giphy\.com\/media\/[^"]+\/giphy\.gif)"/);
          if (gifMatch) {
            directGifUrl = gifMatch[1];
          } else {
            directGifUrl = gifUrl + (gifUrl.endsWith('.gif') ? '' : '.gif');
          }
        } catch (error) {
          continue;
        }
      }

      gifLinkAttachments.push({
        id: `gif-link-${Date.now()}-${Math.random()}`,
        name: gifName,
        url: directGifUrl,
        contentType: 'image/gif',
        size: 0,
        isGifLink: true
      });

      messageContent = messageContent.replace(gifUrl, '').trim();
    } catch (error) {
      console.error('Error processing GIF link:', error);
    }
  }

  // Extract forwarded content
  const {
    forwardedText,
    forwardedAttachments,
    forwardedStickers
  } = extractForwardedContent(message);

  if (forwardedText) {
    if (messageContent === '') {
      messageContent = `[Forwarded message]:\n${forwardedText}`;
    } else {
      messageContent = `${messageContent}\n\n[Forwarded message]:\n${forwardedText}`;
    }
  }

  // Process stickers
  const currentStickers = message.stickers ? Array.from(message.stickers.values()) : [];
  const allStickers = [...currentStickers, ...forwardedStickers];

  const stickerAttachments = [];
  for (const sticker of allStickers) {
    const stickerAttachment = await processStickerAsAttachment(sticker);
    if (stickerAttachment) {
      stickerAttachments.push(stickerAttachment);
      const stickerType = stickerAttachment.isAnimated ? 'Animated Sticker' : 'Sticker';
      if (!messageContent.includes(sticker.name)) {
        messageContent += `\n[${stickerType}: ${sticker.name}]`;
      }
    }
  }

  // Process custom emojis (limit 5)
  const customEmojis = extractCustomEmojis(messageContent);
  const limitedEmojis = customEmojis.slice(0, 5);
  const exceededEmojis = customEmojis.slice(5);

  const emojiAttachments = [];
  if (limitedEmojis.length > 0) {
    for (const emoji of limitedEmojis) {
      const emojiAttachment = await processEmojiAsAttachment(emoji);
      if (emojiAttachment) {
        emojiAttachments.push(emojiAttachment);
      }
    }
  }

  if (exceededEmojis.length > 0) {
    for (const emoji of exceededEmojis) {
      messageContent = messageContent.replace(emoji.fullMatch, `:${emoji.name}:`);
    }
  }

  // ==========================================================================================
  // COMBINE ALL ATTACHMENTS
  // ==========================================================================================
  const regularAttachments = Array.from(message.attachments.values());
  
  const allAttachments = [
    ...repliedAttachments, // Included from the reply logic above
    ...regularAttachments,
    ...forwardedAttachments,
    ...stickerAttachments,
    ...emojiAttachments,
    ...gifLinkAttachments
  ];

    // Ignore polls
  if (message.poll) {
    return;
  }
  if (message.type === 46) {
    return;
  }
  

  // Check for content
  // We check if messageContent has non-whitespace chars OR if there are supported attachments
  const hasAnyContent = messageContent.trim() !== '' ||
    (allAttachments.length > 0 && allAttachments.some(att => {
      const contentType = (att.contentType || "").toLowerCase();
      const fileExtension = path.extname(att.name).toLowerCase();
      const supportedTypes = [
        contentType.startsWith('image/'),
        contentType.startsWith('audio/'),
        contentType.startsWith('video/'),
        contentType.startsWith('application/pdf'),
        ['.mp3', '.wav', '.aiff', '.aac', '.ogg', '.flac', '.m4a'].includes(fileExtension),
        ['.mp4', '.mov', '.mpeg', '.mpg', '.webm', '.avi', '.wmv', '.3gpp', '.flv'].includes(fileExtension),
        ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp'].includes(fileExtension),
        ['.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.tsv', '.pptx', '.rtf', '.html', '.py', '.java', '.js', '.css', '.json', '.xml', '.sql', '.log', '.md'].includes(fileExtension)
      ];
      return supportedTypes.some(t => t);
    }));

  if (!hasAnyContent) {
    
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('💬 Empty Message')
      .setDescription("You didn't provide any content. What would you like to talk about?");
    await message.reply({
      embeds: [embed]
    });
    return;
  }

  message.channel.sendTyping();
  const typingInterval = setInterval(() => {
    message.channel.sendTyping();
  }, 4000);
  setTimeout(() => {
    clearInterval(typingInterval);
  }, 120000);

  let botMessage = null;
  let parts;
  let hasMedia = false;

  try {
    // Process text file extraction (links to other messages)
    messageContent = await extractFileText(message, messageContent);
    
    // Process everything (Prompt + Media from all sources)
    parts = await processPromptAndMediaAttachments(messageContent, message, allAttachments);
    hasMedia = parts.some(part => part.text === undefined);

    } catch (error) {
    console.error('Error initializing message:', error);
    clearInterval(typingInterval);
    return;
  }
  

  const userSettings = state.userSettings[userId] || {};
  const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
  const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;

  let finalInstructions = config.coreSystemRules;
  let customInstructions;
  if (guildId) {
    if (state.channelWideChatHistory[channelId]) {
      customInstructions = state.customInstructions[channelId];
    } else if (serverSettings.customPersonality) {
      customInstructions = serverSettings.customPersonality;
    } else if (effectiveSettings.customPersonality) {
      customInstructions = effectiveSettings.customPersonality;
    } else {
      customInstructions = state.customInstructions[userId];
    }
  } else {
    customInstructions = effectiveSettings.customPersonality || state.customInstructions[userId];
  }

  if (customInstructions) {
    finalInstructions += `\n\nADDITIONAL PERSONALITY:\n${customInstructions}`;
  } else {
    finalInstructions += `\n\n${config.defaultPersonality}`;
  }

  let infoStr = '';
  if (guildId) {
    const userInfo = {
      username: message.author.username,
      displayName: message.author.displayName
    };
    infoStr = `\nYou are currently engaging with users in the ${message.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
  } else {
    const userInfo = {
      username: message.author.username,
      displayName: message.author.displayName
    };
    infoStr = `\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
  }

  finalInstructions += infoStr;

  const isServerChatHistoryEnabled = guildId ? serverSettings.serverChatHistory : false;
  const isChannelChatHistoryEnabled = guildId ? state.channelWideChatHistory[channelId] : false;

  const historyId = isServerChatHistoryEnabled ? guildId : (isChannelChatHistoryEnabled ? channelId : userId);

  const selectedModel = effectiveSettings.selectedModel || 'gemini-2.5-flash';
  const modelName = MODELS[selectedModel];

  const tools = [{
      googleSearch: {}
    },
    {
      urlContext: {}
    }
  ];
  if (!hasMedia) {
    tools.push({
      codeExecution: {}
    });
  }

  const optimizedHistory = await memorySystem.getOptimizedHistory(
    historyId,
    messageContent,
    modelName
  );

  const chat = genAI.chats.create({
    model: modelName,
    config: {
      systemInstruction: finalInstructions,
      ...generationConfig,
      safetySettings,
      tools,
      temperature: effectiveSettings.temperature || generationConfig.temperature,
      topP: effectiveSettings.topP || generationConfig.topP,
    },
    history: optimizedHistory
  });

  await handleModelResponse(botMessage, chat, parts, message, typingInterval, historyId, effectiveSettings);
}
        
              
function hasSupportedAttachments(message) {
const audioExtensions = ['.mp3', '.wav', '.aiff', '.aac', '.ogg', '.flac', '.m4a'];
const documentExtensions = ['.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.tsv', '.pptx', '.rtf', '.html', '.py', '.java', '.js', '.css', '.json', '.xml', '.sql', '.log', '.md'];
const videoExtensions = ['.mp4', '.mov', '.mpeg', '.mpg', '.webm', '.avi', '.wmv', '.3gpp', '.flv'];
const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp'];

return message.attachments.some((attachment) => {
  const contentType = (attachment.contentType || "").toLowerCase();
  const fileExtension = path.extname(attachment.name).toLowerCase();
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType === 'image/gif' ||
    contentType.startsWith('application/pdf') ||
    contentType.startsWith('application/x-pdf') ||
    audioExtensions.includes(fileExtension) ||
    videoExtensions.includes(fileExtension) ||
    imageExtensions.includes(fileExtension) ||
    documentExtensions.includes(fileExtension)
  );
});
}

async function downloadFile(url, filePath) {
const writer = createWriteStream(filePath);
const response = await axios({
  url,
  method: 'GET',
  responseType: 'stream',
});
response.data.pipe(writer);
return new Promise((resolve, reject) => {
  writer.on('finish', resolve);
  writer.on('error', reject);
});
}

function sanitizeFileName(fileName) {
return fileName
  .toLowerCase()
  .replace(/[^a-z0-9.-]/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 100);
}

function parseDiscordMessageLink(url) {
  // Match Discord message link format: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
  const regex = /https?:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
  const match = url.match(regex);
  
  if (match) {
    return {
      guildId: match[1],
      channelId: match[2],
      messageId: match[3]
    };
  }
  return null;
}

async function processPromptAndMediaAttachments(prompt, message, attachments = null) {
  const allAttachments = attachments || Array.from(message.attachments.values());
  
  const limitedAttachments = allAttachments.slice(0, 5);
  
  let parts = [{
    text: prompt
  }];

  if (limitedAttachments.length > 0) {
    for (const attachment of limitedAttachments) {
      try {
        const processedPart = await processAttachment(attachment, message.author.id, message.id);
        if (processedPart) {
          if (Array.isArray(processedPart)) {
            parts.push(...processedPart);
          } else {
            parts.push(processedPart);
          }
        }
      } catch (error) {
        console.error(`Error processing attachment ${attachment.name}:`, error);
        parts.push({
          text: `\n\n[Error processing file: ${attachment.name}]`
        });
      }
    }
  }

  return parts;
}
  

// Helper function to process text files
async function extractFileText(message, messageContent) {
  const discordLinkRegex = /https?:\/\/(?:www\.)?discord\.com\/channels\/\d+\/\d+\/\d+/g;
  const messageLinks = messageContent.match(discordLinkRegex);
  
  if (messageLinks && messageLinks.length > 0) {
    
    
    const patterns = [
      /(?:summarize|summarise|summary).*?(?:around|next|following|from)\s+(\d+)\s+messages?/i,
      /(?:around|next|following|from)\s+(\d+)\s+messages?/i,
      /(\d+)\s+messages?.*?(?:around|after|from)/i,
      /(?:get|fetch|show|read)\s+(\d+)\s+messages?/i
    ];
    
    let messageCount = 1;
    let requestedCount = 1;
    
    for (const pattern of patterns) {
      const match = messageContent.match(pattern);
      if (match && match[1]) {
        requestedCount = parseInt(match[1]);
        messageCount = Math.min(requestedCount, 100);
        break;
      }
    }
    
    if (messageCount === 1 && /messages/i.test(messageContent) && !/\b1\s+message/i.test(messageContent)) {
      messageCount = 10;
      requestedCount = 10;
    }
    
    if (requestedCount > 100) {
      try {
        const warningEmbed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle('⚠️ Message Limit Exceeded')
          .setDescription(`You requested ${requestedCount} messages, but the maximum limit is 100 messages.\n\nI will summarize the available messages around the linked message.`);
        
        await message.reply({
          embeds: [warningEmbed]
        });
      } catch (error) {
        console.error('Error sending limit warning:', error);
      }
    }
    
    console.log(`Fetching ${messageCount} message(s) around link: ${messageLinks[0]}`);
    
    const result = await fetchMessagesForSummary(message, messageLinks[0], messageCount);
    
    if (result.error) {
      messageContent += `\n\n[Error: ${result.error}]`;
    } else if (result.success) {
      const requestInfo = messageCount > 1 
        ? `The user requested ${requestedCount} messages${requestedCount > 100 ? ' (capped at 100)' : ''} and I fetched ${result.messageCount} messages around the linked message.`
        : '';
      
      messageContent += `\n\n[Discord Messages to Summarize from #${result.channelName} in ${result.guildName} (${result.messageCount} message(s))]:\n${requestInfo}\n\n${result.content}`;
    }
  }
  
  if (message.attachments.size > 0) {
    let attachments = Array.from(message.attachments.values());
    messageContent = await processTextFiles(attachments, messageContent, '');
  }
  
  // This is the correct closing part of the extractFileText function
  if (message.messageSnapshots && message.messageSnapshots.size > 0) {
    const snapshot = message.messageSnapshots.first();
    if (snapshot.attachments && snapshot.attachments.size > 0) {
      let forwardedAttachments = Array.from(snapshot.attachments.values());
      messageContent = await processTextFiles(forwardedAttachments, messageContent, '[Forwarded] ');
    }
  }
  
  return messageContent;
} // <-- MUST END HERE

// This is the start of the correctly defined global helper function
async function processTextFiles(attachments, messageContent, prefix = '') {
  for (const attachment of attachments) {
    const fileType = path.extname(attachment.name).toLowerCase();
    const textFileTypes = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.rtf'];

    if (textFileTypes.includes(fileType)) {
      try {
        let fileContent = await downloadAndReadFile(attachment.url, fileType);

        if (fileContent.length <= 1000000) {
          messageContent += `\n\n${prefix}[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent.slice(0, 50000)}\n\`\`\``;
        }
      } catch (error) {
        console.error(`Error reading file ${attachment.name}: ${error.message}`);
      }
    }
  }
  return messageContent;
}

async function downloadAndReadFile(url, fileType) {
switch (fileType) {
  case '.pptx':
  case '.docx':
    const extractor = getTextExtractor();
    return (await extractor.extractText({
      input: url,
      type: 'url'
    }));
  default:
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${response.statusText}`);
    return await response.text();
}
}

async function addDownloadButton(botMessage) {
try {
  const messageComponents = botMessage.components || [];
  const downloadButton = new ButtonBuilder()
    .setCustomId('download_message')
    .setLabel('Save')
    .setEmoji('💾')
    .setStyle(ButtonStyle.Secondary);

  let actionRow;
  if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow) {
    actionRow = ActionRowBuilder.from(messageComponents[0]);
  } else {
    actionRow = new ActionRowBuilder();
  }

  actionRow.addComponents(downloadButton);
  return await botMessage.edit({
    components: [actionRow]
  });
} catch (error) {
  console.error('Error adding download button:', error.message);
  return botMessage;
}
}

async function addDeleteButton(botMessage, msgId) {
try {
  const messageComponents = botMessage.components || [];
  const deleteButton = new ButtonBuilder()
    .setCustomId(`delete_message-${msgId}`)
    .setLabel('Delete')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);

  let actionRow;
  if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow && messageComponents[0].components.length < 5) {
    actionRow = ActionRowBuilder.from(messageComponents[0]);
  } else {
    actionRow = new ActionRowBuilder();
    if (messageComponents.length > 0) {
      const existingComponents = messageComponents[0].components.map(c => ButtonBuilder.from(c));
      actionRow.addComponents(existingComponents);
    }
  }

  if (actionRow.components.length < 5) {
    actionRow.addComponents(deleteButton);
  } else {
    const newRow = new ActionRowBuilder().addComponents(deleteButton);
    return await botMessage.edit({
      components: [actionRow, newRow]
    });
  }

  return await botMessage.edit({
    components: [actionRow]
  });
} catch (error) {
  console.error('Error adding delete button:', error.message);
  return botMessage;
}
}

async function addSettingsButton(botMessage) {
try {
  const settingsButton = new ButtonBuilder()
    .setCustomId('settings_btn')
    .setEmoji('⚙️')
    .setStyle(ButtonStyle.Secondary);

  const actionRow = new ActionRowBuilder().addComponents(settingsButton);
  return await botMessage.edit({
    components: [actionRow]
  });
} catch (error) {
  console.error('Error adding settings button:', error.message);
  return botMessage;
}
}

async function handleModelResponse(initialBotMessage, chat, parts, originalMessage, typingInterval, historyId, effectiveSettings) {
  const userId = originalMessage.author.id;
  const guildId = originalMessage.guild?.id;
  const responseFormat = effectiveSettings.responseFormat || 'Normal';
  const showActionButtons = effectiveSettings.showActionButtons === true;
  
  const continuousReply = effectiveSettings.continuousReply ?? true; // Changed || to ??
  
  const maxCharacterLimit = responseFormat === 'Embedded' ? 3900 : 1900;
  let attempts = 3;

  // CONFIGURATION: Word count threshold for live typing
  const WORD_THRESHOLD = 150;

  let updateTimeout;
  let tempResponse = '';
  let groundingMetadata = null;
  let urlContextMetadata = null;

  // Initialize with whatever was passed (likely null)
  let botMessage = initialBotMessage;

    // Helper to determine if we should Reply (tag) or Send (no tag)
  const shouldForceReply = () => {
    // 1. If Continuous Reply is OFF, always tag
    if (!continuousReply) return true;

    // 2. If chat has moved on (e.g., this is a queued message and newer ones exist), Tag it
    if (guildId && originalMessage.channel.lastMessageId !== originalMessage.id) {
      return true;
    }
    
    // 3. Otherwise, send normally (No tag) for the latest message
    return false;
  };
  

  // Update helper function
  const updateMessage = async () => {
    if (!botMessage) return; 

    try {
      if (tempResponse.trim() === "") {
      } else if (responseFormat === 'Embedded') {
        updateEmbed(botMessage, tempResponse, originalMessage, groundingMetadata, urlContextMetadata, effectiveSettings);
      } else {
        await botMessage.edit({
          content: tempResponse,
          embeds: []
        }).catch(() => {});
      }
    } catch (e) {}
    clearTimeout(updateTimeout);
    updateTimeout = null;
  };

  while (attempts > 0) {
    try {
      let finalResponse = '';
      let isLargeResponse = false;
      const newHistory = [];
      newHistory.push({
        role: 'user',
        content: parts
      });

      const messageResult = await chat.sendMessageStream({
        message: parts
      });

      clearInterval(typingInterval);

      for await (const chunk of messageResult) {
        const chunkText = (chunk.text || (chunk.codeExecutionResult?.output ? `\n\`\`\`py\n${chunk.codeExecutionResult.output}\n\`\`\`\n` : "") || (chunk.executableCode ? `\n\`\`\`\n${chunk.executableCode}\n\`\`\`\n` : ""));

        if (chunkText && chunkText !== '') {
          finalResponse += chunkText;
          tempResponse += chunkText;

          const currentWordCount = tempResponse.trim().split(/\s+/).length;

          // 1. Live Typing Logic
          if (!botMessage && currentWordCount > WORD_THRESHOLD) {
            try {
              if (shouldForceReply()) {
                botMessage = await originalMessage.reply({ content: tempResponse });
              } else {
                botMessage = await originalMessage.channel.send({ content: tempResponse });
              }
            } catch (createErr) {
              console.error("Error creating initial message:", createErr);
              throw createErr;
            }
          }

          // 2. Update existing message
          if (botMessage) {
            if (finalResponse.length > maxCharacterLimit) {
              if (!isLargeResponse) {
                isLargeResponse = true;
                const embed = new EmbedBuilder()
                  .setColor(0xFFAA00)
                  .setTitle('📄 Large Response')
                  .setDescription('The response is too large. It will be sent as a text file once completed.');

                botMessage.edit({ content: ' ', embeds: [embed], components: [] }).catch(() => {});
              }
            } else if (!updateTimeout) {
              updateTimeout = setTimeout(updateMessage, 800);
            }
          }
        }

        if (chunk.candidates && chunk.candidates[0]?.groundingMetadata) {
          groundingMetadata = chunk.candidates[0].groundingMetadata;
        }
        if (chunk.candidates && chunk.candidates[0]?.url_context_metadata) {
          urlContextMetadata = chunk.candidates[0].url_context_metadata;
        }
      }

      clearTimeout(updateTimeout);

      // 3. Fallback for Short Messages
      // We track this with a flag to prevent redundant edits later
      let wasShortResponse = false;
      
      if (!botMessage && finalResponse) {
        wasShortResponse = true; // Mark that we just sent the full message here
        if (shouldForceReply()) {
          botMessage = await originalMessage.reply({ content: finalResponse });
        } else {
          botMessage = await originalMessage.channel.send({ content: finalResponse });
        }
      }

      newHistory.push({
        role: 'assistant',
        content: [{ text: finalResponse }]
      });

      // Final update
      if (botMessage) {
        if (!isLargeResponse && responseFormat === 'Embedded') {
          // For Embeds, we always update because we might need to add metadata/convert text to embed
          updateEmbed(botMessage, finalResponse, originalMessage, groundingMetadata, urlContextMetadata, effectiveSettings);
        } else if (!isLargeResponse && !wasShortResponse) { 
          // ✅ FIX: Only edit Normal messages if they were streaming (long).
          // If wasShortResponse is true, we JUST sent the exact text above, so we skip this edit.
          await botMessage.edit({
            content: finalResponse.slice(0, 2000),
            embeds: []
          }).catch(() => {});
        }
      }

      if (isLargeResponse && botMessage) {
        botMessage = await sendAsTextFile(finalResponse, originalMessage, botMessage.id, continuousReply);
      }

      if (showActionButtons && botMessage && !isLargeResponse) {
        botMessage = await addDownloadButton(botMessage);
        botMessage = await addDeleteButton(botMessage, botMessage.id);
      }

      if (newHistory.length > 1 && botMessage) {
        await chatHistoryLock.runExclusive(async () => {
          const username = originalMessage.author.username;
          const displayName = originalMessage.author.displayName;
          updateChatHistory(historyId, newHistory, botMessage.id, username, displayName);
          await saveStateToFile();
        });
      }
      break;

    } catch (error) {
      console.error('Generation attempt failed:', error);
      attempts--;
      clearInterval(typingInterval);
      clearTimeout(updateTimeout);

      

      if (attempts === 0) {
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('❌ Generation Failed')
          .setDescription('All generation attempts failed. Please try again later.');
        try {
          if (shouldForceReply()) await originalMessage.reply({ embeds: [embed] });
          else await originalMessage.channel.send({ embeds: [embed] });
        } catch (e) {}
        break;
      } else {
        await delay(1500);
      }
    }
  }

    // Queue processor handles cleanup now
}   


function updateEmbed(botMessage, finalResponse, message, groundingMetadata = null, urlContextMetadata = null, effectiveSettings) {
try {
  const isGuild = message.guild !== null;
  const embedColor = effectiveSettings.embedColor || hexColour;
  const continuousReply = effectiveSettings.continuousReply || false;

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setDescription(finalResponse.slice(0, 4096))
    .setTimestamp();

  if (!continuousReply) {
    embed.setAuthor({
      name: `To ${message.author.displayName}`,
      iconURL: message.author.displayAvatarURL()
    });
  }

  if (groundingMetadata && effectiveSettings.responseFormat === 'Embedded') {
    addGroundingMetadataToEmbed(embed, groundingMetadata);
  }

  if (urlContextMetadata && effectiveSettings.responseFormat === 'Embedded') {
    addUrlContextMetadataToEmbed(embed, urlContextMetadata);
  }

  if (isGuild) {
    embed.setFooter({
      text: message.guild.name,
      iconURL: message.guild.iconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
    });
  }

  botMessage.edit({
    content: ' ',
    embeds: [embed],
    components: [] // Clear components (like 'Stop')
  }).catch(() => {});
} catch (error) {
  console.error("Error updating embed:", error.message);
}
}

function addGroundingMetadataToEmbed(embed, groundingMetadata) {
try {
  if (groundingMetadata.webSearchQueries && groundingMetadata.webSearchQueries.length > 0) {
    embed.addFields({
      name: '🔍 Search Queries',
      value: groundingMetadata.webSearchQueries.slice(0, 3).map(query => `• ${query}`).join('\n'),
      inline: false
    });
  }

  if (groundingMetadata.groundingChunks && groundingMetadata.groundingChunks.length > 0) {
    const chunks = groundingMetadata.groundingChunks
      .slice(0, 5)
      .map((chunk, index) => {
        if (chunk.web) {
          return `• [${chunk.web.title || 'Source'}](${chunk.web.uri})`;
        }
        return `• Source ${index + 1}`;
      })
      .join('\n');

    embed.addFields({
      name: '📚 Sources',
      value: chunks,
      inline: false
    });
  }
} catch (error) {
  console.error('Error adding grounding metadata:', error);
}
}

function addUrlContextMetadataToEmbed(embed, urlContextMetadata) {
try {
  if (urlContextMetadata.url_metadata && urlContextMetadata.url_metadata.length > 0) {
    const urlList = urlContextMetadata.url_metadata
      .slice(0, 3)
      .map(urlData => {
        const emoji = urlData.url_retrieval_status === 'URL_RETRIEVAL_STATUS_SUCCESS' ? '✅' : '❌';
        return `${emoji} ${urlData.retrieved_url}`;
      })
      .join('\n');

    embed.addFields({
      name: '🔗 URL Context',
      value: urlList,
      inline: false
    });
  }
} catch (error) {
  console.error('Error adding URL context metadata:', error);
}
}

async function sendAsTextFile(text, messageOrInteraction, orgId, continuousReply = false) {
try {
  const filename = `response-${Date.now()}.txt`;
  const tempFilePath = path.join(TEMP_DIR, filename);
  await fs.writeFile(tempFilePath, text);

  const userId = messageOrInteraction.user?.id || messageOrInteraction.author?.id;
  const channel = messageOrInteraction.channel;

  if (!userId || !channel) {
    throw new Error("Could not determine user or channel.");
  }

  const isInteraction = !!messageOrInteraction.isInteraction;

  let botMessage;
  const mention = isInteraction ? `<@${userId}>, ` : (continuousReply ? '' : `<@${userId}>, `);
  const content = `${mention}Here is the response:`;

  if (isInteraction) {
    // This is an interaction, edit the original deferred reply
    botMessage = await messageOrInteraction.editReply({
      content: content,
      files: [tempFilePath],
      embeds: [],
      components: []
    });
  } else {
    // This is a regular message, fetch and edit the bot's message
    let messageToEdit = await channel.messages.fetch(orgId).catch(() => null);
    if (messageToEdit) {
      botMessage = await messageToEdit.edit({
        content: content,
        files: [tempFilePath],
        embeds: [],
        components: []
      });
    } else {
      // Fallback if original message was deleted
      botMessage = await channel.send({
        content: content,
        files: [tempFilePath]
      });
    }
  }

  await fs.unlink(tempFilePath).catch(() => {});
  return botMessage; // Return the message that was sent/edited
} catch (error) {
  console.error('Error sending as text file:', error);
  // Try to clean up file even if sending failed
  await fs.unlink(path.join(TEMP_DIR, `response-${Date.now()}.txt`)).catch(() => {});
  // Return null or throw to indicate failure
  return null;
}
}

async function handleImagineCommand(interaction) {
  try {
    const userId = interaction.user.id;
    const prompt = interaction.options.getString('prompt');
    const modelName = config.imageConfig?.modelName || 'gemini-2.0-flash-exp';

    // 1. Check Rate Limits
    const limitCheck = checkImageRateLimit(userId);
    if (!limitCheck.allowed) {
      return interaction.reply({
        content: limitCheck.message,
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply();

    // 2. Generate Content (Text + Image)
    // Gemini 2.0 Flash requires 'TEXT' to be included in responseModalities
    // It cannot generate *only* an image in this mode.
    const response = await genAI.models.generateContent({
      model: modelName,
      contents: [
        {
          role: 'user',
          parts: [
            { text: "Generate an image based on this prompt: " + prompt }
          ]
        }
      ],
      config: {
        responseModalities: ['TEXT', 'IMAGE'] 
      }
    });

    // 3. Extract Image Data
    const parts = response.candidates?.[0]?.content?.parts;
    let imageBuffer = null;
    let textResponse = "";

    if (parts) {
      for (const part of parts) {
        if (part.inlineData && part.inlineData.mimeType.startsWith('image/')) {
          imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        } else if (part.text) {
          textResponse += part.text;
        }
      }
    }

    if (!imageBuffer) {
        // If no image was generated, it might be a refusal or just text output
        if (textResponse) {
            throw new Error(`The model responded with text only: "${textResponse.slice(0, 200)}..."`);
        }
        throw new Error("No image data received from model.");
    }

    const attachment = new AttachmentBuilder(imageBuffer, { name: `imagine_${interaction.id}.png` });

    // 4. Update Usage
    incrementImageUsage(userId);
    await saveStateToFile();

    // 5. Send Response
    const embed = new EmbedBuilder()
      .setColor(config.hexColour)
      .setTitle('🎨 Image Generated')
      .setDescription(`**Prompt:** ${prompt}`)
      .setImage(`attachment://imagine_${interaction.id}.png`)
      .setFooter({ text: `Gemini 2.0 Flash • Usage: ${state.imageUsage[userId].count}/${config.imageConfig?.maxPerDay || 10} today` });

    await interaction.editReply({
      embeds: [embed],
      files: [attachment]
    });

    // 6. Update Chat History
    const guildId = interaction.guild?.id;
    const channelId = interaction.channelId;
    const isServerHistory = guildId && state.serverSettings[guildId]?.serverChatHistory;
    const isChannelHistory = state.channelWideChatHistory[channelId];
    const historyId = isServerHistory ? guildId : (isChannelHistory ? channelId : userId);

    const historyEntry = [
      {
        role: 'user',
        parts: [{ text: `/imagine prompt: ${prompt}` }]
      },
      {
        role: 'model',
        parts: [{ text: `[System: I successfully generated an image based on the user's prompt: "${prompt}".]` }]
      }
    ];

    await chatHistoryLock.runExclusive(async () => {
      updateChatHistory(historyId, historyEntry, interaction.id, interaction.user.username, interaction.member?.displayName);
      await saveStateToFile();
    });

  } catch (error) {
    console.error('Error in imagine command:', error);
    
    let errorTitle = '❌ Generation Failed';
    let errorDesc = `Failed to generate image: ${error.message}`;

    if (error.status === 429 || (error.message && error.message.includes('429'))) {
        errorTitle = '⏳ Quota Exceeded';
        errorDesc = 'The AI model is currently overloaded. Please try again later.';
    } else if (error.status === 404) {
        errorTitle = '❌ Model Not Found';
        errorDesc = `The configured model (${modelName}) is not available for your API key.`;
    } else if (error.status === 400) {
        errorTitle = '⚠️ Bad Request';
        errorDesc = `Model configuration error: ${error.message}`;
    }

    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle(errorTitle)
      .setDescription(errorDesc);
    
    if (interaction.deferred) {
      await interaction.editReply({ embeds: [errorEmbed] });
    } else {
      await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
    }
  }
      }
    


client.login(token);











