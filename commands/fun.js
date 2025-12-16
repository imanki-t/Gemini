import { EmbedBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { state, saveStateToFile, genAI, TEMP_DIR } from '../botManager.js';
import { memorySystem } from '../memorySystem.js';
import path from 'path';
import fs from 'fs/promises';

const FUN_MODEL = 'gemini-2.0-flash-exp';

// ============= ROULETTE COMMAND =============
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

// ============= ANNIVERSARY COMMAND =============
export const anniversaryCommand = {
  name: 'anniversary',
  description: 'View bot\'s server anniversary info'
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
  
  const botMember = guild.members.cache.get(interaction.client.user.id);
  const joinDate = botMember.joinedAt;
  const daysSince = Math.floor((Date.now() - joinDate.getTime()) / (1000 * 60 * 60 * 24));
  const yearsSince = Math.floor(daysSince / 365);
  
  const guildHistory = state.chatHistories?.[guild.id] || {};
  let totalMessages = 0;
  const uniqueUsers = new Set();
  
  for (const messagesId in guildHistory) {
    const messages = guildHistory[messagesId];
    if (Array.isArray(messages)) {
      totalMessages += messages.length;
      uniqueUsers.add(messagesId);
    }
  }
  
  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`🎊 ${guild.name} Anniversary`)
    .setDescription(`I joined this server **${daysSince} days ago** (${yearsSince > 0 ? `${yearsSince} year${yearsSince > 1 ? 's' : ''}, ` : ''}${daysSince % 365} days)\n\n**Join Date:** ${joinDate.toLocaleDateString()}`)
    .addFields(
      { name: '💬 Total Messages', value: totalMessages.toString(), inline: true },
      { name: '👥 Users Helped', value: uniqueUsers.size.toString(), inline: true },
      { name: '📅 Days Together', value: daysSince.toString(), inline: true }
    )
    .setThumbnail(guild.iconURL())
    .setFooter({ text: 'Thank you for having me! 💙' })
    .setTimestamp();

  await interaction.reply({
    content: '@everyone 🎉',
    embeds: [embed]
  });
}

// ============= ENHANCED DIGEST COMMAND WITH VECTOR SEARCH =============
export const digestCommand = {
  name: 'digest',
  description: 'Get a weekly digest with AI-powered topic analysis (7-day cooldown)'
};

