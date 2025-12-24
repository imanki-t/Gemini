import { EmbedBuilder, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder } from 'discord.js';
import path from 'path';
import fs from 'fs/promises';
import { genAI, state, TEMP_DIR } from '../botManager.js';
import config from '../config.js';
import { MODELS, safetySettings, getGenerationConfig, RATE_LIMIT_ERRORS, DEFAULT_MODEL } from './config.js';
import { initializeBlacklistForGuild } from './utils.js';

const SEARCH_SYSTEM_PROMPT = `You are a helpful AI assistant performing web searches.

CRITICAL RULES:
- You MUST use the googleSearch tool for every query
- Provide accurate, well-sourced information from search results
- Cite your sources when relevant
- Be concise and informative
- NEVER use LaTeX formatting - Discord doesn't support it
- Current date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

/**
 * Main search command handler - queues the search request
 */
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
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ An error occurred while processing your search request.',
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
}

/**
 * Execute the actual search - called from queue processor
 */
export async function executeSearchInteraction(interaction) {
  try {
    const prompt = interaction.options.getString('prompt') || '';
    const attachment = interaction.options.getAttachment('file');

    if (!prompt && !attachment) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Invalid Input')
        .setDescription('Please provide either a text prompt or a file attachment.');
      return interaction.editReply({ embeds: [embed] });
    }

    const userId = interaction.user.id;
    const guildId = interaction.guild?.id;
    const channelId = interaction.channelId;

    // Check blacklist and channel restrictions
    if (guildId) {
      initializeBlacklistForGuild(guildId);
      
      if (state.blacklistedUsers[guildId]?.includes(userId)) {
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('🚫 Blacklisted')
          .setDescription('You are blacklisted and cannot use this command.');
        return interaction.editReply({ embeds: [embed] });
      }

      const allowedChannels = state.serverSettings[guildId]?.allowedChannels;
      if (allowedChannels && allowedChannels.length > 0 && !allowedChannels.includes(channelId)) {
        const embed = new EmbedBuilder()
          .setColor(0xFF5555)
          .setTitle('❌ Channel Restricted')
          .setDescription('This bot can only be used in specific channels set by server admins.');
        return interaction.editReply({ embeds: [embed] });
      }
    }

    // Build content parts
    let parts = [];
    let hasMedia = false;
    
    if (prompt) {
      // Force search by making it clear in the prompt
      const searchPrompt = `Search the web for current information about: ${prompt}`;
      parts.push({ text: searchPrompt });
    }

    // Process attachment if provided
    if (attachment) {
      try {
        const { processAttachment } = await import('./attachmentProcessor.js');
        const processedPart = await processAttachment(attachment, userId, interaction.id);
        
        if (processedPart) {
          const partsToAdd = Array.isArray(processedPart) ? processedPart : [processedPart];
          
          for (const part of partsToAdd) {
            if (part.fileUri || part.fileData || part.inlineData) {
              parts.push(part);
              hasMedia = true;
            }
          }
        }
      } catch (error) {
        console.error('Error processing attachment:', error);
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('❌ Processing Error')
          .setDescription(`Failed to process the attachment: ${error.message}`);
        return interaction.editReply({ embeds: [embed] });
      }
    }

    if (parts.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Invalid Input')
        .setDescription('Could not process your request. Please try again.');
      return interaction.editReply({ embeds: [embed] });
    }

    // Get user/server settings for model and response format
    const userSettings = state.userSettings[userId] || {};
    const serverSettings = guildId ? (state.serverSettings[guildId] || {}) : {};
    const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;

    const selectedModel = effectiveSettings.selectedModel || DEFAULT_MODEL;
    const modelName = MODELS[selectedModel];
    const responseFormat = effectiveSettings.responseFormat || 'Normal';
    const embedColor = effectiveSettings.embedColor || config.hexColour;

    // Build tools array
    const tools = [
      { googleSearch: {} },
      { urlContext: {} }
    ];

    // Add code execution only if no media
    if (!hasMedia) {
      tools.push({ codeExecution: {} });
    }

    // Get generation config for the model
    const generationConfig = getGenerationConfig(modelName);

    // Execute search with retry logic
    const result = await executeSearchWithRetry(
      modelName,
      SEARCH_SYSTEM_PROMPT,
      generationConfig,
      safetySettings,
      tools,
      parts,
      responseFormat,
      embedColor
    );

    if (!result.success) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Search Failed')
        .setDescription(result.error || 'Failed to complete search after multiple attempts.');
      return interaction.editReply({ embeds: [embed] });
    }

    // Send the response
    await sendSearchResponse(
      interaction,
      result.response,
      result.groundingMetadata,
      result.urlContextMetadata,
      responseFormat,
      embedColor,
      effectiveSettings.showActionButtons
    );

  } catch (error) {
    console.error('Error in search execution:', error);
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Search Error')
      .setDescription('An unexpected error occurred during the search.');
    
    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
}

/**
 * Execute search with retry logic for rate limits
 */
async function executeSearchWithRetry(
  modelName,
  systemInstruction,
  generationConfig,
  safetySettings,
  tools,
  parts,
  responseFormat,
  embedColor
) {
  const MAX_RETRIES = 3;
  let attempts = 0;

  while (attempts < MAX_RETRIES) {
    try {
      let fullResponse = '';
      let groundingMetadata = null;
      let urlContextMetadata = null;

      const request = {
        model: modelName,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction,
          ...generationConfig,
          tools
        },
        safetySettings
      };

      const result = await genAI.models.generateContentStream(request);

      for await (const chunk of result) {
        const chunkText = chunk.text || '';
        
        // Handle code execution results
        let codeOutput = '';
        if (chunk.codeExecutionResult?.output) {
          const outcome = chunk.codeExecutionResult.outcome || 'UNKNOWN';
          codeOutput = `\n**Code Execution (${outcome}):**\n\`\`\`\n${chunk.codeExecutionResult.output}\n\`\`\`\n`;
        }
        
        // Handle executable code
        let executableCode = '';
        if (chunk.executableCode?.code) {
          const language = chunk.executableCode.language || 'python';
          executableCode = `\n**Generated Code (${language}):**\n\`\`\`${language.toLowerCase()}\n${chunk.executableCode.code}\n\`\`\`\n`;
        }
        
        fullResponse += chunkText + executableCode + codeOutput;

        // Extract metadata
        if (chunk.candidates?.[0]?.groundingMetadata) {
          groundingMetadata = chunk.candidates[0].groundingMetadata;
        }
        if (chunk.candidates?.[0]?.url_context_metadata) {
          urlContextMetadata = chunk.candidates[0].url_context_metadata;
        }
      }

      return {
        success: true,
        response: fullResponse,
        groundingMetadata,
        urlContextMetadata
      };

    } catch (error) {
      attempts++;
      console.error(`Search attempt ${attempts} failed:`, error.message);

      const isRateLimitError = RATE_LIMIT_ERRORS.some(code => 
        error.message?.includes(code) || 
        error.status === code || 
        error.code?.includes(code)
      );

      if (isRateLimitError && attempts < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempts), 8000);
        console.log(`Rate limit hit, waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (attempts >= MAX_RETRIES) {
        return {
          success: false,
          error: `Search failed after ${MAX_RETRIES} attempts: ${error.message}`
        };
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return {
    success: false,
    error: 'Search failed after maximum retries'
  };
}

/**
 * Send the search response to the user
 */
async function sendSearchResponse(
  interaction,
  responseText,
  groundingMetadata,
  urlContextMetadata,
  responseFormat,
  embedColor,
  showActionButtons
) {
  const MAX_CHAR_LIMIT = responseFormat === 'Embedded' ? 3900 : 1900;
  const isLargeResponse = responseText.length > MAX_CHAR_LIMIT;

  if (isLargeResponse) {
    // Send as file
    await sendAsTextFile(interaction, responseText);
  } else if (responseFormat === 'Embedded') {
    // Send as embed
    const embed = createSearchEmbed(
      responseText,
      groundingMetadata,
      urlContextMetadata,
      embedColor,
      interaction
    );
    
    const payload = { embeds: [embed] };
    
    if (showActionButtons) {
      payload.components = createActionButtons();
    }
    
    await interaction.editReply(payload);
  } else {
    // Send as plain text
    const payload = { content: responseText.slice(0, 2000) };
    
    if (showActionButtons) {
      payload.components = createActionButtons();
    }
    
    await interaction.editReply(payload);
  }
}

/**
 * Create search result embed
 */
function createSearchEmbed(responseText, groundingMetadata, urlContextMetadata, embedColor, interaction) {
  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setDescription(responseText.slice(0, 4096))
    .setTimestamp()
    .setAuthor({
      name: `Search Results for ${interaction.user.displayName}`,
      iconURL: interaction.user.displayAvatarURL()
    });

  // Add search queries if available
  if (groundingMetadata?.webSearchQueries?.length > 0) {
    embed.addFields({
      name: '🔍 Search Queries',
      value: groundingMetadata.webSearchQueries
        .slice(0, 3)
        .map(query => `• ${query}`)
        .join('\n'),
      inline: false
    });
  }

  // Add sources if available
  if (groundingMetadata?.groundingChunks?.length > 0) {
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

  // Add URL context if available
  if (urlContextMetadata?.url_metadata?.length > 0) {
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

  if (interaction.guild) {
    embed.setFooter({
      text: interaction.guild.name,
      iconURL: interaction.guild.iconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
    });
  }

  return embed;
}

/**
 * Create action buttons
 */
function createActionButtons() {
  const downloadButton = new ButtonBuilder()
    .setCustomId('download_message')
    .setLabel('Save')
    .setEmoji('💾')
    .setStyle(ButtonStyle.Secondary);

  const deleteButton = new ButtonBuilder()
    .setCustomId('delete_search_message')
    .setLabel('Delete')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);

  return [new ActionRowBuilder().addComponents(downloadButton, deleteButton)];
}

/**
 * Send response as text file
 */
async function sendAsTextFile(interaction, text) {
  try {
    const filename = `search-results-${Date.now()}.txt`;
    const tempFilePath = path.join(TEMP_DIR, filename);
    await fs.writeFile(tempFilePath, text);

    const content = `<@${interaction.user.id}>, your search results:`;

    await interaction.editReply({
      content,
      files: [tempFilePath],
      embeds: [],
      components: []
    });

    await fs.unlink(tempFilePath).catch(() => {});
  } catch (error) {
    console.error('Error sending as text file:', error);
    await interaction.editReply({
      content: '❌ Failed to send search results file.',
      embeds: [],
      components: []
    }).catch(() => {});
  }
      }
