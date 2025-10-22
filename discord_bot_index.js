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

import config from './config.js';
import {
  client,
  genAI,
  createPartFromUri,
  token,
  activeRequests,
  chatHistoryLock,
  state,
  TEMP_DIR,
  initialize,
  saveStateToFile,
  getHistory,
  updateChatHistory,
  getUserResponsePreference,
  initializeBlacklistForGuild
} from './botManager.js';

initialize().catch(console.error);

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
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite'
};

const safetySettings = [{
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
const defaultPersonality = config.defaultPersonality;
const workInDMs = config.workInDMs;

import {
  delay,
  retryOperation,
} from './tools/others.js';

import {
  commands
} from './commands.js';

let activityIndex = 0;
client.once('ready', async () => {
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
    }

    const userSettings = state.userSettings[userId] || {};
    const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
    const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;
    const continuousReply = effectiveSettings.continuousReply || false;
    const channelContinuousReply = state.continuousReplyChannels?.[channelId] || false;

    const shouldRespond = (
      workInDMs && isDM ||
      state.alwaysRespondChannels[channelId] ||
      channelContinuousReply ||
      (message.mentions.users.has(client.user.id) && !isDM) ||
      state.activeUsersInChannels[channelId]?.[userId]
    );

    if (shouldRespond) {
      if (activeRequests.has(userId)) {
        const embed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle('⏳ Request In Progress')
          .setDescription('Please wait until your previous request is complete.');
        await message.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });
      } else {
        activeRequests.add(userId);
        await handleTextMessage(message);
      }
    }
  } catch (error) {
    console.error('Error processing the message:', error);
    if (activeRequests.has(message.author.id)) {
      activeRequests.delete(message.author.id);
    }
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
    } else if (interaction.isStringSelectMenu()) {
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
    search: handleSearchCommand
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
    await interaction.deferReply();

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

    let parts = [];
    if (prompt) {
      parts.push({
        text: prompt
      });
    }

    if (attachment) {
      const contentType = (attachment.contentType || "").toLowerCase();
      const fileExtension = path.extname(attachment.name) || '';
      const supportedFileExtensions = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

      if (contentType.startsWith('image/') || contentType.startsWith('audio/') || contentType.startsWith('video/') || contentType.startsWith('application/pdf') || contentType.startsWith('application/x-pdf')) {
        const sanitizedFileName = sanitizeFileName(attachment.name);
        const uniqueTempFilename = `${interaction.user.id}-${attachment.id}-${sanitizedFileName}`;
        const filePath = path.join(TEMP_DIR, uniqueTempFilename);

        try {
          await downloadFile(attachment.url, filePath);
          const uploadResult = await genAI.files.upload({
            file: filePath,
            config: {
              mimeType: attachment.contentType,
              displayName: sanitizedFileName,
            }
          });

          const name = uploadResult.name;
          if (name === null) {
            throw new Error(`Unable to extract file name from upload result.`);
          }

          if (attachment.contentType.startsWith('video/')) {
            let file = await genAI.files.get({
              name: name
            });
            while (file.state === 'PROCESSING') {
              process.stdout.write(".");
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              file = await genAI.files.get({
                name: name
              });
            }
            if (file.state === 'FAILED') {
              throw new Error(`Video processing failed for ${sanitizedFileName}.`);
            }
          }

          parts.push(createPartFromUri(uploadResult.uri, uploadResult.mimeType));
          await fs.unlink(filePath);
        } catch (error) {
          console.error(`Error processing attachment ${sanitizedFileName}:`, error);
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('❌ Processing Error')
            .setDescription(`Failed to process the attachment: ${error.message}`);
          return interaction.editReply({
            embeds: [embed]
          });
        }
      } else if (supportedFileExtensions.includes(fileExtension)) {
        try {
          let fileContent = await downloadAndReadFile(attachment.url, fileExtension);
          parts.push({
            text: `\n\n[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent}\n\`\`\``
          });
        } catch (error) {
          console.error(`Error reading file ${attachment.name}: ${error.message}`);
        }
      } else {
        const embed = new EmbedBuilder()
          .setColor(0xFF5555)
          .setTitle('❌ Unsupported File Type')
          .setDescription('The file type you provided is not supported.');
        return interaction.editReply({
          embeds: [embed]
        });
      }
    }

    const userId = interaction.user.id;
    const guildId = interaction.guild?.id;
    const channelId = interaction.channelId;

    const userSettings = state.userSettings[userId] || {};
    const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
    const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;

    const selectedModel = effectiveSettings.selectedModel || 'gemini-2.5-flash';
    const modelName = MODELS[selectedModel];
    const instructions = effectiveSettings.customPersonality || state.customInstructions[userId] || defaultPersonality;

    let infoStr = '';
    if (guildId) {
      const userInfo = {
        username: interaction.user.username,
        displayName: interaction.user.displayName
      };
      infoStr = `\nYou are currently engaging with users in the ${interaction.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
    }

    const isServerChatHistoryEnabled = guildId ? state.serverSettings[guildId]?.serverChatHistory : false;
    const isChannelChatHistoryEnabled = guildId ? state.channelWideChatHistory[channelId] : false;
    const finalInstructions = isServerChatHistoryEnabled ? instructions + infoStr : instructions;
    const historyId = isChannelChatHistoryEnabled ? (isServerChatHistoryEnabled ? guildId : channelId) : userId;

    const tools = [{
        googleSearch: {}
      },
      {
        urlContext: {}
      },
      {
        codeExecution: {}
      }
    ];

    const chat = genAI.chats.create({
      model: modelName,
      config: {
        systemInstruction: {
          role: "system",
          parts: [{
            text: finalInstructions
          }]
        },
        ...generationConfig,
        safetySettings,
        tools
      },
      history: getHistory(historyId)
    });

    let finalResponse = '';
    const newHistory = [];
    newHistory.push({
      role: 'user',
      content: parts
    });

    try {
      const messageResult = await chat.sendMessageStream({
        message: parts
      });
      for await (const chunk of messageResult) {
        const chunkText = (chunk.text || (chunk.codeExecutionResult?.output ? `\n\`\`\`py\n${chunk.codeExecutionResult.output}\n\`\`\`\n` : "") || (chunk.executableCode ? `\n\`\`\`\n${chunk.executableCode}\n\`\`\`\n` : ""));
        if (chunkText && chunkText !== '') {
          finalResponse += chunkText;
        }
      }

      newHistory.push({
        role: 'assistant',
        content: [{
          text: finalResponse
        }]
      });

      await chatHistoryLock.runExclusive(async () => {
        updateChatHistory(historyId, newHistory, interaction.id);
        await saveStateToFile();
      });

      const responseFormat = effectiveSettings.responseFormat || 'Normal';
      if (responseFormat === 'Embedded') {
        const embedColor = effectiveSettings.embedColor || hexColour;
        const embed = new EmbedBuilder()
          .setColor(embedColor)
          .setDescription(finalResponse)
          .setAuthor({
            name: `To ${interaction.user.displayName}`,
            iconURL: interaction.user.displayAvatarURL()
          })
          .setTimestamp();

        if (guildId) {
          embed.setFooter({
            text: interaction.guild.name,
            iconURL: interaction.guild.iconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
          });
        }

        await interaction.editReply({
          embeds: [embed]
        });
      } else {
        await interaction.editReply({
          content: finalResponse
        });
      }
    } catch (error) {
      console.error('Error generating response:', error);
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Generation Error')
        .setDescription(`Failed to generate response: ${error.message}`);
      await interaction.editReply({
        embeds: [embed]
      });
    }
  } catch (error) {
    console.error('Error in search command:', error);
    if (interaction.deferred) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Command Error')
        .setDescription('An error occurred while processing your search request.');
      await interaction.editReply({
        embeds: [embed]
      });
    }
  }
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
    'user_settings': showUserSettings,
    'server_settings': showServerSettings,
    'back_to_main': showMainSettings,
    'back_to_user': showUserSettings,
    'back_to_server': showServerSettings,
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
    'download_message': downloadMessage,
    'settings_btn': showMainSettings,
    'stopGenerating': stopGeneration,
  };

  for (const [key, handler] of Object.entries(buttonHandlers)) {
    if (interaction.customId.startsWith(key)) {
      await handler(interaction);
      return;
    }
  }

  if (interaction.customId.startsWith('delete_message-')) {
    const msgId = interaction.customId.replace('delete_message-', '');
    await handleDeleteMessageInteraction(interaction, msgId);
  }
}