export async function handleDigestCommand(interaction) {
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
  
  // Check cooldown
  const COOLDOWN_DAYS = 7;
  const now = Date.now();
  const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  
  if (!state.serverDigests) {
    state.serverDigests = {};
  }
  
  const lastDigest = state.serverDigests[guildId];
  
  if (lastDigest && (now - lastDigest.timestamp) < cooldownMs) {
    const timeLeft = cooldownMs - (now - lastDigest.timestamp);
    const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
    
    const embed = new EmbedBuilder()
      .setColor(0xFFAA00)
      .setTitle('⏳ Digest on Cooldown')
      .setDescription(`You can generate a new digest in **${daysLeft} day${daysLeft !== 1 ? 's' : ''}**.\n\nShowing your last digest:`)
      .addFields(
        { name: '📅 Generated', value: new Date(lastDigest.timestamp).toLocaleString(), inline: true },
        { name: '💬 Messages Analyzed', value: lastDigest.messageCount.toString(), inline: true }
      );
    
    // Show last digest
    if (lastDigest.summary) {
      embed.addFields({
        name: '📊 Topics',
        value: lastDigest.summary.slice(0, 1000)
      });
    }
    
    return interaction.reply({
      embeds: [embed]
    });
  }
  
  await interaction.deferReply();
  
  const guildHistory = state.chatHistories?.[guildId] || {};
  
  if (Object.keys(guildHistory).length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ No History')
      .setDescription('No conversation history found for this server.\n\nMake sure server-wide chat history is enabled in settings!');
    
    return interaction.editReply({
      embeds: [embed]
    });
  }
  
  // Collect messages from last 7 days with vector search
  const DAYS_TO_ANALYZE = 7;
  const MESSAGES_PER_DAY = 7; // ~50 total messages (7 days * 7 messages)
  const oneDayMs = 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - (DAYS_TO_ANALYZE * oneDayMs);
  
  const allMessages = [];
  
  // Collect all messages from last 7 days
  for (const messagesId in guildHistory) {
    const messages = guildHistory[messagesId];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg.timestamp && msg.timestamp > sevenDaysAgo) {
          const text = msg.content?.map(c => c.text).join(' ') || '';
          if (text.length > 0) {
            allMessages.push({
              ...msg,
              text,
              username: msg.username || 'User',
              timestamp: msg.timestamp
            });
          }
        }
      }
    }
  }
  
  if (allMessages.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('📊 No Recent Activity')
      .setDescription('No conversations in the past 7 days.');
    
    return interaction.editReply({
      embeds: [embed]
    });
  }
  
  // Sort by timestamp
  allMessages.sort((a, b) => a.timestamp - b.timestamp);
  
  // Use vector search to find most important messages per day
  const selectedMessages = [];
  
  for (let dayOffset = 0; dayOffset < DAYS_TO_ANALYZE; dayOffset++) {
    const dayStart = now - ((dayOffset + 1) * oneDayMs);
    const dayEnd = now - (dayOffset * oneDayMs);
    
    const dayMessages = allMessages.filter(m => 
      m.timestamp >= dayStart && m.timestamp < dayEnd
    );
    
    if (dayMessages.length > 0) {
      if (dayMessages.length <= MESSAGES_PER_DAY) {
        selectedMessages.push(...dayMessages);
      } else {
        // Use vector search to find most relevant messages for this day
        try {
          const dayText = dayMessages.map(m => m.text).join(' ');
          const query = `What were the main topics discussed on ${new Date(dayStart).toLocaleDateString()}?`;
          
          const relevant = await memorySystem.getRelevantContext(guildId, query, { [guildId]: dayMessages });
          
          if (relevant && relevant.length > 0) {
            selectedMessages.push(...relevant.slice(0, MESSAGES_PER_DAY));
          } else {
            // Fallback: take most recent messages from that day
            selectedMessages.push(...dayMessages.slice(-MESSAGES_PER_DAY));
          }
        } catch (error) {
          console.error('Vector search error:', error);
          // Fallback
          selectedMessages.push(...dayMessages.slice(-MESSAGES_PER_DAY));
        }
      }
    }
  }
  
  // Limit to 50 messages total
  const finalMessages = selectedMessages.slice(-50);
  
  if (finalMessages.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('📊 No Analyzable Content')
      .setDescription('Could not find enough meaningful content to analyze.');
    
    return interaction.editReply({
      embeds: [embed]
    });
  }
  
  // Create conversation text file
  const conversationText = finalMessages
    .map(m => {
      const timestamp = new Date(m.timestamp).toLocaleString();
      return `[${timestamp}] ${m.username}: ${m.text}`;
    })
    .join('\n');
  
  // Upload conversation as file to Gemini API
  const fileName = `digest_${guildId}_${Date.now()}.txt`;
  const filePath = path.join(TEMP_DIR, fileName);
  
  await fs.writeFile(filePath, conversationText, 'utf8');
  
  try {
    // Upload file to Gemini
    const uploadResult = await genAI.files.upload({
      path: filePath,
      config: {
        mimeType: 'text/plain',
        displayName: fileName
      }
    });
    
    // Generate summary using uploaded file
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
            text: 'Analyze this week\'s conversation history and identify:\n1. Top 5 most discussed topics\n2. Key decisions or conclusions\n3. Notable events or announcements\n4. Overall conversation themes\n\nFormat as a clear, bulleted summary.'
          }
        ]
      }],
      systemInstruction: {
        parts: [{
          text: 'You are a conversation analyst. Provide concise, insightful summaries of discussion topics. Be specific and cite examples when relevant.'
        }]
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1000
      }
    };
    
    const result = await genAI.models.generateContent(request);
    const summary = result.text || 'No clear topics identified.';
    
    // Save digest data
    state.serverDigests[guildId] = {
      timestamp: now,
      messageCount: finalMessages.length,
      summary: summary,
      daysAnalyzed: DAYS_TO_ANALYZE
    };
    
    await saveStateToFile();
    
    // Create downloadable file for user
    const userFileName = `${interaction.guild.name.replace(/[^a-z0-9]/gi, '_')}_weekly_digest.txt`;
    const userFilePath = path.join(TEMP_DIR, userFileName);
    
    const fullReport = `Weekly Digest for ${interaction.guild.name}
Generated: ${new Date(now).toLocaleString()}
Period: Last ${DAYS_TO_ANALYZE} days
Messages Analyzed: ${finalMessages.length} (selected via AI from ${allMessages.length} total)

${'='.repeat(80)}

AI ANALYSIS:

${summary}

${'='.repeat(80)}

FULL CONVERSATION LOG:

${conversationText}`;
    
    await fs.writeFile(userFilePath, fullReport, 'utf8');
    
    const attachment = new AttachmentBuilder(userFilePath, { name: userFileName });
    
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Weekly Digest')
      .setDescription(summary.slice(0, 2000))
      .addFields(
        { name: '💬 Messages Analyzed', value: `${finalMessages.length} (from ${allMessages.length} total)`, inline: true },
        { name: '📅 Period', value: `Last ${DAYS_TO_ANALYZE} days`, inline: true },
        { name: '⏳ Next Digest', value: `Available in ${COOLDOWN_DAYS} days`, inline: true }
      )
      .setFooter({ text: `${interaction.guild.name} • AI-powered with vector search` })
      .setTimestamp();

    await interaction.editReply({
      embeds: [embed],
      files: [attachment]
    });
    
    // Clean up temp files
    await fs.unlink(filePath).catch(() => {});
    await fs.unlink(userFilePath).catch(() => {});
    
  } catch (error) {
    console.error('Digest generation error:', error);
    
    await fs.unlink(filePath).catch(() => {});
    
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Generation Error')
      .setDescription(`Failed to generate digest: ${error.message}`);
    
    await interaction.editReply({
      embeds: [embed]
    });
  }
}

