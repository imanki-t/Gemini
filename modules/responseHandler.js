import { EmbedBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, ChannelType } from 'discord.js';
import path from 'path';
import fs from 'fs/promises';
import axios from 'axios';
import { TEMP_DIR, client } from '../botManager.js';
import config from '../config.js';

const hexColour = config.hexColour;

export function updateEmbed(botMessage, finalResponse, message, groundingMetadata = null, urlContextMetadata = null, effectiveSettings) {
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
      components: []
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

export async function sendAsTextFile(text, messageOrInteraction, orgId, continuousReply = false) {
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
      botMessage = await messageOrInteraction.editReply({
        content: content,
        files: [tempFilePath],
        embeds: [],
        components: []
      });
    } else {
      let messageToEdit = await channel.messages.fetch(orgId).catch(() => null);
      if (messageToEdit) {
        botMessage = await messageToEdit.edit({
          content: content,
          files: [tempFilePath],
          embeds: [],
          components: []
        });
      } else {
        botMessage = await channel.send({
          content: content,
          files: [tempFilePath]
        });
      }
    }

    await fs.unlink(tempFilePath).catch(() => {});
    return botMessage;
  } catch (error) {
    console.error('Error sending as text file:', error);
    await fs.unlink(path.join(TEMP_DIR, `response-${Date.now()}.txt`)).catch(() => {});
    return null;
  }
}

export async function addDownloadButton(botMessage) {
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

export async function addDeleteButton(botMessage, msgId) {
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

export function updateEmbedForInteraction(interaction, botMessage, finalResponse, groundingMetadata, urlContextMetadata, effectiveSettings) {
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