async function handleSelectMenuInteraction(interaction) {
  if (!interaction.isStringSelectMenu()) return;

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
    await showUserSettings(interaction, true);
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
    await showServerSettings(interaction, true);
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
    
    // Don't show separate notification, just update the settings panel
    await showServerSettings(interaction, true);
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
    await showServerSettings(interaction, true);
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
      .addFields(
        {
          name: '👤 User Settings',
          value: 'Configure your personal bot preferences',
          inline: true
        }
      )
      .setTimestamp();

    if (hasManageServer) {
      embed.addFields({
        name: '🏰 Server Settings',
        value: 'Manage server-wide bot configuration',
        inline: true
      });
    }

    if (isUpdate) {
      await interaction.update({
        embeds: [embed],
        components: [row]
      });
    } else {
      await interaction.reply({
        embeds: [embed],
        components: [row],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error('Error showing main settings:', error);
  }
}

async function showUserSettings(interaction, isUpdate = false) {
  try {
    const userId = interaction.user.id;
    const userSettings = state.userSettings[userId] || {};

    const selectedModel = userSettings.selectedModel || 'gemini-2.5-flash';
    const responseFormat = userSettings.responseFormat || 'Normal';
    const showActionButtons = userSettings.showActionButtons !== false;
    const continuousReply = userSettings.continuousReply || false;
    const embedColor = userSettings.embedColor || hexColour;
    const hasPersonality = !!userSettings.customPersonality;

    const modelSelect = new StringSelectMenuBuilder()
      .setCustomId('user_model_select')
      .setPlaceholder('Select AI Model')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Gemini 2.0 Flash')
          .setDescription('Fast and efficient model')
          .setValue('gemini-2.0-flash')
          .setEmoji('⚡')
          .setDefault(selectedModel === 'gemini-2.0-flash'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Gemini 2.5 Flash')
          .setDescription('Balanced performance')
          .setValue('gemini-2.5-flash')
          .setEmoji('🔥')
          .setDefault(selectedModel === 'gemini-2.5-flash'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Gemini 2.5 Flash Lite')
          .setDescription('Lightweight and quick')
          .setValue('gemini-2.5-flash-lite')
          .setEmoji('💨')
          .setDefault(selectedModel === 'gemini-2.5-flash-lite')
      );

    const responseFormatSelect = new StringSelectMenuBuilder()
      .setCustomId('user_response_format')
      .setPlaceholder('Response Format')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Normal')
          .setDescription('Plain text responses')
          .setValue('Normal')
          .setEmoji('📝')
          .setDefault(responseFormat === 'Normal'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Embedded')
          .setDescription('Rich embed responses')
          .setValue('Embedded')
          .setEmoji('📊')
          .setDefault(responseFormat === 'Embedded')
      );

    const actionButtonsSelect = new StringSelectMenuBuilder()
      .setCustomId('user_action_buttons')
      .setPlaceholder('Action Buttons')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Show Buttons')
          .setDescription('Display Stop/Save/Delete buttons')
          .setValue('show')
          .setEmoji('✅')
          .setDefault(showActionButtons),
        new StringSelectMenuOptionBuilder()
          .setLabel('Hide Buttons')
          .setDescription('Hide action buttons')
          .setValue('hide')
          .setEmoji('❌')
          .setDefault(!showActionButtons)
      );

    const continuousReplySelect = new StringSelectMenuBuilder()
      .setCustomId('user_continuous_reply')
      .setPlaceholder('Continuous Reply')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Enabled')
          .setDescription('Bot replies without mentions')
          .setValue('enabled')
          .setEmoji('🔄')
          .setDefault(continuousReply),
        new StringSelectMenuOptionBuilder()
          .setLabel('Disabled')
          .setDescription('Bot requires mentions')
          .setValue('disabled')
          .setEmoji('⏸️')
          .setDefault(!continuousReply)
      );

    const buttons1 = [
      new ButtonBuilder()
        .setCustomId('user_custom_personality')
        .setLabel('Custom Personality')
        .setEmoji('🎭')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('user_remove_personality')
        .setLabel('Remove Personality')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!hasPersonality),
      new ButtonBuilder()
        .setCustomId('user_embed_color')
        .setLabel('Embed Color')
        .setEmoji('🎨')
        .setStyle(ButtonStyle.Secondary)
    ];

    const buttons2 = [
      new ButtonBuilder()
        .setCustomId('clear_user_memory')
        .setLabel('Clear Memory')
        .setEmoji('🧹')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('download_user_conversation')
        .setLabel('Download History')
        .setEmoji('💾')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('back_to_main')
        .setLabel('Back')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(modelSelect),
      new ActionRowBuilder().addComponents(responseFormatSelect),
      new ActionRowBuilder().addComponents(actionButtonsSelect),
      new ActionRowBuilder().addComponents(continuousReplySelect),
      new ActionRowBuilder().addComponents(...buttons1.slice(0, 3)),
      new ActionRowBuilder().addComponents(...buttons2)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('👤 User Settings')
      .setDescription('Configure your personal bot preferences')
      .addFields(
        {
          name: '🤖 Current Model',
          value: `\`${selectedModel}\``,
          inline: true
        },
        {
          name: '📋 Response Format',
          value: `\`${responseFormat}\``,
          inline: true
        },
        {
          name: '🔘 Action Buttons',
          value: `\`${showActionButtons ? 'Visible' : 'Hidden'}\``,
          inline: true
        },
        {
          name: '🔄 Continuous Reply',
          value: `\`${continuousReply ? 'Enabled' : 'Disabled'}\``,
          inline: true
        },
        {
          name: '🎨 Embed Color',
          value: `\`${embedColor}\``,
          inline: true
        },
        {
          name: '🎭 Custom Personality',
          value: `\`${hasPersonality ? 'Active' : 'Not Set'}\``,
          inline: true
        }
      )
      .setFooter({
        text: 'Use the dropdowns and buttons to customize your experience'
      })
      .setTimestamp();

    if (isUpdate) {
      await interaction.update({
        embeds: [embed],
        components: components
      });
    } else {
      await interaction.reply({
        embeds: [embed],
        components: components,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error('Error showing user settings:', error);
  }
}

async function showServerSettings(interaction, isUpdate = false) {
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

    const selectedModel = serverSettings.selectedModel || 'gemini-2.5-flash';
    const responseFormat = serverSettings.responseFormat || 'Normal';
    const showActionButtons = serverSettings.showActionButtons !== false;
    const continuousReply = serverSettings.continuousReply || false;
    const embedColor = serverSettings.embedColor || hexColour;
    const hasPersonality = !!serverSettings.customPersonality;
    const overrideUserSettings = serverSettings.overrideUserSettings || false;
    const serverChatHistory = serverSettings.serverChatHistory || false;

    const modelSelect = new StringSelectMenuBuilder()
      .setCustomId('server_model_select')
      .setPlaceholder('Select AI Model')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Gemini 2.0 Flash')
          .setDescription('Fast and efficient model')
          .setValue('gemini-2.0-flash')
          .setEmoji('⚡')
          .setDefault(selectedModel === 'gemini-2.0-flash'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Gemini 2.5 Flash')
          .setDescription('Balanced performance')
          .setValue('gemini-2.5-flash')
          .setEmoji('🔥')
          .setDefault(selectedModel === 'gemini-2.5-flash'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Gemini 2.5 Flash Lite')
          .setDescription('Lightweight and quick')
          .setValue('gemini-2.5-flash-lite')
          .setEmoji('💨')
          .setDefault(selectedModel === 'gemini-2.5-flash-lite')
      );

    const responseFormatSelect = new StringSelectMenuBuilder()
      .setCustomId('server_response_format')
      .setPlaceholder('Response Format')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Normal')
          .setDescription('Plain text responses')
          .setValue('Normal')
          .setEmoji('📝')
          .setDefault(responseFormat === 'Normal'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Embedded')
          .setDescription('Rich embed responses')
          .setValue('Embedded')
          .setEmoji('📊')
          .setDefault(responseFormat === 'Embedded')
      );

    const actionButtonsSelect = new StringSelectMenuBuilder()
      .setCustomId('server_action_buttons')
      .setPlaceholder('Action Buttons')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Show Buttons')
          .setDescription('Display Stop/Save/Delete buttons')
          .setValue('show')
          .setEmoji('✅')
          .setDefault(showActionButtons),
        new StringSelectMenuOptionBuilder()
          .setLabel('Hide Buttons')
          .setDescription('Hide action buttons')
          .setValue('hide')
          .setEmoji('❌')
          .setDefault(!showActionButtons)
      );

    const continuousReplySelect = new StringSelectMenuBuilder()
      .setCustomId('server_continuous_reply')
      .setPlaceholder('Continuous Reply')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Enabled')
          .setDescription('Bot replies without mentions')
          .setValue('enabled')
          .setEmoji('🔄')
          .setDefault(continuousReply),
        new StringSelectMenuOptionBuilder()
          .setLabel('Disabled')
          .setDescription('Bot requires mentions')
          .setValue('disabled')
          .setEmoji('⏸️')
          .setDefault(!continuousReply)
      );

    const overrideSelect = new StringSelectMenuBuilder()
      .setCustomId('server_override')
      .setPlaceholder('Override User Settings')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Enabled')
          .setDescription('Server settings override user settings')
          .setValue('enabled')
          .setEmoji('🔒')
          .setDefault(overrideUserSettings),
        new StringSelectMenuOptionBuilder()
          .setLabel('Disabled')
          .setDescription('Users can use their own settings')
          .setValue('disabled')
          .setEmoji('🔓')
          .setDefault(!overrideUserSettings)
      );

    const chatHistorySelect = new StringSelectMenuBuilder()
      .setCustomId('server_chat_history')
      .setPlaceholder('Server-Wide Chat History')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Enabled')
          .setDescription('Share chat history across server')
          .setValue('enabled')
          .setEmoji('📚')
          .setDefault(serverChatHistory),
        new StringSelectMenuOptionBuilder()
          .setLabel('Disabled')
          .setDescription('Individual user histories')
          .setValue('disabled')
          .setEmoji('📖')
          .setDefault(!serverChatHistory)
      );

    const buttons1 = [
      new ButtonBuilder()
        .setCustomId('server_custom_personality')
        .setLabel('Custom Personality')
        .setEmoji('🎭')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('server_remove_personality')
        .setLabel('Remove Personality')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!hasPersonality),
      new ButtonBuilder()
        .setCustomId('server_embed_color')
        .setLabel('Embed Color')
        .setEmoji('🎨')
        .setStyle(ButtonStyle.Secondary)
    ];

    const buttons2 = [
      new ButtonBuilder()
        .setCustomId('clear_server_memory')
        .setLabel('Clear Memory')
        .setEmoji('🧹')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('download_server_conversation')
        .setLabel('Download History')
        .setEmoji('💾')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('toggle_continuous_reply')
        .setLabel('Channel Continuous')
        .setEmoji('📢')
        .setStyle(ButtonStyle.Primary)
    ];

    const buttons3 = [
      new ButtonBuilder()
        .setCustomId('back_to_main')
        .setLabel('Back')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary)
    ];

    const components = [
      new ActionRowBuilder().addComponents(modelSelect),
      new ActionRowBuilder().addComponents(responseFormatSelect),
      new ActionRowBuilder().addComponents(actionButtonsSelect),
      new ActionRowBuilder().addComponents(continuousReplySelect),
      new ActionRowBuilder().addComponents(overrideSelect),
      new ActionRowBuilder().addComponents(chatHistorySelect),
      new ActionRowBuilder().addComponents(...buttons1),
      new ActionRowBuilder().addComponents(...buttons2),
      new ActionRowBuilder().addComponents(...buttons3)
    ];

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🏰 Server Settings')
      .setDescription('Configure server-wide bot preferences')
      .addFields(
        {
          name: '🤖 Current Model',
          value: `\`${selectedModel}\``,
          inline: true
        },
        {
          name: '📋 Response Format',
          value: `\`${responseFormat}\``,
          inline: true
        },
        {
          name: '🔘 Action Buttons',
          value: `\`${showActionButtons ? 'Visible' : 'Hidden'}\``,
          inline: true
        },
        {
          name: '🔄 Continuous Reply',
          value: `\`${continuousReply ? 'Enabled' : 'Disabled'}\``,
          inline: true
        },
        {
          name: '🎨 Embed Color',
          value: `\`${embedColor}\``,
          inline: true
        },
        {
          name: '🎭 Custom Personality',
          value: `\`${hasPersonality ? 'Active' : 'Not Set'}\``,
          inline: true
        },
        {
          name: '🔒 Override User Settings',
          value: `\`${overrideUserSettings ? 'Enabled' : 'Disabled'}\``,
          inline: true
        },
        {
          name: '📚 Server Chat History',
          value: `\`${serverChatHistory ? 'Enabled' : 'Disabled'}\``,
          inline: true
        }
      )
      .setFooter({
        text: 'Use the dropdowns and buttons to customize server experience'
      })
      .setTimestamp();

    if (isUpdate) {
      await interaction.update({
        embeds: [embed],
        components: components
      });
    } else {
      await interaction.reply({
        embeds: [embed],
        components: components,
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error('Error showing server settings:', error);
  }
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

    const file = new AttachmentBuilder(tempFileName, {
      name: 'conversation_history.txt'
    });

    try {
      await interaction.user.send({
        content: '📥 **Your Conversation History**',
        files: [file]
      });
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ History Sent')
        .setDescription('Your conversation history has been sent to your DMs!');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Delivery Failed')
        .setDescription('Could not send to DMs. Make sure you have DMs enabled.');
      await interaction.reply({
        embeds: [embed],
        files: [file],
        flags: MessageFlags.Ephemeral
      });
    } finally {
      await fs.unlink(tempFileName);
    }
  } catch (error) {
    console.error('Error downloading user conversation:', error);
  }
}

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
    const conversationHistory = getHistory(guildId);

    if (!conversationHistory || conversationHistory.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ No History Found')
        .setDescription('No server-wide conversation history found.');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }

    const conversationText = conversationHistory.map(entry => {
      const role = entry.role === 'user' ? '[User]' : '[Model]';
      const content = entry.parts.map(c => c.text).join('\n');
      return `${role}:\n${content}\n\n`;
    }).join('');

    const tempFileName = path.join(TEMP_DIR, `server_conversation_${interaction.id}.txt`);
    await fs.writeFile(tempFileName, conversationText, 'utf8');

    const file = new AttachmentBuilder(tempFileName, {
      name: 'server_conversation_history.txt'
    });

    try {
      await interaction.user.send({
        content: '📥 **Server Conversation History**',
        files: [file]
      });
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ History Sent')
        .setDescription('Server conversation history has been sent to your DMs!');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Delivery Failed')
        .setDescription('Could not send to DMs. Make sure you have DMs enabled.');
      await interaction.reply({
        embeds: [embed],
        files: [file],
        flags: MessageFlags.Ephemeral
      });
    } finally {
      await fs.unlink(tempFileName);
    }
  } catch (error) {
    console.error('Error downloading server conversation:', error);
  }
}