// ============= STARTER COMMAND =============
export const starterCommand = {
  name: 'starter',
  description: 'Get a conversation starter'
};

export async function handleStarterCommand(interaction) {
  await interaction.deferReply();
  
  const chat = genAI.chats.create({
    model: FUN_MODEL,
    config: {
      systemInstruction: 'Generate an interesting conversation starter question. Make it engaging, thought-provoking, and fun. Keep it to one sentence.',
      temperature: 0.9
    }
  });
  
  const result = await chat.sendMessage({
    message: 'Generate one unique conversation starter question.'
  });
  
  const question = result.text || 'What\'s the most interesting thing that happened to you this week?';
  
  const embed = new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle('💬 Conversation Starter')
    .setDescription(question)
    .setFooter({ text: 'Use /starter for more ideas!' });

  await interaction.editReply({
    embeds: [embed]
  });
}

// ============= COMPLIMENT COMMAND =============
export const complimentCommand = {
  name: 'compliment',
  description: 'Send an anonymous compliment to someone',
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
  
  await interaction.deferReply({ ephemeral: true });
  
  const chat = genAI.chats.create({
    model: FUN_MODEL,
    config: {
      systemInstruction: 'Generate a kind, genuine compliment (2-3 sentences). Be specific and heartfelt. Avoid generic phrases.',
      temperature: 0.9
    }
  });
  
  const result = await chat.sendMessage({
    message: `Generate a sincere compliment for someone named ${targetUser.username}`
  });
  
  const compliment = result.text || 'You\'re an amazing person who brings joy to those around you! Keep being awesome! 🌟';
  
  if (!state.complimentCounts) {
    state.complimentCounts = {};
  }
  
  state.complimentCounts[targetUser.id] = (state.complimentCounts[targetUser.id] || 0) + 1;
  await saveStateToFile();
  
  const embed = new EmbedBuilder()
    .setColor(0xFF69B4)
    .setTitle('💝 You Received a Compliment!')
    .setDescription(compliment)
    .setFooter({ text: `You've received ${state.complimentCounts[targetUser.id]} compliment${state.complimentCounts[targetUser.id] > 1 ? 's' : ''}!` });

  try {
    await targetUser.send({ embeds: [embed] });
    
    const confirmEmbed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Compliment Sent!')
      .setDescription(`Your anonymous compliment has been sent to ${targetUser.username}! 💝`);

    await interaction.editReply({
      embeds: [confirmEmbed]
    });
  } catch (error) {
    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ DM Failed')
      .setDescription('Could not send the compliment. The user might have DMs disabled.');

    await interaction.editReply({
      embeds: [errorEmbed]
    });
  }
}
