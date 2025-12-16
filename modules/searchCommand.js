import { EmbedBuilder, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder } from 'discord.js';
import path from 'path';
import { genAI, state, chatHistoryLock, updateChatHistory, saveStateToFile, checkImageRateLimit, incrementImageUsage, TEMP_DIR } from '../botManager.js';
import { memorySystem } from '../memorySystem.js';
import config from '../config.js';
import { MODELS, safetySettings, generationConfig } from './config.js';
import { updateEmbedForInteraction } from './responseHandler.js';
import { initializeBlacklistForGuild } from './utils.js';

export async function handleSearchCommand(interaction) {
  try {
    const prompt = interaction.options.getString('prompt');
    const attachment = interaction.options.getAttachment('file');

    if (!prompt && !attachment) {
      return interaction.reply({
        content: '❌ Please provide a prompt or an attachment.',
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply();

    const userId = interaction.user.id;

    if (!state.requestQueues.has(userId)) {
      state.requestQueues.set(userId, { queue: [], isProcessing: false });
    }

    const userQueueData = state.requestQueues.get(userId);

    if (userQueueData.queue.length >= 5) {
      return interaction.editReply({
        content: '⏳ **Queue Full:** You have too many requests processing. Please wait.'
      });
    }

    userQueueData.queue.push(interaction);

    if (!userQueueData.isProcessing) {
      const { processUserQueue } = await import('./messageProcessor.js');
      processUserQueue(userId);
    }

  } catch (error) {
    console.error('Error queuing search:', error);
  }
}

export async function executeSearchInteraction(interaction) {
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
      const forcedSearchPrompt = `IMPERATIVE: You must use the 'googleSearch' tool to find the most current information for this request. Do not answer from internal memory. Query: ${prompt}`;
      parts.push({
        text: forcedSearchPrompt
      });
    }

    if (attachment) {
      try {
        const { processAttachment } = await import('./attachmentProcessor.js');
        const processedPart = await processAttachment(attachment, interaction.user.id, interaction.id);
        
        if (processedPart) {
          if (Array.isArray(processedPart)) {
            for (const part of processedPart) {
              // Skip text metadata parts, only add actual file parts
              if (part.fileUri || part.fileData || part.inlineData) {
                parts.push(part);
                hasMedia = true;
              } else if (part.text && !part.text.includes('[') && !part.text.includes('uploaded:') && !part.text.includes('converted')) {
                // Only add text if it's actual content, not metadata
                parts.push(part);
              }
            }
          } else {
            if (processedPart.fileUri || processedPart.fileData || processedPart.inlineData) {
              parts.push(processedPart);
              hasMedia = true;
            } else if (processedPart.text && !processedPart.text.includes('[') && !processedPart.text.includes('uploaded:')) {
              parts.push(processedPart);
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

    // If we only have metadata text and no actual prompt, return error
    if (parts.length === 0 || (parts.length === 1 && !parts[0].text && !parts[0].fileUri && !parts[0].fileData)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Invalid Input')
        .setDescription('Please provide a text prompt along with your file, or ensure the file was processed correctly.');
      return interaction.editReply({
        embeds: [embed]
      });
    }

    const userSettings = state.userSettings[userId] || {};
    const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
    const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;

    const selectedModel = effectiveSettings.selectedModel || 'gemini-2.5-flash';
    const modelName = MODELS[selectedModel];

    let finalInstructions = config.coreSystemRules;

    const customPersonality = effectiveSettings.customPersonality || state.customInstructions[userId];
    if (customPersonality) {
      finalInstructions += `\n\nADDITIONAL PERSONALITY:\n${customPersonality}`;
    } else {
      finalInstructions += `\n\n${config.defaultPersonality}`;
    }

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

    const tools = [
      { googleSearch: {} },
      { urlContext: {} }
    ];

    if (!hasMedia) {
      tools.push({ codeExecution: {} });
    }

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

    let botMessage = await interaction.fetchReply();

    const responseFormat = effectiveSettings.responseFormat || 'Normal';
    
    const maxCharacterLimit = responseFormat === 'Embedded' ? 3900 : 1900;
    let attempts = 3;

    let updateTimeout;
    let tempResponse = '';
    let groundingMetadata = null;
    let urlContextMetadata = null;

    const updateSearchMessage = () => {
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
          const { sendAsTextFile } = await import('./responseHandler.js');
          await sendAsTextFile(finalResponse, interaction, botMessage.id, false);
        }

        botMessage = await interaction.fetchReply();
        const showActionButtons = effectiveSettings.showActionButtons === true;
        
        if (showActionButtons && !isLargeResponse) {
          const { addDownloadButton, addDeleteButton } = await import('./responseHandler.js');
          const components = [];
          const ActionRowBuilder = (await import('discord.js')).ActionRowBuilder;
          const ButtonBuilder = (await import('discord.js')).ButtonBuilder;
          const ButtonStyle = (await import('discord.js')).ButtonStyle;
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
