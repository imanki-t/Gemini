import { EmbedBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { state, saveStateToFile, genAI, TEMP_DIR } from '../botManager.js';
import { memorySystem } from '../memorySystem.js';
import path from 'path';
import fs from 'fs/promises';

const FUN_MODEL = 'gemini-2.5-flash-lite';
const FALLBACK_MODEL = 'gemini-2.5-flash';
const MAX_COMPLIMENTS_PER_DAY = 15;
const MAX_STARTERS_PER_DAY = 15;

export const rouletteCommand = {
  name: 'roulette',
  description: 'Bot randomly reacts to messages in this channel'
};

export async function handleRouletteCommand(interaction) {
  const channelId = interaction.channelId;
  const guildId = interaction.guild?.id;
  
  if (!guildId) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Server Only')
      .setDescription('This command can only be used in servers!');
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  if (!state.roulette) {
    state.roulette = {};
  }
  
  const isActive = state.roulette[channelId]?.active || false;
  
  const embed = new EmbedBuilder()
    .setColor(0xFF6B6B)
    .setTitle('🎰 Reaction Roulette')
    .setDescription(`Configure reaction roulette for this channel.\n\n**Current Status:** ${isActive ? '✅ Active' : '❌ Inactive'}`);

  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId('roulette_action')
    .setPlaceholder('Choose an action')
    .addOptions(
      { label: 'Enable', value: 'enable', description: 'Start reacting to random messages', emoji: '✅' },
      { label: 'Disable', value: 'disable', description: 'Stop reactions', emoji: '❌' },
      { label: 'Set Rarity', value: 'rarity', description: 'Adjust reaction frequency', emoji: '⚙️' }
    );

  const row = new ActionRowBuilder().addComponents(actionSelect);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
}

export async function handleRouletteActionSelect(interaction) {
  const action = interaction.values[0];
  const channelId = interaction.channelId;
  
  if (action === 'enable') {
    if (!state.roulette[channelId]) {
      state.roulette[channelId] = {
        active: true,
        rarity: 'medium',
        guildId: interaction.guild.id
      };
    } else {
      state.roulette[channelId].active = true;
    }
    
    await saveStateToFile();
    
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Roulette Enabled')
      .setDescription('I\'ll now randomly react to messages in this channel! 🎰\n\n**Rarity:** ' + (state.roulette[channelId].rarity || 'medium'));

    await interaction.update({
      embeds: [embed],
      components: []
    });
    
  } else if (action === 'disable') {
    if (state.roulette[channelId]) {
      state.roulette[channelId].active = false;
      await saveStateToFile();
    }
    
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Roulette Disabled')
      .setDescription('Reaction roulette has been disabled for this channel.');

    await interaction.update({
      embeds: [embed],
      components: []
    });
    
  } else if (action === 'rarity') {
    const embed = new EmbedBuilder()
      .setColor(0xFF6B6B)
      .setTitle('⚙️ Set Reaction Rarity')
      .setDescription('How often should I react to messages?');

    const raritySelect = new StringSelectMenuBuilder()
      .setCustomId('roulette_rarity')
      .setPlaceholder('Select frequency')
      .addOptions(
        { label: 'Common', value: 'common', description: '~20% of messages', emoji: '🟢' },
        { label: 'Medium', value: 'medium', description: '~10% of messages', emoji: '🟡' },
        { label: 'Rare', value: 'rare', description: '~5% of messages', emoji: '🔴' },
        { label: 'Legendary', value: 'legendary', description: '~1% of messages', emoji: '✨' }
      );

    const row = new ActionRowBuilder().addComponents(raritySelect);

    await interaction.update({
      embeds: [embed],
      components: [row]
    });
  }
}

export async function handleRouletteRaritySelect(interaction) {
  const rarity = interaction.values[0];
  const channelId = interaction.channelId;
  
  if (!state.roulette[channelId]) {
    state.roulette[channelId] = {
      active: true,
      guildId: interaction.guild.id
    };
  }
  
  state.roulette[channelId].rarity = rarity;
  await saveStateToFile();
  
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Rarity Updated')
    .setDescription(`Reaction rarity set to **${rarity}**!`);

  await interaction.update({
    embeds: [embed],
    components: []
  });
}

export function checkRoulette(message) {
  const channelId = message.channelId;
  
  if (!state.roulette?.[channelId]?.active) return;
  
  const rarity = state.roulette[channelId].rarity || 'medium';
  const chances = {
    common: 0.20,
    medium: 0.10,
    rare: 0.05,
    legendary: 0.01
  };
  
  if (Math.random() < chances[rarity]) {
    const reactions = ['👍', '❤️', '😂', '😮', '😢', '😡', '🎉', '✨', '🔥', '👀', '🎯', '💯'];
    const randomReaction = reactions[Math.floor(Math.random() * reactions.length)];
    
    message.react(randomReaction).catch(() => {});
  }
}

export const anniversaryCommand = {
  name: 'anniversary',
  description: 'View bot\'s server anniversary info with detailed stats'
};

export async function handleAnniversaryCommand(interaction) {
  const guild = interaction.guild;
  
  if (!guild) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Server Only')
      .setDescription('This command can only be used in servers!');
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  try {
    const botMember = guild.members.cache.get(interaction.client.user.id);
    if (!botMember) {
      throw new Error('Bot member not found in cache');
    }
    
    const joinDate = botMember.joinedAt;
    const now = Date.now();
    const daysSince = Math.floor((now - joinDate.getTime()) / (1000 * 60 * 60 * 24));
    const yearsSince = Math.floor(daysSince / 365);
    const remainingDays = daysSince % 365;
    const monthsSince = Math.floor(remainingDays / 30);
    const finalDays = remainingDays % 30;
    
    const guildHistory = state.chatHistories?.[guild.id] || {};
    let totalMessages = 0;
    let userMessages = 0;
    let botMessages = 0;
    const uniqueUsers = new Set();
    const userMessageCounts = {};
    
    for (const messagesId in guildHistory) {
      const messages = guildHistory[messagesId];
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          totalMessages++;
          if (msg.role === 'user') {
            userMessages++;
            uniqueUsers.add(messagesId);
            userMessageCounts[messagesId] = (userMessageCounts[messagesId] || 0) + 1;
          } else if (msg.role === 'assistant') {
            botMessages++;
          }
        }
      }
    }
    
    const mostActiveUser = Object.entries(userMessageCounts)
      .sort(([, a], [, b]) => b - a)[0];
    
    const avgMessagesPerDay = daysSince > 0 ? (totalMessages / daysSince).toFixed(1) : '0';
    const avgMessagesPerUser = uniqueUsers.size > 0 ? (userMessages / uniqueUsers.size).toFixed(1) : '0';
    
    let timeDisplay = '';
    if (yearsSince > 0) {
      timeDisplay += `${yearsSince} year${yearsSince > 1 ? 's' : ''}`;
      if (monthsSince > 0 || finalDays > 0) timeDisplay += ', ';
    }
    if (monthsSince > 0) {
      timeDisplay += `${monthsSince} month${monthsSince > 1 ? 's' : ''}`;
      if (finalDays > 0) timeDisplay += ', ';
    }
    if (finalDays > 0 || timeDisplay === '') {
      timeDisplay += `${finalDays} day${finalDays !== 1 ? 's' : ''}`;
    }
    
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle(`🎊 ${guild.name} Anniversary`)
      .setDescription(`I've been part of **${guild.name}** for **${timeDisplay}**!\n\n**Join Date:** ${joinDate.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      })}`)
      .addFields(
        { name: '📊 Total Messages', value: totalMessages.toString(), inline: true },
        { name: '👥 Unique Users', value: uniqueUsers.size.toString(), inline: true },
        { name: '📅 Days Together', value: daysSince.toString(), inline: true },
        { name: '💬 User Messages', value: userMessages.toString(), inline: true },
        { name: '🤖 Bot Responses', value: botMessages.toString(), inline: true },
        { name: '📈 Avg/Day', value: avgMessagesPerDay, inline: true }
      )
      .setThumbnail(guild.iconURL())
      .setFooter({ text: 'Thank you for having me! 💙' })
      .setTimestamp();
    
    if (mostActiveUser && uniqueUsers.size > 0) {
      try {
        const topUser = await interaction.client.users.fetch(mostActiveUser[0]);
        embed.addFields({
          name: '⭐ Most Active User',
          value: `${topUser.username} (${mostActiveUser[1]} messages)`,
          inline: false
        });
      } catch (error) {
        console.error('Could not fetch most active user:', error);
      }
    }
    
    if (uniqueUsers.size > 0) {
      embed.addFields({
        name: '📊 Engagement',
        value: `${avgMessagesPerUser} avg messages per user`,
        inline: false
      });
    }

    await interaction.reply({
      embeds: [embed]
    });
  } catch (error) {
    console.error('Error in anniversary command:', error);
    
    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Error')
      .setDescription('Failed to retrieve anniversary information. Please try again later.');
    
    await interaction.reply({
      embeds: [errorEmbed],
      ephemeral: true
    });
  }
}

