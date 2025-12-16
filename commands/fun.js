import { EmbedBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { state, saveStateToFile, genAI, TEMP_DIR } from '../botManager.js';
import path from 'path';
import fs from 'fs/promises';

// Use lighter model for fun commands
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
  
  // Calculate stats
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

// ============= DIGEST COMMAND =============
export const digestCommand = {
  name: 'digest',
  description: 'Get a summary of recent server conversations'
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
  
  // Collect recent messages
  const allMessages = [];
  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  
  for (const messagesId in guildHistory) {
    const messages = guildHistory[messagesId];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg.timestamp && msg.timestamp > oneWeekAgo) {
          allMessages.push(msg);
        }
      }
    }
  }
  
  if (allMessages.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('📊 No Recent Activity')
      .setDescription('No conversations in the past week.');
    
    return interaction.editReply({
      embeds: [embed]
    });
  }
  
  // Generate summary with Gemini
  const conversationText = allMessages
    .slice(-100) // Last 100 messages
    .map(m => {
      const text = m.content?.map(c => c.text).join(' ') || '';
      const username = m.username || 'User';
      const timestamp = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
      return `[${timestamp}] ${username}: ${text}`;
    })
    .filter(t => t.length > 0)
    .join('\n');
  
  const chat = genAI.chats.create({
    model: FUN_MODEL,
    config: {
      systemInstruction: 'Analyze this conversation history and identify the top 3-5 most discussed topics. Format as a bulleted list with brief descriptions. Be concise.',
      temperature: 0.7
    }
  });
  
  const result = await chat.sendMessage({
    message: `Identify the main topics from this conversation:\n\n${conversationText.slice(0, 15000)}`
  });
  
  const topics = result.text || 'No clear topics identified.';
  
  // Create text file with full conversation
  const fileName = `${interaction.guild.name.replace(/[^a-z0-9]/gi, '_')}_digest_${Date.now()}.txt`;
  const filePath = path.join(TEMP_DIR, fileName);
  
  const fileContent = `Server Digest for ${interaction.guild.name}\nGenerated: ${new Date().toLocaleString()}\nPeriod: Last 7 days\nTotal Messages: ${allMessages.length}\n\n${'='.repeat(60)}\n\nTOP TOPICS:\n${topics}\n\n${'='.repeat(60)}\n\nFULL CONVERSATION:\n\n${conversationText}`;
  
  await fs.writeFile(filePath, fileContent, 'utf8');
  
  const attachment = new AttachmentBuilder(filePath, { name: fileName });
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📊 Weekly Digest')
    .setDescription(`**Most Talked About Topics:**\n\n${topics}`)
    .addFields(
      { name: '💬 Total Messages', value: allMessages.length.toString(), inline: true },
      { name: '📅 Period', value: 'Last 7 days', inline: true }
    )
    .setFooter({ text: `${interaction.guild.name} Digest • Full conversation attached` })
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],
    files: [attachment]
  });
  
  // Clean up temp file
  await fs.unlink(filePath).catch(() => {});
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
      type: 6, // USER type
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
  
  // Check opt-out
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
  
  // Generate personalized compliment with Gemini
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
  
  // Track compliment count
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
