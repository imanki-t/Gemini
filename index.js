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
  const continuousReply = effectiveSettings.continuousReply || false;
  const channelContinuousReply = state.continuousReplyChannels?.[channelId] || false;

  const shouldRespond = (
    (workInDMs && isDM) ||
    (guildId && (channelContinuousReply || continuousReply) && !message.mentions.users.has(client.user.id)) ||
    state.alwaysRespondChannels[channelId] ||
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
    parts.push({
      text: prompt
    });
  }

  if (attachment) {
  try {
    const processedPart = await processAttachment(attachment, interaction.user.id, interaction.id);
    if (processedPart) {
      if (Array.isArray(processedPart)) {
        parts.push(...processedPart);
        // Check if any part in the array has media (no text property or has fileUri/fileData)
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
  const historyId = isServerChatHistoryEnabled ? guildId : (isChannelChatHistoryEnabled ? channelId : userId);

  const tools = [{
      googleSearch: {}
    },
    {
      urlContext: {}
    },
  ];

  if (!hasMedia) {
    tools.push({
      codeExecution: {}
    });
  }

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

  let botMessage = await interaction.editReply({
    content: 'Lumin is thinking...'
  });

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
        updateChatHistory(historyId, newHistory, botMessage.id);
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
        // Pass the interaction itself to be edited
        await sendAsTextFile(finalResponse, interaction, botMessage.id, false);
      }

      botMessage = await interaction.fetchReply();
      const showActionButtons = effectiveSettings.showActionButtons !== false;
      if (showActionButtons && !isLargeResponse) { // Only add buttons if not large response (file message handled separately)
        const components = [];
        const actionRow = new ActionRowBuilder();
        actionRow.addComponents(new ButtonBuilder().setCustomId('download_message').setLabel('Save').setEmoji('💾').setStyle(ButtonStyle.Secondary));
        actionRow.addComponents(new ButtonBuilder().setCustomId(`delete_message-${botMessage.id}`).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger));
        components.push(actionRow);
        await interaction.editReply({
          components
        });
      } else if (!isLargeResponse) { // Hide components if buttons are off and not a large response
        await interaction.editReply({
          components: []
        });
      }
      // If it was a large response, sendAsTextFile handled the final state of the interaction reply

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

async function processAttachment(attachment, userId, interactionId) {
  const contentType = (attachment.contentType || "").toLowerCase();
  const fileExtension = path.extname(attachment.name).toLowerCase();

  const audioExtensions = ['.mp3', '.wav', '.aiff', '.aac', '.ogg', '.flac', '.m4a'];
  const documentExtensions = ['.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.tsv', '.pptx', '.rtf', '.html', '.py', '.java', '.js', '.css', '.json', '.xml', '.sql', '.log', '.md'];
  const videoExtensions = ['.mp4', '.mov', '.mpeg', '.mpg', '.webm', '.avi', '.wmv', '.3gpp', '.flv'];
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp'];

  // Check if it's a GIF
  const isGif = contentType === 'image/gif' || fileExtension === '.gif';
  
  const shouldUploadToAPI =
    contentType.startsWith('image/') ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('application/pdf') ||
    contentType.startsWith('application/x-pdf') ||
    audioExtensions.includes(fileExtension) ||
    videoExtensions.includes(fileExtension) ||
    imageExtensions.includes(fileExtension) ||
    ['.pdf', '.docx', '.pptx', '.xlsx'].includes(fileExtension);

  if (shouldUploadToAPI) {
    const sanitizedFileName = sanitizeFileName(attachment.name);
    const uniqueTempFilename = `${userId}-${interactionId}-${Date.now()}-${sanitizedFileName}`;
    const filePath = path.join(TEMP_DIR, uniqueTempFilename);

    try {
      await downloadFile(attachment.url, filePath);
      
      // If it's a GIF, extract multiple frames and send them as separate images
      if (isGif) {
        const sharp = (await import('sharp')).default;
        const parts = [];
        
        try {
          // Get GIF metadata to determine frame count
          const metadata = await sharp(filePath, { animated: true }).metadata();
          const frameCount = metadata.pages || 1;
          
          // Extract key frames (first, middle, last, and a few in between)
          const framesToExtract = [];
          if (frameCount === 1) {
            // Static GIF, just use the single frame
            framesToExtract.push(0);
          } else if (frameCount <= 4) {
            // Few frames, extract all
            for (let i = 0; i < frameCount; i++) {
              framesToExtract.push(i);
            }
          } else {
            // Multiple frames, extract key ones
            framesToExtract.push(0); // First frame
            framesToExtract.push(Math.floor(frameCount * 0.25)); // 25% through
            framesToExtract.push(Math.floor(frameCount * 0.5)); // Middle
            framesToExtract.push(Math.floor(frameCount * 0.75)); // 75% through
            framesToExtract.push(frameCount - 1); // Last frame
          }
          
          // Extract and upload each frame
          for (let i = 0; i < framesToExtract.length; i++) {
            const frameIndex = framesToExtract[i];
            const frameFilePath = path.join(TEMP_DIR, `${userId}-${interactionId}-${Date.now()}-frame${i}.png`);
            
            try {
              await sharp(filePath, { page: frameIndex, animated: false })
                .png()
                .toFile(frameFilePath);
              
              const uploadResult = await genAI.files.upload({
                file: frameFilePath,
                config: {
                  mimeType: 'image/png',
                  displayName: `${sanitizedFileName}-frame${i+1}of${framesToExtract.length}`,
                }
              });
              
              if (uploadResult.uri) {
                parts.push(createPartFromUri(uploadResult.uri, uploadResult.mimeType));
              }
              
              await fs.unlink(frameFilePath).catch(() => {});
            } catch (frameError) {
              console.error(`Error processing frame ${frameIndex}:`, frameError);
            }
          }
          
          // Clean up original GIF
          await fs.unlink(filePath).catch(() => {});
          
          // Add text context about the GIF
          if (parts.length > 0) {
            parts.unshift({
              text: `[Animated GIF with ${frameCount} frames - showing ${parts.length} key frames: ${framesToExtract.map((f, i) => `frame ${i+1}/${framesToExtract.length}`).join(', ')}]`
            });
          }
          
          return parts.length > 0 ? parts : null;
          
        } catch (gifError) {
          console.error('Error processing GIF frames:', gifError);
          // Fallback: try to upload just the first frame
          try {
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
            
            return createPartFromUri(uploadResult.uri, uploadResult.mimeType);
          } catch (fallbackError) {
            throw gifError;
          }
        }
      }
      
      // For non-GIF files, use standard upload
      let mimeType = attachment.contentType;
      
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
      if ((contentType.startsWith('video/') || videoExtensions.includes(fileExtension)) && !isGif) {
        let file = await genAI.files.get({
          name: name
        });
        let attempts = 0;
        while (file.state === 'PROCESSING' && attempts < 60) {
          await delay(10000);
          file = await genAI.files.get({
            name: name
          });
          attempts++;
        }
        if (file.state === 'FAILED') {
          throw new Error(`Video processing failed for ${sanitizedFileName}.`);
        }
      }

      await fs.unlink(filePath).catch(() => {});
      return createPartFromUri(uploadResult.uri, uploadResult.mimeType);
    } catch (error) {
      // Clean up any temporary files
      await fs.unlink(filePath).catch(() => {});
      throw error;
    }
  } else if (documentExtensions.includes(fileExtension)) {
    try {
      let fileContent = await downloadAndReadFile(attachment.url, fileExtension);

      if (fileContent.length > 1000000) {
        const sanitizedFileName = sanitizeFileName(attachment.name);
        const uniqueTempFilename = `${userId}-${interactionId}-${Date.now()}-${sanitizedFileName}`;
        const filePath = path.join(TEMP_DIR, uniqueTempFilename);

        await fs.writeFile(filePath, fileContent);
        const uploadResult = await genAI.files.upload({
          file: filePath,
          config: {
            mimeType: 'text/plain',
            displayName: sanitizedFileName,
          }
        });

        await fs.unlink(filePath).catch(() => {});
        return createPartFromUri(uploadResult.uri, 'text/plain');
      }

      return {
        text: `\n\n[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent.slice(0, 50000)}\n\`\`\``
      };
    } catch (error) {
      console.error(`Error reading file ${attachment.name}: ${error.message}`);
      return {
        text: `\n\n[Failed to read file: ${attachment.name}]`
      };
    }
  }

  return null;
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
  'user_settings_page2': showUserSettingsPage2,
  'user_settings_p1': showUserSettings,
  'user_settings': showUserSettings,
  'server_settings_page4': showServerSettingsPage4,
  'server_settings_page3': showServerSettingsPage3,
  'server_settings_page2': showServerSettingsPage2,
  'server_settings_p1': showServerSettings, // Alias for page 1
  'server_settings': showServerSettings, // Page 1
  'back_to_main': showMainSettings,
  'back_to_user': showUserSettings,
  'back_to_server_p3': showServerSettingsPage3,
  'back_to_server_p2': showServerSettingsPage2,
  'back_to_server': showServerSettings, // Back to page 1
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
  'user_settings',
  'user_settings_page2',
  'user_settings_p1',
  'server_settings',
  'server_settings_p1',
  'server_settings_page2',
  'server_settings_page3',
  'server_settings_page4',
  'back_to_main',
  'back_to_user',
  'back_to_server',
  'back_to_server_p2',
  'back_to_server_p3',
  'manage_allowed_channels',
  'set_all_channels'
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
        const embed = new EmbedBuilder()
          .setColor(0xFFAA00)
          .setTitle('🔒 Server Override Active')
          .setDescription('Your user settings will not apply in this server. (I tried to DM you this, but your DMs might be closed.)');

        await interaction.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });

        setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
      }
    }
  }

  const selectedModel = userSettings.selectedModel || 'gemini-2.5-flash';
  const responseFormat = userSettings.responseFormat || 'Normal';
  const showActionButtons = userSettings.showActionButtons !== false;
  const embedColor = userSettings.embedColor || hexColour;

  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId('user_model_select')
    .setPlaceholder('Select AI Model')
    .addOptions(
      new StringSelectMenuOptionBuilder()
      .setLabel('Gemini 2.5 Flash')
      .setDescription('Balanced performance ')
      .setValue('gemini-2.5-flash')
      .setEmoji('🔥')
      .setDefault(selectedModel === 'gemini-2.5-flash'),
      new StringSelectMenuOptionBuilder()
      .setLabel('Gemini 2.0 Flash')
      .setDescription('Fast and efficient model')
      .setValue('gemini-2.0-flash')
      .setEmoji('⚡')
      .setDefault(selectedModel === 'gemini-2.0-flash'),
      new StringSelectMenuOptionBuilder()
      .setLabel('Gemini 2.5 Flash Lite')
      .setDescription('Lightweight and quick')
      .setValue('gemini-2.5-flash-lite')
      .setEmoji('💨')
      .setDefault(selectedModel === 'gemini-2.5-flash-lite'),
      new StringSelectMenuOptionBuilder()
      .setLabel('Gemini 2.0 Flash Lite')
      .setDescription('Fast and optimised')
      .setValue('gemini-2.0-flash-lite')
      .setEmoji('🚀')
      .setDefault(selectedModel === 'gemini-2.0-flash-lite')
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

  const buttons = [
    new ButtonBuilder()
    .setCustomId('user_settings_page2')
    .setLabel('Next Page')
    .setEmoji('➡️')
    .setStyle(ButtonStyle.Primary),
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
    new ActionRowBuilder().addComponents(...buttons)
  ];

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('👤 User Settings (Page 1/2)')
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
      text: 'Use the dropdowns and buttons to customize your experience'
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
    reply = await interaction.reply({...payload,
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
} catch (error) {
  console.error('Error showing user settings:', error);
}
}

async function showUserSettingsPage2(interaction, isUpdate = false) {
try {
  const userId = interaction.user.id;
  const userSettings = state.userSettings[userId] || {};

  const continuousReply = userSettings.continuousReply || false;
  const embedColor = userSettings.embedColor || hexColour;
  const hasPersonality = !!userSettings.customPersonality;

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
  ];

  const buttons3 = [
    new ButtonBuilder()
    .setCustomId('user_settings_p1')
    .setLabel('Back')
    .setEmoji('◀️')
    .setStyle(ButtonStyle.Secondary)
  ];

  const components = [
    new ActionRowBuilder().addComponents(continuousReplySelect),
    new ActionRowBuilder().addComponents(...buttons1),
    new ActionRowBuilder().addComponents(...buttons2),
    new ActionRowBuilder().addComponents(...buttons3)
  ];

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('👤 User Settings (Page 2/2)')
    .setDescription('Configure additional preferences')
    .addFields({
      name: '🔄 Continuous Reply',
      value: `\`${continuousReply ? 'Enabled' : 'Disabled'}\``,
      inline: true
    }, {
      name: '🎨 Embed Color',
      value: `\`${embedColor}\``,
      inline: true
    }, {
      name: '🎭 Custom Personality',
      value: `\`${hasPersonality ? 'Active' : 'Not Set'}\``,
      inline: true
    })
    .setFooter({
      text: 'Use the dropdowns and buttons to customize your experience'
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
    reply = await interaction.reply({...payload,
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

} catch (error) {
  console.error('Error showing user settings page 2:', error);
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
  const embedColor = serverSettings.embedColor || hexColour;

  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId('server_model_select')
    .setPlaceholder('Select AI Model')
    .addOptions(
      new StringSelectMenuOptionBuilder()
      .setLabel('Gemini 2.5 Flash')
      .setDescription('Balanced performance ')
      .setValue('gemini-2.5-flash')
      .setEmoji('🔥')
      .setDefault(selectedModel === 'gemini-2.5-flash'),
      new StringSelectMenuOptionBuilder()
      .setLabel('Gemini 2.0 Flash')
      .setDescription('Fast and efficient model')
      .setValue('gemini-2.0-flash')
      .setEmoji('⚡')
      .setDefault(selectedModel === 'gemini-2.0-flash'),
      new StringSelectMenuOptionBuilder()
      .setLabel('Gemini 2.5 Flash Lite')
      .setDescription('Lightweight and quick')
      .setValue('gemini-2.5-flash-lite')
      .setEmoji('💨')
      .setDefault(selectedModel === 'gemini-2.5-flash-lite'),
      new StringSelectMenuOptionBuilder()
      .setLabel('Gemini 2.0 Flash Lite')
      .setDescription('Fast and optimised')
      .setValue('gemini-2.0-flash-lite')
      .setEmoji('🚀')
      .setDefault(selectedModel === 'gemini-2.0-flash-lite')
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

  const buttons1 = [
    new ButtonBuilder()
    .setCustomId('server_settings_page2')
    .setLabel('Next Page')
    .setEmoji('➡️')
    .setStyle(ButtonStyle.Primary),
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
    new ActionRowBuilder().addComponents(...buttons1)
  ];

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('🏰 Server Settings (Page 1/4)')
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
      text: 'Click "Next Page" for more options'
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
    reply = await interaction.reply({...payload,
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
} catch (error) {
  console.error('Error showing server settings:', error);
}
}

async function showServerSettingsPage2(interaction, isUpdate = false) {
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

  const overrideUserSettings = serverSettings.overrideUserSettings || false;
  const continuousReply = serverSettings.continuousReply || false;
  const serverChatHistory = serverSettings.serverChatHistory || false;

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

  const continuousReplySelect = new StringSelectMenuBuilder()
    .setCustomId('server_continuous_reply')
    .setPlaceholder('Continuous Reply (Server-Wide)')
    .addOptions(
      new StringSelectMenuOptionBuilder()
      .setLabel('Enabled')
      .setDescription('Bot replies without mentions in all channels')
      .setValue('enabled')
      .setEmoji('🔄')
      .setDefault(continuousReply),
      new StringSelectMenuOptionBuilder()
      .setLabel('Disabled')
      .setDescription('Bot requires mentions (default)')
      .setValue('disabled')
      .setEmoji('⏸️')
      .setDefault(!continuousReply)
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

  const buttons = [
    new ButtonBuilder()
    .setCustomId('server_settings_page3')
    .setLabel('Next Page')
    .setEmoji('➡️')
    .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
    .setCustomId('back_to_server') // Goes to page 1
    .setLabel('Back')
    .setEmoji('◀️')
    .setStyle(ButtonStyle.Secondary)
  ];

  const components = [
    new ActionRowBuilder().addComponents(overrideSelect),
    new ActionRowBuilder().addComponents(continuousReplySelect),
    new ActionRowBuilder().addComponents(chatHistorySelect),
    new ActionRowBuilder().addComponents(...buttons)
  ];

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('🏰 Server Settings (Page 2/4)')
    .setDescription('Configure override and history settings')
    .addFields({
      name: '🔒 Override User Settings',
      value: `\`${overrideUserSettings ? 'Enabled' : 'Disabled'}\``,
      inline: true
    }, {
      name: '🔄 Server Continuous Reply',
      value: `\`${continuousReply ? 'Enabled' : 'Disabled'}\``,
      inline: true
    }, {
      name: '📚 Server Chat History',
      value: `\`${serverChatHistory ? 'Enabled' : 'Disabled'}\``,
      inline: true
    })
    .setFooter({
      text: 'Use the dropdowns to configure settings'
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
    reply = await interaction.reply({...payload,
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
} catch (error) {
  console.error('Error showing server settings page 2:', error);
}
}

async function showServerSettingsPage3(interaction, isUpdate = false) {
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
  const hasPersonality = !!serverSettings.customPersonality;

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
  ];

  const buttons3 = [
    new ButtonBuilder()
    .setCustomId('server_settings_page4')
    .setLabel('Next Page')
    .setEmoji('➡️')
    .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
    .setCustomId('back_to_server_p2') // Goes to page 2
    .setLabel('Back')
    .setEmoji('◀️')
    .setStyle(ButtonStyle.Secondary)
  ];

  const components = [
    new ActionRowBuilder().addComponents(...buttons1),
    new ActionRowBuilder().addComponents(...buttons2),
    new ActionRowBuilder().addComponents(...buttons3)
  ];

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('🏰 Server Settings (Page 3/4)')
    .setDescription('Configure personality and memory settings')
    .addFields({
      name: '🎨 Embed Color',
      value: `\`${embedColor}\``,
      inline: true
    }, {
      name: '🎭 Custom Personality',
      value: `\`${hasPersonality ? 'Active' : 'Not Set'}\``,
      inline: true
    })
    .setFooter({
      text: 'Use the buttons to manage server settings'
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
    reply = await interaction.reply({...payload,
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
} catch (error) {
  console.error('Error showing server settings page 3:', error);
}
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

  const buttons1 = [
    new ButtonBuilder()
    .setCustomId('manage_allowed_channels')
    .setLabel('Manage Allowed Channels')
    .setEmoji('📢')
    .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
    .setCustomId('toggle_continuous_reply')
    .setLabel('Toggle Channel Continuous')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary)
  ];

  const buttons2 = [
    new ButtonBuilder()
    .setCustomId('back_to_server_p3') // Goes to page 3
    .setLabel('Back')
    .setEmoji('◀️')
    .setStyle(ButtonStyle.Secondary)
  ];

  const components = [
    new ActionRowBuilder().addComponents(...buttons1),
    new ActionRowBuilder().addComponents(...buttons2)
  ];

  const channelList = allowedChannels.length > 0 ?
    allowedChannels.map(id => `<#${id}>`).slice(0, 10).join(', ') + (allowedChannels.length > 10 ? '...' : '') :
    'All channels';

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('🏰 Server Settings (Page 4/4)')
    .setDescription('Configure channel-specific settings')
    .addFields({
      name: '📢 Allowed Channels',
      value: channelList,
      inline: false
    }, {
      name: '🔄 Toggle Channel Continuous',
      value: 'Enable/disable continuous reply *for the current channel*.\n(Different from the server-wide setting)',
      inline: false
    })
    .setFooter({
      text: 'Use the buttons to manage channel settings'
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
    reply = await interaction.reply({...payload,
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
} catch (error) {
  console.error('Error showing server settings page 4:', error);
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

  const isDM = interaction.channel.type === ChannelType.DM;
  const historyType = isDM ? 'DM History' : 'Personal History';

  try {
    await interaction.user.send({
      content: `📥 **Your Conversation History**\n\`${historyType}\``,
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
    await fs.unlink(tempFileName).catch(() => {});
  }
} catch (error) {
  console.error('Error downloading user conversation:', error);
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
    
    // Check if server chat history is enabled
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

    // Get raw history object to check if anything exists
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

    // Build conversation history including all messages
    let conversationText = '';
    let messageCount = 0;
    
    for (const messagesId in historyObject) {
      if (historyObject.hasOwnProperty(messagesId)) {
        const messages = historyObject[messagesId];
        
        for (const entry of messages) {
          const role = entry.role === 'user' ? '[User]' : '[Assistant]';
          const contentParts = [];
          
          // Extract text content
          for (const part of entry.content) {
            if (part.text !== undefined && part.text !== '') {
              contentParts.push(part.text);
            } else if (part.fileUri) {
              contentParts.push('[Media File Attached]');
            } else if (part.fileData) {
              contentParts.push('[File Attached]');
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

    const file = new AttachmentBuilder(tempFileName, {
      name: `${interaction.guild.name.replace(/[^a-z0-9]/gi, '_')}_history.txt`
    });

    const serverName = interaction.guild.name;

    try {
      await interaction.user.send({
        content: `📥 **Server Conversation History**\n\`Server: ${serverName}\`\n\`Messages: ${messageCount}\``,
        files: [file]
      });
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ History Sent')
        .setDescription(`Server conversation history (${messageCount} messages) has been sent to your DMs!`);
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Delivery Failed')
        .setDescription('Could not send to DMs. Make sure you have DMs enabled. Sending here instead:');
      await interaction.reply({
        embeds: [embed],
        files: [file],
        flags: MessageFlags.Ephemeral
      });
    } finally {
      await fs.unlink(tempFileName).catch(() => {});
    }
  } catch (error) {
    console.error('Error downloading server conversation:', error);
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Error')
      .setDescription('An error occurred while downloading server history.');
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
  reply = await interaction.reply({...payload,
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

    // Check if bot has access to that server/channel
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return { error: "I don't have access to that server." };
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      return { error: "I don't have access to that channel." };
    }

    // Check permissions
    const permissions = channel.permissionsFor(client.user);
    if (!permissions.has(PermissionsBitField.Flags.ViewChannel) || 
        !permissions.has(PermissionsBitField.Flags.ReadMessageHistory)) {
      return { error: "I don't have permission to read messages in that channel." };
    }

    // Fetch the initial message
    const startMessage = await channel.messages.fetch(messageId).catch(() => null);
    if (!startMessage) {
      return { error: "Could not find that message. It may have been deleted." };
    }

    let messagesToSummarize = [startMessage];

    // If count > 1, fetch additional messages after the start message
    if (count > 1) {
      const additionalMessages = await channel.messages.fetch({
        after: messageId,
        limit: Math.min(count - 1, 99) // Discord API limit is 100
      }).catch(() => null);

      if (additionalMessages) {
        // Sort messages chronologically (oldest first)
        const sortedMessages = Array.from(additionalMessages.values())
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        messagesToSummarize.push(...sortedMessages);
      }
    }

    // Format messages for summarization
    const formattedMessages = messagesToSummarize.map(msg => {
      let content = `**${msg.author.username}** (${msg.createdAt.toLocaleString()}):\n`;
      
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
  
  // Check if message has forwarded content (messageSnapshots in Discord.js v14)
  if (message.messageSnapshots && message.messageSnapshots.size > 0) {
    const snapshot = message.messageSnapshots.first();
    
    // Extract text content from forwarded message
    if (snapshot.content) {
      forwardedText = snapshot.content;
    }
    
    // Extract embeds content if present
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
    
    // Extract attachments from forwarded message
    if (snapshot.attachments && snapshot.attachments.size > 0) {
      forwardedAttachments = Array.from(snapshot.attachments.values());
    }
  }
  
  return { forwardedText, forwardedAttachments };
}

// Replace the beginning of handleTextMessage function with this:

async function handleTextMessage(message) {
  const botId = client.user.id;
  const userId = message.author.id;
  const guildId = message.guild?.id;
  const channelId = message.channel.id;
  let messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

  const { forwardedText, forwardedAttachments } = extractForwardedContent(message);
  
  if (messageContent === '' && forwardedText) {
    messageContent = `[Forwarded message]:\n${forwardedText}`;
  }
  
  const hasAnyContent = messageContent !== '' || 
                        (message.attachments.size > 0 && hasSupportedAttachments(message)) ||
                        forwardedAttachments.length > 0;

  if (!hasAnyContent) {
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

  let botMessage;
  let parts;
  let hasMedia = false;

  try {
    clearInterval(typingInterval);

    const userSettings = state.userSettings[userId] || {};
    const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
    const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;
    const continuousReply = effectiveSettings.continuousReply || false;

    if (continuousReply) {
      botMessage = await message.channel.send({
        content: 'Lumin is thinking...'
      });
    } else {
      botMessage = await message.reply({
        content: 'Lumin is thinking...'
      });
    }

    messageContent = await extractFileText(message, messageContent);
    parts = await processPromptAndMediaAttachments(messageContent, message);
    hasMedia = parts.some(part => part.text === undefined);

  } catch (error) {
    console.error('Error initializing message:', error);
    if (activeRequests.has(userId)) {
      activeRequests.delete(userId);
    }
    clearInterval(typingInterval);
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
  const historyId = isServerChatHistoryEnabled ? guildId : (isChannelChatHistoryEnabled ? channelId : userId);

  const selectedModel = effectiveSettings.selectedModel || 'gemini-2.5-flash';
  const modelName = MODELS[selectedModel];

  const tools = [{
      googleSearch: {}
    },
    {
      urlContext: {}
    },
  ];

  if (!hasMedia) {
    tools.push({
      codeExecution: {}
    });
  }

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

async function processPromptAndMediaAttachments(prompt, message) {
  // Collect attachments from the current message
  const attachments = JSON.parse(JSON.stringify(Array.from(message.attachments.values())));
  
  // Check for forwarded message attachments
  if (message.messageSnapshots && message.messageSnapshots.size > 0) {
    const snapshot = message.messageSnapshots.first();
    if (snapshot.attachments && snapshot.attachments.size > 0) {
      const forwardedAttachments = Array.from(snapshot.attachments.values());
      attachments.push(...forwardedAttachments.map(att => ({
        ...att,
        isForwarded: true
      })));
    }
  }
  
  // Limit to 5 total attachments to avoid overload
  const limitedAttachments = attachments.slice(0, 5);
  
  let parts = [{
    text: prompt
  }];

  if (limitedAttachments.length > 0) {
    for (const attachment of limitedAttachments) {
      try {
        // Add indicator if attachment is from forwarded message
        const prefix = attachment.isForwarded ? '[Forwarded] ' : '';
        
        const processedPart = await processAttachment(attachment, message.author.id, message.id);
        if (processedPart) {
          if (Array.isArray(processedPart)) {
            // For GIF frames, add forwarded indicator to first part if applicable
            if (attachment.isForwarded && processedPart.length > 0 && processedPart[0].text) {
              processedPart[0].text = prefix + processedPart[0].text;
            }
            parts.push(...processedPart);
          } else {
            // For regular attachments
            if (attachment.isForwarded && processedPart.text) {
              processedPart.text = prefix + processedPart.text;
            }
            parts.push(processedPart);
          }
        }
      } catch (error) {
        console.error(`Error processing attachment ${attachment.name}:`, error);
        const prefix = attachment.isForwarded ? '[Forwarded] ' : '';
        parts.push({
          text: `\n\n${prefix}[Error processing file: ${attachment.name}]`
        });
      }
    }
  }

  return parts;
}

// Also update the extractFileText function to handle forwarded files:

async function extractFileText(message, messageContent) {
  // Check for Discord message links in the content
  const discordLinkRegex = /https?:\/\/(?:www\.)?discord\.com\/channels\/\d+\/\d+\/\d+/g;
  const messageLinks = messageContent.match(discordLinkRegex);
  
  if (messageLinks && messageLinks.length > 0) {
    // Check if user is asking to summarize multiple messages
    const multiMessageRegex = /(?:summarize|summarise|summary of).*?(?:next|following)\s+(\d+)\s+messages?/i;
    const multiMatch = messageContent.match(multiMessageRegex);
    const messageCount = multiMatch ? parseInt(multiMatch[1]) : 1;
    
    // Fetch and format the messages
    const result = await fetchMessagesForSummary(message, messageLinks[0], messageCount);
    
    if (result.error) {
      messageContent += `\n\n[Error: ${result.error}]`;
    } else if (result.success) {
      messageContent += `\n\n[Discord Messages to Summarize from #${result.channelName} in ${result.guildName} (${result.messageCount} message(s))]:\n\n${result.content}`;
    }
  }
  
  // Process regular attachments
  if (message.attachments.size > 0) {
    let attachments = Array.from(message.attachments.values());
    messageContent = await processTextFiles(attachments, messageContent, '');
  }
  
  // Process forwarded message attachments
  if (message.messageSnapshots && message.messageSnapshots.size > 0) {
    const snapshot = message.messageSnapshots.first();
    if (snapshot.attachments && snapshot.attachments.size > 0) {
      let forwardedAttachments = Array.from(snapshot.attachments.values());
      messageContent = await processTextFiles(forwardedAttachments, messageContent, '[Forwarded] ');
    }
  }
  
  return messageContent;
}

// Helper function to process text files
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

let botMessage = initialBotMessage;
try {
  await botMessage.edit({
    components: [stopGeneratingButton]
  });
} catch (e) {}

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
    collector.stop();
  });
} catch (error) {
  console.error('Error creating collector:', error);
}

const updateMessage = () => {
  if (stopGeneration) {
    return;
  }
  if (tempResponse.trim() === "") {} else if (responseFormat === 'Embedded') {
    updateEmbed(botMessage, tempResponse, originalMessage, groundingMetadata, urlContextMetadata, effectiveSettings);
  } else {
    // For normal format, still edit during streaming for real-time updates
    botMessage.edit({
      content: tempResponse,
      embeds: []
    }).catch(() => {});
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
              content: ' ',
              embeds: [embed],
              components: []
            }).catch(() => {});
          }
        } else if (!updateTimeout) {
          updateTimeout = setTimeout(updateMessage, 500);
        }
      }
      if (!stopGeneration) {
        newHistory.push({
          role: 'assistant',
          content: [{
            text: newResponse
          }]
        });
      }
    }

    await getResponse(parts);

    clearInterval(typingInterval);
    clearTimeout(updateTimeout);

    if (stopGeneration) {
      finalResponse = tempResponse;
    }

    if (!isLargeResponse && responseFormat === 'Embedded') {
  updateEmbed(botMessage, finalResponse, originalMessage, groundingMetadata, urlContextMetadata, effectiveSettings);
} else if (!isLargeResponse) {
  // Delete the "thinking" message and send new message with final response
  await botMessage.delete().catch(() => {});
  
  if (continuousReply) {
    botMessage = await originalMessage.channel.send({
      content: finalResponse.slice(0, 2000),
      embeds: []
    });
  } else {
    botMessage = await originalMessage.reply({
      content: finalResponse.slice(0, 2000),
      embeds: []
    });
  }
    }

    // Add buttons *after* final content is set
    let finalMessage = botMessage;
    if (isLargeResponse) {
      // sendAsTextFile will now *edit* the botMessage
      finalMessage = await sendAsTextFile(finalResponse, originalMessage, botMessage.id, continuousReply);
    }

    // Add action buttons if enabled
    if (showActionButtons) {
      finalMessage = await addDownloadButton(finalMessage);
      finalMessage = await addDeleteButton(finalMessage, finalMessage.id);
    } else {
      // Ensure no buttons (like 'Stop') are left
      finalMessage.edit({
        components: []
      }).catch(() => {});
    }

    if (newHistory.length > 1) {
      await chatHistoryLock.runExclusive(async () => {
        updateChatHistory(historyId, newHistory, finalMessage.id);
        await saveStateToFile();
      });
    }
    break;
  } catch (error) {
    if (activeRequests.has(userId)) {
      activeRequests.delete(userId);
    }
    console.error('Generation attempt failed:', error);
    attempts--;
    clearInterval(typingInterval);
    clearTimeout(updateTimeout);

    if (attempts === 0 || stopGeneration) {
      try {
        await botMessage.delete();
      } catch (deleteError) {
        console.error('Error deleting thinking message:', deleteError);
      }

      if (!stopGeneration) {
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('❌ Generation Failed')
          .setDescription('All generation attempts failed. Please try again later.');

        let errorMsg;
        if (continuousReply) {
          errorMsg = await originalMessage.channel.send({
            embeds: [embed]
          });
        } else {
          errorMsg = await originalMessage.reply({
            embeds: [embed]
          });
        }
        await addSettingsButton(errorMsg);
      }
      break;
    } else {
      let errorMsg;
      if (continuousReply) {
        errorMsg = await originalMessage.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('⚠️ Retrying')
            .setDescription('Generation failed. Retrying...')
          ]
        });
      } else {
        errorMsg = await originalMessage.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('⚠️ Retrying')
            .setDescription('Generation failed. Retrying...')
          ]
        });
      }
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


client.login(token);