export const digestCommand = {
  name: 'digest',
  description: 'Get a weekly digest (7-day cooldown, analyzes 75 messages/day with AI)'
};

export async function handleDigestCommand(interaction) {
  const userId = interaction.user.id;
  const guildId = interaction.guild?.id;
  const isDM = !guildId;
  
  const COOLDOWN_DAYS = 7;
  const MESSAGES_PER_DAY = 75;
  const DAYS_TO_ANALYZE = 7;
  const now = Date.now();
  const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  
  if (!state.userDigests) {
    state.userDigests = {};
  }
  
  const digestKey = isDM ? `dm_${userId}` : `server_${guildId}`;
  const lastDigest = state.userDigests[digestKey];
  
  if (lastDigest && (now - lastDigest.timestamp) < cooldownMs) {
    const timeLeft = cooldownMs - (now - lastDigest.timestamp);
    const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
    
    const embed = new EmbedBuilder()
      .setColor(0xFFAA00)
      .setTitle('⏳ Digest on Cooldown')
      .setDescription(`You can generate a new digest in **${daysLeft} day${daysLeft !== 1 ? 's' : ''}**.\n\nShowing your last digest:`)
      .addFields(
        { name: '📅 Generated', value: new Date(lastDigest.timestamp).toLocaleString(), inline: true },
        { name: '💬 Messages Analyzed', value: lastDigest.messageCount.toString(), inline: true },
        { name: '📊 Days Covered', value: lastDigest.daysAnalyzed.toString(), inline: true }
      );
    
    if (lastDigest.summary) {
      embed.addFields({
        name: '📝 Summary',
        value: lastDigest.summary.slice(0, 1000)
      });
    }
    
    return interaction.reply({
      embeds: [embed]
    });
  }
  
  await interaction.deferReply();
  
  try {
    const historyId = isDM ? userId : guildId;
    const historyObject = state.chatHistories?.[historyId] || {};
    
    if (Object.keys(historyObject).length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ No History')
        .setDescription(isDM 
          ? 'No conversation history found in DMs with me.'
          : 'No conversation history found for this server.\n\nMake sure server-wide chat history is enabled in settings!');
      
      return interaction.editReply({
        embeds: [embed]
      });
    }
    
    const oneDayMs = 24 * 60 * 60 * 1000;
    const sevenDaysAgo = now - (DAYS_TO_ANALYZE * oneDayMs);
    
    const messagesByDay = {};
    for (let i = 0; i < DAYS_TO_ANALYZE; i++) {
      const dayStart = now - ((i + 1) * oneDayMs);
      const dayEnd = now - (i * oneDayMs);
      messagesByDay[i] = {
        dayIndex: i,
        dayLabel: new Date(dayEnd - oneDayMs/2).toLocaleDateString(),
        messages: []
      };
      
      for (const messagesId in historyObject) {
        const messages = historyObject[messagesId];
        if (Array.isArray(messages)) {
          for (const msg of messages) {
            if (msg.timestamp && msg.timestamp > dayStart && msg.timestamp <= dayEnd) {
              const text = msg.content?.map(c => c.text).filter(t => t).join(' ') || '';
              if (text.length > 0) {
                messagesByDay[i].messages.push({
                  text,
                  username: msg.username || 'User',
                  displayName: msg.displayName || msg.username || 'User',
                  timestamp: msg.timestamp,
                  role: msg.role
                });
              }
            }
          }
        }
      }
      
      messagesByDay[i].messages.sort((a, b) => a.timestamp - b.timestamp);
      messagesByDay[i].messages = messagesByDay[i].messages.slice(-MESSAGES_PER_DAY);
    }
    
    const totalMessages = Object.values(messagesByDay).reduce((sum, day) => sum + day.messages.length, 0);
    
    if (totalMessages === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('📊 No Recent Activity')
        .setDescription('No conversations in the past 7 days.');
      
      return interaction.editReply({
        embeds: [embed]
      });
    }
    
    const dayAnalyses = [];
    
    for (const [dayNum, dayData] of Object.entries(messagesByDay)) {
      if (dayData.messages.length === 0) continue;
      
      const dayText = dayData.messages
        .map(m => `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.displayName}: ${m.text}`)
        .join('\n');
      
      const embedding = await memorySystem.generateEmbedding(dayText, 'RETRIEVAL_DOCUMENT');
      
      dayAnalyses.push({
        dayIndex: parseInt(dayNum),
        dayLabel: dayData.dayLabel,
        messageCount: dayData.messages.length,
        text: dayText,
        embedding: embedding
      });
    }
    
    let fullConversationText = '';
    const summariesByDay = [];
    
    for (const dayAnalysis of dayAnalyses) {
      fullConversationText += `\n\n${'='.repeat(80)}\nDAY: ${dayAnalysis.dayLabel} (${dayAnalysis.messageCount} messages)\n${'='.repeat(80)}\n\n${dayAnalysis.text}\n`;
      
      try {
        const dayQuery = `Summarize the key topics, decisions, and highlights from ${dayAnalysis.dayLabel}`;
        const queryEmbedding = await memorySystem.generateEmbedding(dayQuery, 'RETRIEVAL_QUERY');
        
        const relevanceScore = queryEmbedding && dayAnalysis.embedding 
          ? memorySystem.cosineSimilarity(queryEmbedding, dayAnalysis.embedding)
          : 1.0;
        
        summariesByDay.push({
          day: dayAnalysis.dayLabel,
          messageCount: dayAnalysis.messageCount,
          relevanceScore: relevanceScore,
          preview: dayAnalysis.text.slice(0, 500)
        });
      } catch (error) {
        console.error(`Error analyzing day ${dayAnalysis.dayLabel}:`, error);
      }
    }
    
    const fileName = `digest_${digestKey}_${Date.now()}.txt`;
    const filePath = path.join(TEMP_DIR, fileName);
    
    const fileHeader = `${isDM ? 'DM' : 'Server'} Weekly Digest
Generated: ${new Date(now).toLocaleString()}
Period: Last ${DAYS_TO_ANALYZE} days
Total Messages Analyzed: ${totalMessages}
Messages Per Day Limit: ${MESSAGES_PER_DAY}

${'='.repeat(80)}
`;
    
    await fs.writeFile(filePath, fileHeader + fullConversationText, 'utf8');
    
    const uploadResult = await genAI.files.upload({
      path: filePath,
      config: {
        mimeType: 'text/plain',
        displayName: fileName
      }
    });
    
    let aiSummary;
    try {
      const request = {
        model: FUN_MODEL,
        contents: [{
          role: 'user',
          parts: [
            {
              fileUri: uploadResult.uri,
              mimeType: 'text/plain'
            },
            {
              text: `Analyze this ${DAYS_TO_ANALYZE}-day conversation history and create a CONCISE executive summary (max 300 words) covering:

1. Top 3-5 most discussed topics
2. Key decisions or action items
3. Notable events or announcements
4. Overall conversation themes
5. Day-by-day breakdown of activity

Be specific but brief. Focus on actionable insights.`
            }
          ]
        }],
        systemInstruction: {
          parts: [{
            text: 'You are a conversation analyst creating executive summaries. Be concise, specific, and highlight actionable insights. Use bullet points and clear structure.'
          }]
        },
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 800
        }
      };
      
      const result = await genAI.models.generateContent(request);
      aiSummary = result.text || 'Analysis completed. See full details in attached file.';
    } catch (error) {
      console.error('Error with flash-lite, trying fallback:', error);
      
      try {
        const request = {
          model: FALLBACK_MODEL,
          contents: [{
            role: 'user',
            parts: [
              {
                fileUri: uploadResult.uri,
                mimeType: 'text/plain'
              },
              {
                text: `Analyze this ${DAYS_TO_ANALYZE}-day conversation history and create a CONCISE executive summary (max 300 words) covering:

1. Top 3-5 most discussed topics
2. Key decisions or action items
3. Notable events or announcements
4. Overall conversation themes
5. Day-by-day breakdown of activity

Be specific but brief. Focus on actionable insights.`
              }
            ]
          }],
          systemInstruction: {
            parts: [{
              text: 'You are a conversation analyst creating executive summaries. Be concise, specific, and highlight actionable insights. Use bullet points and clear structure.'
            }]
          },
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 800
          }
        };
        
        const result = await genAI.models.generateContent(request);
        aiSummary = result.text || 'Analysis completed. See full details in attached file.';
      } catch (fallbackError) {
        console.error('Fallback model also failed:', fallbackError);
        aiSummary = 'Unable to generate AI summary. Please review the detailed conversation file.';
      }
    }
    
    state.userDigests[digestKey] = {
      timestamp: now,
      messageCount: totalMessages,
      summary: aiSummary,
      daysAnalyzed: DAYS_TO_ANALYZE
    };
    
    await saveStateToFile();
    
    const userFileName = `${isDM ? 'DM' : interaction.guild?.name?.replace(/[^a-z0-9]/gi, '_') || 'server'}_weekly_digest.txt`;
    const userFilePath = path.join(TEMP_DIR, userFileName);
    
    const fullReport = `Weekly Digest - ${isDM ? 'Direct Messages' : interaction.guild?.name || 'Server'}
Generated: ${new Date(now).toLocaleString()}
Period: Last ${DAYS_TO_ANALYZE} days
Messages Analyzed: ${totalMessages} (max ${MESSAGES_PER_DAY} per day)

${'='.repeat(80)}

AI EXECUTIVE SUMMARY:

${aiSummary}

${'='.repeat(80)}

DAILY BREAKDOWN:

${summariesByDay.map(s => `📅 ${s.day}: ${s.messageCount} messages analyzed`).join('\n')}

${'='.repeat(80)}

FULL CONVERSATION LOG:

${fullConversationText}`;
    
    await fs.writeFile(userFilePath, fullReport, 'utf8');
    
    const attachment = new AttachmentBuilder(userFilePath, { name: userFileName });
    
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Weekly Digest')
      .setDescription(aiSummary.slice(0, 2000))
      .addFields(
        { name: '💬 Total Messages', value: `${totalMessages} (${MESSAGES_PER_DAY}/day limit)`, inline: true },
        { name: '📅 Period', value: `Last ${DAYS_TO_ANALYZE} days`, inline: true },
        { name: '⏳ Next Digest', value: `${COOLDOWN_DAYS} days`, inline: true }
      )
      .setFooter({ text: `${isDM ? 'DM Digest' : interaction.guild?.name + ' • Server Digest'} • AI-powered analysis` })
      .setTimestamp();

    await interaction.editReply({
      embeds: [embed],
      files: [attachment]
    });
    
    await fs.unlink(filePath).catch(() => {});
    await fs.unlink(userFilePath).catch(() => {});
    
  } catch (error) {
    console.error('Digest generation error:', error);
    
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Generation Error')
      .setDescription(`Failed to generate digest: ${error.message}\n\nPlease try again later.`);
    
    try {
      await interaction.editReply({
        embeds: [embed]
      });
    } catch (editError) {
      console.error('Failed to edit reply with error:', editError);
    }
  }
}

