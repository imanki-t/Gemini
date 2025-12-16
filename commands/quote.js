import { EmbedBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType } from 'discord.js';
import { state, saveStateToFile, genAI } from '../botManager.js';
import * as db from '../database.js';

export const quoteCommand = {
  name: 'quote',
  description: 'Daily inspirational quotes'
};

export async function handleQuoteCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('✨ Daily Quote Setup')
    .setDescription('What would you like to do?');

  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId('quote_action')
    .setPlaceholder('Choose an action')
    .addOptions(
      { label: 'Get Quote Now', value: 'now', description: 'Receive a quote immediately', emoji: '💭' },
      { label: 'Set Daily Quote', value: 'setup', description: 'Configure automatic daily quotes', emoji: '⏰' },
      { label: 'Remove Daily Quote', value: 'remove', description: 'Stop daily quotes', emoji: '🗑️' }
    );

  const row = new ActionRowBuilder().addComponents(actionSelect);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}

export async function handleQuoteActionSelect(interaction) {
  const action = interaction.values[0];
  
  if (action === 'now') {
    await sendQuoteNow(interaction);
  } else if (action === 'setup') {
    await showQuoteSetup(interaction);
  } else if (action === 'remove') {
    await removeQuoteSetup(interaction);
  }
}

async function sendQuoteNow(interaction) {
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setDescription('✨ Generating your quote...')],
    components: []
  });
  
  const quote = await generateQuote('inspirational');
  
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('💭 Quote of the Moment')
    .setDescription(quote)
    .setFooter({ text: 'Use /quote setup to receive daily quotes!' })
    .setTimestamp();

  await interaction.editReply({
    embeds: [embed],
    components: []
  });
}