async function showUserPersonalityModal(interaction) {
  const input = new TextInputBuilder()
    .setCustomId('personality_input')
    .setLabel("What should the bot's personality be like?")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Enter your custom personality instructions...")
    .setMinLength(10)
    .setMaxLength(4000);

  const modal = new ModalBuilder()
    .setCustomId('user_personality_modal')
    .setTitle('Custom Personality')
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

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

  const input = new TextInputBuilder()
    .setCustomId('personality_input')
    .setLabel("What should the bot's personality be like?")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Enter server custom personality instructions...")
    .setMinLength(10)
    .setMaxLength(4000);

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
      await saveStateToFile();
    }

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
      await saveStateToFile();
    }

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
  const input = new TextInputBuilder()
    .setCustomId('color_input')
    .setLabel('Enter Hex Color Code')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('#FF5733 or FF5733')
    .setMinLength(6)
    .setMaxLength(7);

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

  const input = new TextInputBuilder()
    .setCustomId('color_input')
    .setLabel('Enter Hex Color Code')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('#FF5733 or FF5733')
    .setMinLength(6)
    .setMaxLength(7);

  const modal = new ModalBuilder()
    .setCustomId('server_embed_color_modal')
    .setTitle('Server Embed Color')
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
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
        .setDescription('The bot will no longer reply to all messages in this channel.');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } else {
      state.continuousReplyChannels[channelId] = true;
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('📢 Continuous Reply Enabled')
        .setDescription('The bot will now reply to all messages in this channel without requiring mentions.');
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
        withResponse: true
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
          withResponse: true
        });
      }
    }

    await fs.unlink(filePath);

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