export const starterCommand = {
  name: 'starter',
  description: 'Get a conversation starter (15 per day limit)'
};

export async function handleStarterCommand(interaction) {
  const userId = interaction.user.id;
  
  if (!state.starterUsage) {
    state.starterUsage = {};
  }
  
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  
  if (!state.starterUsage[userId]) {
    state.starterUsage[userId] = {
      count: 0,
      lastReset: now
    };
  }
  
  const usage = state.starterUsage[userId];
  
  if (now - usage.lastReset > ONE_DAY) {
    usage.count = 0;
    usage.lastReset = now;
  }
  
  if (usage.count >= MAX_STARTERS_PER_DAY) {
    const timeUntilReset = usage.lastReset + ONE_DAY - now;
    const hoursLeft = Math.ceil(timeUntilReset / (60 * 60 * 1000));
    
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Daily Limit Reached')
      .setDescription(`You've used all ${MAX_STARTERS_PER_DAY} conversation starters for today.\n\n**Resets in:** ${hoursLeft} hour${hoursLeft > 1 ? 's' : ''}`)
      .setFooter({ text: `${usage.count}/${MAX_STARTERS_PER_DAY} used today` });
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  await interaction.deferReply();
  
  try {
    const request = {
      model: FUN_MODEL,
      contents: [{
        role: 'user',
        parts: [{
          text: 'Generate one unique, engaging conversation starter question.'
        }]
      }],
      systemInstruction: {
        parts: [{
          text: 'Generate an interesting conversation starter question. Make it engaging, thought-provoking, and fun. Keep it to one sentence. Vary the topics: philosophy, hypotheticals, preferences, experiences, creativity.'
        }]
      },
      generationConfig: {
        temperature: 0.9
      }
    };
    
    const result = await genAI.models.generateContent(request);
    const question = result.text || 'What\'s the most interesting thing that happened to you this week?';
    
    usage.count++;
    await saveStateToFile();
    
    const remaining = MAX_STARTERS_PER_DAY - usage.count;
    
    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('💬 Conversation Starter')
      .setDescription(question)
      .setFooter({ text: `${remaining} starter${remaining !== 1 ? 's' : ''} remaining today • Use /starter for more!` });

    await interaction.editReply({
      embeds: [embed]
    });
  } catch (error) {
    console.error('Error with flash-lite, trying fallback:', error);
    
    try {
      const request = {
        model: FALLBACK_MODEL,
        contents: [{
          role: 'user',
          parts: [{
            text: 'Generate one unique, engaging conversation starter question.'
          }]
        }],
        systemInstruction: {
          parts: [{
            text: 'Generate an interesting conversation starter question. Make it engaging, thought-provoking, and fun. Keep it to one sentence. Vary the topics: philosophy, hypotheticals, preferences, experiences, creativity.'
          }]
        },
        generationConfig: {
          temperature: 0.9
        }
      };
      
      const result = await genAI.models.generateContent(request);
      const question = result.text || 'What\'s the most interesting thing that happened to you this week?';
      
      usage.count++;
      await saveStateToFile();
      
      const remaining = MAX_STARTERS_PER_DAY - usage.count;
      
      const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('💬 Conversation Starter')
        .setDescription(question)
        .setFooter({ text: `${remaining} starter${remaining !== 1 ? 's' : ''} remaining today` });

      await interaction.editReply({
        embeds: [embed]
      });
    } catch (fallbackError) {
      console.error('Fallback model also failed:', fallbackError);
      
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Error')
        .setDescription('Failed to generate a conversation starter. Please try again later.');
      
      await interaction.editReply({
        embeds: [embed]
      });
    }
  }
}

export const complimentCommand = {
  name: 'compliment',
  description: 'Send an anonymous compliment (15 per day limit)',
  options: [
    {
      name: 'user',
      description: 'User to compliment',
      type: 6,
      required: true
    }
  ]
};

export async function handleComplimentCommand(interaction) {
  const targetUser = interaction.options.getUser('user');
  const senderId = interaction.user.id;
  
  if (targetUser.id === senderId) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Self-Compliment')
      .setDescription('You can\'t send a compliment to yourself! But I appreciate your confidence! 😊');
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  if (targetUser.bot) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Bot Target')
      .setDescription('Bots don\'t need compliments (but I appreciate the thought! 🥰)');
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  if (!state.complimentOptOut) {
    state.complimentOptOut = {};
  }
  
  if (state.complimentOptOut[targetUser.id]) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Opt-Out')
      .setDescription('This user has opted out of receiving compliments.');
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  if (!state.complimentUsage) {
    state.complimentUsage = {};
  }
  
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  
  if (!state.complimentUsage[senderId]) {
    state.complimentUsage[senderId] = {
      count: 0,
      lastReset: now
    };
  }
  
  const usage = state.complimentUsage[senderId];
  
  if (now - usage.lastReset > ONE_DAY) {
    usage.count = 0;
    usage.lastReset = now;
  }
  
  if (usage.count >= MAX_COMPLIMENTS_PER_DAY) {
    const timeUntilReset = usage.lastReset + ONE_DAY - now;
    const hoursLeft = Math.ceil(timeUntilReset / (60 * 60 * 1000));
    
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Daily Limit Reached')
      .setDescription(`You've sent ${MAX_COMPLIMENTS_PER_DAY} compliments today.\n\n**Resets in:** ${hoursLeft} hour${hoursLeft > 1 ? 's' : ''}`)
      .setFooter({ text: `${usage.count}/${MAX_COMPLIMENTS_PER_DAY} compliments sent today` });
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const request = {
      model: FUN_MODEL,
      contents: [{
        role: 'user',
        parts: [{
          text: `Generate a sincere compliment for someone named ${targetUser.username}`
        }]
      }],
      systemInstruction: {
        parts: [{
          text: 'Generate a kind, genuine compliment (2-3 sentences). Be specific and heartfelt. Avoid generic phrases. Make it personal and meaningful.'
        }]
      },
      generationConfig: {
        temperature: 0.9
      }
    };
    
    const result = await genAI.models.generateContent(request);
    const compliment = result.text || 'You\'re an amazing person who brings joy to those around you! Keep being awesome! 🌟';
    
    if (!state.complimentCounts) {
      state.complimentCounts = {};
    }
    
    state.complimentCounts[targetUser.id] = (state.complimentCounts[targetUser.id] || 0) + 1;
    usage.count++;
    await saveStateToFile();
    
    const embed = new EmbedBuilder()
      .setColor(0xFF69B4)
      .setTitle('💝 You Received a Compliment!')
      .setDescription(compliment)
      .setFooter({ text: `You've received ${state.complimentCounts[targetUser.id]} compliment${state.complimentCounts[targetUser.id] > 1 ? 's' : ''}!` });

    try {
      await targetUser.send({ embeds: [embed] });
      
      const remaining = MAX_COMPLIMENTS_PER_DAY - usage.count;
      
      const confirmEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ Compliment Sent!')
        .setDescription(`Your anonymous compliment has been sent to ${targetUser.username}! 💝`)
        .setFooter({ text: `${remaining} compliment${remaining !== 1 ? 's' : ''} remaining today` });

      await interaction.editReply({
        embeds: [confirmEmbed]
      });
    } catch (error) {
      console.error('Failed to send compliment DM:', error);
      
      const errorEmbed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ DM Failed')
        .setDescription('Could not send the compliment. The user might have DMs disabled.');

      await interaction.editReply({
        embeds: [errorEmbed]
      });
    }
  } catch (error) {
    console.error('Error with flash-lite, trying fallback:', error);
    
    try {
      const request = {
        model: FALLBACK_MODEL,
        contents: [{
          role: 'user',
          parts: [{
            text: `Generate a sincere compliment for someone named ${targetUser.username}`
          }]
        }],
        systemInstruction: {
          parts: [{
            text: 'Generate a kind, genuine compliment (2-3 sentences). Be specific and heartfelt. Avoid generic phrases. Make it personal and meaningful.'
          }]
        },
        generationConfig: {
          temperature: 0.9
        }
      };
      
      const result = await genAI.models.generateContent(request);
      const compliment = result.text || 'You\'re an amazing person who brings joy to those around you! Keep being awesome! 🌟';
      
      if (!state.complimentCounts) {
        state.complimentCounts = {};
      }
      
      state.complimentCounts[targetUser.id] = (state.complimentCounts[targetUser.id] || 0) + 1;
      usage.count++;
      await saveStateToFile();
      
      const embed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle('💝 You Received a Compliment!')
        .setDescription(compliment)
        .setFooter({ text: `You've received ${state.complimentCounts[targetUser.id]} compliment${state.complimentCounts[targetUser.id] > 1 ? 's' : ''}!` });

      try {
        await targetUser.send({ embeds: [embed] });
        
        const remaining = MAX_COMPLIMENTS_PER_DAY - usage.count;
        
        const confirmEmbed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('✅ Compliment Sent!')
          .setDescription(`Your anonymous compliment has been sent to ${targetUser.username}! 💝`)
          .setFooter({ text: `${remaining} compliment${remaining !== 1 ? 's' : ''} remaining today` });

        await interaction.editReply({
          embeds: [confirmEmbed]
        });
      } catch (error) {
        console.error('Failed to send compliment DM:', error);
        
        const errorEmbed = new EmbedBuilder()
          .setColor(0xFF5555)
          .setTitle('❌ DM Failed')
          .setDescription('Could not send the compliment. The user might have DMs disabled.');

        await interaction.editReply({
          embeds: [errorEmbed]
        });
      }
    } catch (fallbackError) {
      console.error('Fallback model also failed:', fallbackError);
      
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Error')
        .setDescription('Failed to generate compliment. Please try again later.');
      
      await interaction.editReply({
        embeds: [embed]
      });
    }
  }
}