async function showQuoteSetup(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('✨ Daily Quote Setup - Category')
    .setDescription('What type of quotes do you prefer?');

  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId('quote_category')
    .setPlaceholder('Select quote category')
    .addOptions(
      { label: 'Inspirational', value: 'inspirational', description: 'Motivational and uplifting', emoji: '🌟' },
      { label: 'Funny', value: 'funny', description: 'Humor and wit', emoji: '😂' },
      { label: 'Wisdom', value: 'wisdom', description: 'Philosophical and thoughtful', emoji: '🧠' },
      { label: 'Love', value: 'love', description: 'Romance and relationships', emoji: '💖' },
      { label: 'Success', value: 'success', description: 'Achievement and growth', emoji: '🎯' }
    );

  const row = new ActionRowBuilder().addComponents(categorySelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleQuoteCategorySelect(interaction) {
  const category = interaction.values[0];
  
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('✨ Daily Quote Setup - Time')
    .setDescription(`Category: **${category}**\n\nWhat time should I send your daily quote? (24h format)`);

  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId(`quote_time_${category}`)
    .setPlaceholder('Select time')
    .addOptions(
      { label: '06:00 (Morning)', value: '06:00', emoji: '🌅' },
      { label: '09:00 (Start of day)', value: '09:00', emoji: '☕' },
      { label: '12:00 (Noon)', value: '12:00', emoji: '🌞' },
      { label: '18:00 (Evening)', value: '18:00', emoji: '🌆' },
      { label: '21:00 (Night)', value: '21:00', emoji: '🌙' }
    );

  const row = new ActionRowBuilder().addComponents(timeSelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleQuoteTimeSelect(interaction) {
  const [_, __, category] = interaction.customId.split('_');
  const time = interaction.values[0];
  
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('✨ Daily Quote Setup - Location')
    .setDescription(`Category: **${category}**\nTime: **${time}**\n\nWhere should I send your daily quote?`);

  const locationSelect = new StringSelectMenuBuilder()
    .setCustomId(`quote_location_${category}_${time.replace(':', '-')}`)
    .setPlaceholder('Choose delivery location')
    .addOptions(
      { label: 'DM Only', value: 'dm', description: 'Receive in direct messages', emoji: '📬' },
      { label: 'Server Channel', value: 'server', description: 'Post in a specific channel', emoji: '💬' }
    );

  const row = new ActionRowBuilder().addComponents(locationSelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleQuoteLocationSelect(interaction) {
  const [_, __, category, timeStr] = interaction.customId.split('_');
  const time = timeStr.replace('-', ':');
  const location = interaction.values[0];
  
  if (location === 'server') {
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('✨ Daily Quote Setup - Channel')
      .setDescription('Select the channel where quotes should be posted:');

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`quote_channel_${category}_${timeStr}`)
      .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement])
      .setPlaceholder('Select a channel');

    const row = new ActionRowBuilder().addComponents(channelSelect);

    await interaction.update({
      embeds: [embed],
      components: [row]
    });
  } else {
    await finalizeQuoteSetup(interaction, category, time, 'dm', null);
  }
}

export async function handleQuoteChannelSelect(interaction) {
  const [_, __, category, timeStr] = interaction.customId.split('_');
  const time = timeStr.replace('-', ':');
  const channelId = interaction.values[0];
  
  await finalizeQuoteSetup(interaction, category, time, 'server', channelId);
}

async function finalizeQuoteSetup(interaction, category, time, location, channelId) {
  const userId = interaction.user.id;
  const guildId = interaction.guild?.id;
  
  if (!state.dailyQuotes) {
    state.dailyQuotes = {};
  }
  
  const [hour, minute] = time.split(':').map(Number);
  
  state.dailyQuotes[userId] = {
    category,
    hour,
    minute,
    location,
    channelId,
    guildId,
    active: true
  };
  
  await db.saveDailyQuote(userId, state.dailyQuotes[userId]);
  await saveStateToFile();
  
  const locationText = location === 'dm' 
    ? 'your DMs' 
    : `<#${channelId}>`;
  
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Daily Quote Activated!')
    .setDescription(`**Category:** ${category}\n**Time:** ${time}\n**Location:** ${locationText}\n\nYou'll receive a quote every day at this time! ✨`)
    .setFooter({ text: 'Use /quote remove to stop daily quotes' });

  await interaction.update({
    embeds: [embed],
    components: []
  });
  
  scheduleDailyQuote(interaction.client, userId, state.dailyQuotes[userId]);
}

async function removeQuoteSetup(interaction) {
  const userId = interaction.user.id;
  
  if (!state.dailyQuotes?.[userId]) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ No Daily Quote Setup')
      .setDescription('You don\'t have daily quotes configured.\n\nUse `/quote setup` to set them up!');
    
    return interaction.update({
      embeds: [embed],
      components: []
    });
  }
  
  delete state.dailyQuotes[userId];
  await db.deleteDailyQuote(userId);
  await saveStateToFile();
  
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Daily Quotes Disabled')
    .setDescription('Your daily quote subscription has been removed.');

  await interaction.update({
    embeds: [embed],
    components: []
  });
}

async function generateQuote(category) {
  const chat = genAI.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: `Generate a single ${category} quote. Format: "Quote text" - Author\n\nRules:\n- Keep quotes concise (1-2 sentences)\n- Include author name\n- Match the ${category} theme perfectly\n- Be inspiring and meaningful`,
      temperature: 0.9
    }
  });
  
  const result = await chat.sendMessage({
    message: `Generate one ${category} quote with author attribution.`
  });
  
  return result.text || '"The only way to do great work is to love what you do." - Steve Jobs';
}

export function scheduleDailyQuote(client, userId, config) {
  const checkAndSend = async () => {
    const now = new Date();
    if (now.getHours() === config.hour && now.getMinutes() === config.minute) {
      await sendDailyQuote(client, userId, config);
    }
  };
  
  // Check every minute
  const intervalId = setInterval(checkAndSend, 60 * 1000);
  
  if (!client.quoteIntervals) {
    client.quoteIntervals = new Map();
  }
  client.quoteIntervals.set(userId, intervalId);
}

async function sendDailyQuote(client, userId, config) {
  const quote = await generateQuote(config.category);
  
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`✨ Your Daily ${config.category.charAt(0).toUpperCase() + config.category.slice(1)} Quote`)
    .setDescription(quote)
    .setFooter({ text: 'Sent via /quote setup' })
    .setTimestamp();
  
  if (config.location === 'dm') {
    try {
      const user = await client.users.fetch(userId);
      await user.send({ embeds: [embed] });
    } catch (error) {
      console.error(`Could not send daily quote to ${userId}:`, error);
    }
  } else if (config.location === 'server' && config.channelId) {
    try {
      const channel = client.channels.cache.get(config.channelId);
      if (channel) {
        await channel.send({ embeds: [embed] });
      }
    } catch (error) {
      console.error(`Could not send daily quote to channel ${config.channelId}:`, error);
    }
  }
}

export function initializeDailyQuotes(client) {
  if (!state.dailyQuotes) return;
  
  for (const userId in state.dailyQuotes) {
    if (state.dailyQuotes[userId].active) {
      scheduleDailyQuote(client, userId, state.dailyQuotes[userId]);
    }
  }
}