async function handleTextMessage(message) {
  const botId = client.user.id;
  const userId = message.author.id;
  const guildId = message.guild?.id;
  const channelId = message.channel.id;
  let messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

  if (messageContent === '' && !(message.attachments.size > 0 && hasSupportedAttachments(message))) {
    if (activeRequests.has(userId)) {
      activeRequests.delete(userId);
    }
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('💬 Empty Message')
      .setDescription("You didn't provide any content. What would you like to talk about?");
    const botMessage = await message.reply({
      embeds: [embed]
    });
    await addSettingsButton(botMessage);
    return;
  }

  message.channel.sendTyping();
  const typingInterval = setInterval(() => {
    message.channel.sendTyping();
  }, 4000);
  setTimeout(() => {
    clearInterval(typingInterval);
  }, 120000);

  let botMessage = false;
  let parts;

  try {
    clearInterval(typingInterval);
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🤔 Processing')
      .setDescription('Let me think...\n\n📝 Analyzing message...');
    botMessage = await message.reply({
      embeds: [embed]
    });

    messageContent = await extractFileText(message, messageContent);
    embed.setDescription('Let me think...\n\n✅ Text processed\n📎 Checking attachments...');
    await botMessage.edit({
      embeds: [embed]
    });

    parts = await processPromptAndMediaAttachments(messageContent, message);
    embed.setDescription('Let me think...\n\n✅ Text processed\n✅ Attachments ready\n\n⏳ Generating response...');
    await botMessage.edit({
      embeds: [embed]
    });
  } catch (error) {
    console.error('Error initializing message:', error);
    if (activeRequests.has(userId)) {
      activeRequests.delete(userId);
    }
    return;
  }

  const userSettings = state.userSettings[userId] || {};
  const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
  const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;

  let instructions;
  if (guildId) {
    if (state.channelWideChatHistory[channelId]) {
      instructions = state.customInstructions[channelId];
    } else if (serverSettings.customPersonality) {
      instructions = serverSettings.customPersonality;
    } else if (effectiveSettings.customPersonality) {
      instructions = effectiveSettings.customPersonality;
    } else {
      instructions = state.customInstructions[userId];
    }
  } else {
    instructions = effectiveSettings.customPersonality || state.customInstructions[userId];
  }

  let infoStr = '';
  if (guildId) {
    const userInfo = {
      username: message.author.username,
      displayName: message.author.displayName
    };
    infoStr = `\nYou are currently engaging with users in the ${message.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
  }

  const isServerChatHistoryEnabled = guildId ? serverSettings.serverChatHistory : false;
  const isChannelChatHistoryEnabled = guildId ? state.channelWideChatHistory[channelId] : false;
  const finalInstructions = isServerChatHistoryEnabled ? (instructions || defaultPersonality) + infoStr : (instructions || defaultPersonality);
  const historyId = isChannelChatHistoryEnabled ? (isServerChatHistoryEnabled ? guildId : channelId) : userId;

  const selectedModel = effectiveSettings.selectedModel || 'gemini-2.5-flash';
  const modelName = MODELS[selectedModel];

  const tools = [{
      googleSearch: {}
    },
    {
      urlContext: {}
    },
    {
      codeExecution: {}
    }
  ];

  const chat = genAI.chats.create({
    model: modelName,
    config: {
      systemInstruction: {
        role: "system",
        parts: [{
          text: finalInstructions
        }]
      },
      ...generationConfig,
      safetySettings,
      tools
    },
    history: getHistory(historyId)
  });

  await handleModelResponse(botMessage, chat, parts, message, typingInterval, historyId, effectiveSettings);
}

function hasSupportedAttachments(message) {
  const supportedFileExtensions = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

  return message.attachments.some((attachment) => {
    const contentType = (attachment.contentType || "").toLowerCase();
    const fileExtension = path.extname(attachment.name) || '';
    return (
      contentType.startsWith('image/') ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('application/pdf') ||
      contentType.startsWith('application/x-pdf') ||
      supportedFileExtensions.includes(fileExtension)
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
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function processPromptAndMediaAttachments(prompt, message) {
  const attachments = JSON.parse(JSON.stringify(Array.from(message.attachments.values())));
  let parts = [{
    text: prompt
  }];

  if (attachments.length > 0) {
    const validAttachments = attachments.filter(attachment => {
      const contentType = (attachment.contentType || "").toLowerCase();
      return contentType.startsWith('image/') ||
        contentType.startsWith('audio/') ||
        contentType.startsWith('video/') ||
        contentType.startsWith('application/pdf') ||
        contentType.startsWith('application/x-pdf');
    });

    if (validAttachments.length > 0) {
      const attachmentParts = await Promise.all(
        validAttachments.map(async (attachment) => {
          const sanitizedFileName = sanitizeFileName(attachment.name);
          const uniqueTempFilename = `${message.author.id}-${attachment.id}-${sanitizedFileName}`;
          const filePath = path.join(TEMP_DIR, uniqueTempFilename);

          try {
            await downloadFile(attachment.url, filePath);
            const uploadResult = await genAI.files.upload({
              file: filePath,
              config: {
                mimeType: attachment.contentType,
                displayName: sanitizedFileName,
              }
            });

            const name = uploadResult.name;
            if (name === null) {
              throw new Error(`Unable to extract file name from upload result.`);
            }

            if (attachment.contentType.startsWith('video/')) {
              let file = await genAI.files.get({
                name: name
              });
              while (file.state === 'PROCESSING') {
                process.stdout.write(".");
                await new Promise((resolve) => setTimeout(resolve, 10_000));
                file = await genAI.files.get({
                  name: name
                });
              }
              if (file.state === 'FAILED') {
                throw new Error(`Video processing failed for ${sanitizedFileName}.`);
              }
            }

            return createPartFromUri(uploadResult.uri, uploadResult.mimeType);
          } catch (error) {
            console.error(`Error processing attachment ${sanitizedFileName}:`, error);
            return null;
          } finally {
            try {
              await fs.unlink(filePath);
            } catch (unlinkError) {
              if (unlinkError.code !== 'ENOENT') {
                console.error(`Error deleting temporary file ${filePath}:`, unlinkError);
              }
            }
          }
        })
      );
      parts = [...parts, ...attachmentParts.filter(part => part !== null)];
    }
  }
  return parts;
}

async function extractFileText(message, messageContent) {
  if (message.attachments.size > 0) {
    let attachments = Array.from(message.attachments.values());
    for (const attachment of attachments) {
      const fileType = path.extname(attachment.name) || '';
      const fileTypes = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

      if (fileTypes.includes(fileType)) {
        try {
          let fileContent = await downloadAndReadFile(attachment.url, fileType);
          messageContent += `\n\n[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent}\n\`\`\``;
        } catch (error) {
          console.error(`Error reading file ${attachment.name}: ${error.message}`);
        }
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
    if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow) {
      actionRow = ActionRowBuilder.from(messageComponents[0]);
    } else {
      actionRow = new ActionRowBuilder();
    }

    actionRow.addComponents(deleteButton);
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
  const showActionButtons = effectiveSettings.showActionButtons !== false;
  const continuousReply = effectiveSettings.continuousReply || false;
  const maxCharacterLimit = responseFormat === 'Embedded' ? 3900 : 1900;
  let attempts = 3;

  let updateTimeout;
  let tempResponse = '';
  let groundingMetadata = null;
  let urlContextMetadata = null;

  const stopGeneratingButton = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
      .setCustomId('stopGenerating')
      .setLabel('Stop Generating')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
    );

  let botMessage;
  if (!initialBotMessage) {
    clearInterval(typingInterval);
    try {
      botMessage = await originalMessage.reply({
        content: '🤔 Let me think...',
        components: showActionButtons ? [stopGeneratingButton] : []
      });
    } catch (error) {
      console.error('Error creating bot message:', error);
    }
  } else {
    botMessage = initialBotMessage;
    try {
      if (showActionButtons) {
        await botMessage.edit({
          components: [stopGeneratingButton]
        });
      }
    } catch (error) {
      console.error('Error editing bot message:', error);
    }
  }

  let stopGeneration = false;
  const filter = (interaction) => interaction.customId === 'stopGenerating' && interaction.user.id === originalMessage.author.id;
  try {
    const collector = await botMessage.createMessageComponentCollector({
      filter,
      time: 120000
    });
    collector.on('collect', (interaction) => {
      try {
        const embed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle('⏹️ Generation Stopped')
          .setDescription('Response generation has been stopped.');
        interaction.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('Error sending stop reply:', error);
      }
      stopGeneration = true;
    });
  } catch (error) {
    console.error('Error creating collector:', error);
  }

  const updateMessage = () => {
    if (stopGeneration) {
      return;
    }
    if (tempResponse.trim() === "") {
      botMessage.edit({
        content: '💭 Thinking...'
      });
    } else if (responseFormat === 'Embedded') {
      updateEmbed(botMessage, tempResponse, originalMessage, groundingMetadata, urlContextMetadata, effectiveSettings);
    } else {
      const mention = continuousReply ? '' : `<@${originalMessage.author.id}> `;
      botMessage.edit({
        content: mention + tempResponse,
        embeds: []
      });
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

      async function getResponse(parts) {
        let newResponse = '';
        const messageResult = await chat.sendMessageStream({
          message: parts
        });
        for await (const chunk of messageResult) {
          if (stopGeneration) break;

          const chunkText = (chunk.text || (chunk.codeExecutionResult?.output ? `\n\`\`\`py\n${chunk.codeExecutionResult.output}\n\`\`\`\n` : "") || (chunk.executableCode ? `\n\`\`\`\n${chunk.executableCode}\n\`\`\`\n` : ""));
          if (chunkText && chunkText !== '') {
            finalResponse += chunkText;
            tempResponse += chunkText;
            newResponse += chunkText;
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
              const embed = new EmbedBuilder()
                .setColor(0xFFAA00)
                .setTitle('📄 Large Response')
                .setDescription('The response is too large. It will be sent as a text file once completed.');
              botMessage.edit({
                embeds: [embed],
                components: []
              });
            }
          } else if (!updateTimeout) {
            updateTimeout = setTimeout(updateMessage, 500);
          }
        }
        newHistory.push({
          role: 'assistant',
          content: [{
            text: newResponse
          }]
        });
      }

      await getResponse(parts);

      if (!isLargeResponse && responseFormat === 'Embedded') {
        updateEmbed(botMessage, finalResponse, originalMessage, groundingMetadata, urlContextMetadata, effectiveSettings);
      }

      botMessage = await addSettingsButton(botMessage);
      if (isLargeResponse) {
        await sendAsTextFile(finalResponse, originalMessage, botMessage.id, continuousReply);
        if (showActionButtons) {
          botMessage = await addDeleteButton(botMessage, botMessage.id);
        }
      } else {
        if (showActionButtons) {
          botMessage = await addDownloadButton(botMessage);
          botMessage = await addDeleteButton(botMessage, botMessage.id);
        } else {
          botMessage.edit({
            components: []
          });
        }
      }

      await chatHistoryLock.runExclusive(async () => {
        updateChatHistory(historyId, newHistory, botMessage.id);
        await saveStateToFile();
      });
      break;
    } catch (error) {
      if (activeRequests.has(userId)) {
        activeRequests.delete(userId);
      }
      console.error('Generation attempt failed:', error);
      attempts--;

      if (attempts === 0 || stopGeneration) {
        if (!stopGeneration) {
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('❌ Generation Failed')
            .setDescription('All generation attempts failed. Please try again later.');
          const errorMsg = await originalMessage.channel.send({
            content: continuousReply ? '' : `<@${originalMessage.author.id}>`,
            embeds: [embed]
          });
          await addSettingsButton(errorMsg);
          await addSettingsButton(botMessage);
        }
        break;
      } else {
        const errorMsg = await originalMessage.channel.send({
          content: continuousReply ? '' : `<@${originalMessage.author.id}>`,
          embeds: [new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('⚠️ Retrying')
            .setDescription('Generation failed. Retrying...')
          ]
        });
        setTimeout(() => errorMsg.delete().catch(console.error), 5000);
        await delay(500);
      }
    }
  }

  if (activeRequests.has(userId)) {
    activeRequests.delete(userId);
  }
}

