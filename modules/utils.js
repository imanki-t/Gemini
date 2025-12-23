import { PermissionsBitField } from 'discord.js';
import axios from 'axios';
import { getTextExtractor } from 'office-text-extractor';
import { state, client } from '../botManager.js';
import config from '../config.js';

export function initializeBlacklistForGuild(guildId) {
  try {
    if (!state.blacklistedUsers[guildId]) {
      state.blacklistedUsers[guildId] = [];
    }
    if (!state.serverSettings[guildId]) {
      state.serverSettings[guildId] = {
        selectedModel: 'gemini-3-flash',
        responseFormat: 'Normal',
        showActionButtons: false,
        continuousReply: false,
        customPersonality: null,
        embedColor: config.hexColour,
        overrideUserSettings: true,
        serverChatHistory: false,
        allowedChannels: []
      };
    } else if (!state.serverSettings[guildId].allowedChannels) {
      state.serverSettings[guildId].allowedChannels = [];
    }
    
    if (state.serverSettings[guildId].showActionButtons === undefined) {
      state.serverSettings[guildId].showActionButtons = false;
    }
    if (state.serverSettings[guildId].continuousReply === undefined) {
      state.serverSettings[guildId].continuousReply = true;
    }
  } catch (error) {
    console.error('Error initializing blacklist for guild:', error);
  }
}

export async function uploadText(text) {
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
}

export function parseDiscordMessageLink(url) {
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

export async function fetchMessagesForSummary(message, messageLink, count = 1) {
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

export async function downloadAndReadFile(url, fileType) {
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