function updateEmbed(botMessage, finalResponse, message, groundingMetadata = null, urlContextMetadata = null, effectiveSettings) {
  try {
    const isGuild = message.guild !== null;
    const embedColor = effectiveSettings.embedColor || hexColour;
    const continuousReply = effectiveSettings.continuousReply || false;

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setDescription(finalResponse)
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
      embeds: [embed]
    });
  } catch (error) {
    console.error("Error updating embed:", error.message);
  }
}

function addGroundingMetadataToEmbed(embed, groundingMetadata) {
  if (groundingMetadata.webSearchQueries && groundingMetadata.webSearchQueries.length > 0) {
    embed.addFields({
      name: '🔍 Search Queries',
      value: groundingMetadata.webSearchQueries.map(query => `• ${query}`).join('\n'),
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
}

function addUrlContextMetadataToEmbed(embed, urlContextMetadata) {
  if (urlContextMetadata.url_metadata && urlContextMetadata.url_metadata.length > 0) {
    const urlList = urlContextMetadata.url_metadata
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
}

async function sendAsTextFile(text, message, orgId, continuousReply = false) {
  try {
    const filename = `response-${Date.now()}.txt`;
    const tempFilePath = path.join(TEMP_DIR, filename);
    await fs.writeFile(tempFilePath, text);

    const mention = continuousReply ? '' : `<@${message.author.id}>, `;
    const botMessage = await message.channel.send({
      content: `${mention}Here is the response:`,
      files: [tempFilePath]
    });
    await addSettingsButton(botMessage);
    await addDeleteButton(botMessage, orgId);

    await fs.unlink(tempFilePath);
  } catch (error) {
    console.error('Error sending as text file:', error);
  }
}

client.login(token);
