import { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType } from 'discord.js';
import { state, saveStateToFile, genAI } from '../botManager.js';
import * as db from '../database.js';

const QUOTE_MODEL = 'gemini-2.5-flash-lite';
const FALLBACK_MODEL = 'gemini-2.5-flash';
const MAX_QUOTES_PER_DAY = 5;
const MAX_SCHEDULED_QUOTES_PER_USER = 2;

export const quoteCommand = {
  name: 'quote',
  description: 'Daily inspirational quotes (5 instant/day, 2 scheduled max)'
};

export async function handleQuoteCommand(interaction) {
  const userId = interaction.user.id;
  
  if (!state.quoteUsage) state.quoteUsage = {};
  
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  
  if (!state.quoteUsage[userId]) {
    state.quoteUsage[userId] = { count: 0, lastReset: now };
  }
  
  const usage = state.quoteUsage[userId];
  if (now - usage.lastReset > ONE_DAY) {
    usage.count = 0;
    usage.lastReset = now;
  }
  
  const scheduledQuotes = Object.keys(state.dailyQuotes || {}).filter(key => 
    key === userId || key.startsWith(userId + '_')
  ).length;
  
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('✨ Quote System')
    .setDescription(`What would you like to do?\n\n**Instant Quotes:** ${usage.count}/${MAX_QUOTES_PER_DAY} used today\n**Scheduled Quotes:** ${scheduledQuotes}/${MAX_SCHEDULED_QUOTES_PER_USER} active`)
    .setFooter({ text: 'This menu will expire in 3 minutes.' });

  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId(`quote_action_${userId}`)
    .setPlaceholder('Choose an action')
    .addOptions(
      { label: 'Get Quote Now', value: 'now', description: 'Instant inspirational quote (Public)', emoji: '💭' },
      { label: 'Set Daily Quote', value: 'setup', description: 'Schedule automatic quotes', emoji: '⏰' },
      { label: 'View Scheduled', value: 'view', description: 'See your active schedules', emoji: '📋' },
      { label: 'Remove Daily Quote', value: 'remove', description: 'Stop a scheduled quote', emoji: '🗑️' }
    );

  const row = new ActionRowBuilder().addComponents(actionSelect);

  // 1. Initial Menu is Ephemeral
  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });

  // 2. Expiration: Delete after 3 minutes if not used
  setTimeout(() => {
    interaction.deleteReply().catch(() => {
      // Ignore error if message was already deleted/updated
    });
  }, 3 * 60 * 1000);
}

export async function handleQuoteActionSelect(interaction) {
  const action = interaction.values[0];
  
  if (action === 'now') await sendQuoteNow(interaction);
  else if (action === 'setup') await showQuoteSetup(interaction);
  else if (action === 'view') await viewScheduledQuotes(interaction);
  else if (action === 'remove') await removeQuoteSetup(interaction);
}

async function sendQuoteNow(interaction) {
  const userId = interaction.user.id;
  const usage = state.quoteUsage[userId];
  
  // Check Limit
  if (usage.count >= MAX_QUOTES_PER_DAY) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xFF5555).setTitle('❌ Limit Reached').setDescription("Daily limit reached. Try again tomorrow!")],
      components: []
    });
  }
  
  // Update ephemeral menu to indicate processing
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setDescription('✨ Generating public quote...')],
    components: []
  });
  
  // Generate Quote
  const quote = await generateQuote('inspirational');
  usage.count++;
  await saveStateToFile();
  
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('💭 Instant Quote')
    .setDescription(quote)
    .setFooter({ text: `${MAX_QUOTES_PER_DAY - usage.count} left for today` });

  // 3. Send as Normal (Public) Message to channel
  await interaction.channel.send({ embeds: [embed] });

  // 4. Delete the ephemeral menu (cleanup)
  try {
    await interaction.deleteReply();
  } catch (e) {
    // If delete fails, just edit it to say sent
    await interaction.editReply({ content: "✅ Quote sent publicly!", embeds: [], components: [] });
  }
}

async function showQuoteSetup(interaction) {
  const userId = interaction.user.id;
  const scheduledCount = Object.keys(state.dailyQuotes || {}).filter(k => k === userId || k.startsWith(userId + '_')).length;
  
  if (scheduledCount >= MAX_SCHEDULED_QUOTES_PER_USER) {
    return interaction.update({ embeds: [new EmbedBuilder().setColor(0xFF5555).setDescription("Limit reached.")], components: [] });
  }
  
  const categorySelect = new StringSelectMenuBuilder()
    .setCustomId(`quote_category_${userId}`)
    .setPlaceholder('Select category')
    .addOptions(
      { label: 'Inspirational', value: 'inspirational', emoji: '🌟' },
      { label: 'Funny', value: 'funny', emoji: '😂' },
      { label: 'Wisdom', value: 'wisdom', emoji: '🧠' }
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle('✨ Category Selection').setDescription("Choose a category:")],
    components: [new ActionRowBuilder().addComponents(categorySelect)]
  });
}

export async function handleQuoteCategorySelect(interaction) {
  const category = interaction.values[0];
  const userId = interaction.user.id;
  
  const timeSelect = new StringSelectMenuBuilder()
    .setCustomId(`quote_time_${category}_${userId}`)
    .setPlaceholder('Select delivery time')
    .addOptions(
      { label: '06:00 (Morning)', value: '06:00', emoji: '🌅' },
      { label: '12:00 (Noon)', value: '12:00', emoji: '🌞' },
      { label: '21:00 (Night)', value: '21:00', emoji: '🌙' }
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle('⏰ Time Selection').setDescription(`Selected: **${category}**\nWhen should I send it?`)],
    components: [new ActionRowBuilder().addComponents(timeSelect)]
  });
}

export async function handleQuoteTimeSelect(interaction) {
  const parts = interaction.customId.split('_');
  const category = parts[2];
  const userId = interaction.user.id;
  const time = interaction.values[0];
  
  const locationSelect = new StringSelectMenuBuilder()
    .setCustomId(`quote_loc_${category}_${time.replace(':','-')}_${userId}`)
    .setPlaceholder('Delivery Location')
    .addOptions(
      { label: 'DM Only', value: 'dm', emoji: '📬' },
      { label: 'This Server', value: 'server', emoji: '💬' }
    );

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle('📬 Location').setDescription(`Time: **${time}**\nWhere to send?`)],
    components: [new ActionRowBuilder().addComponents(locationSelect)]
  });
}

export async function handleQuoteLocationSelect(interaction) {
  const parts = interaction.customId.split('_');
  const category = parts[2];
  const time = parts[3].replace('-',':');
  const userId = interaction.user.id;
  const location = interaction.values[0];
  
  if (location === 'server' && interaction.guild) {
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`quote_chan_${category}_${parts[3]}_${userId}`)
      .setChannelTypes([ChannelType.GuildText]);

    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x9B59B6).setTitle('💬 Channel Selection').setDescription("Select a channel:")],
      components: [new ActionRowBuilder().addComponents(channelSelect)]
    });
  } else {
    await finalizeQuoteSetup(interaction, category, time, 'dm', null);
  }
}

export async function handleQuoteChannelSelect(interaction) {
  const parts = interaction.customId.split('_');
  const category = parts[2];
  const time = parts[3].replace('-',':');
  const channelId = interaction.values[0];
  
  await finalizeQuoteSetup(interaction, category, time, 'server', channelId);
}

async function finalizeQuoteSetup(interaction, category, time, location, channelId) {
  const userId = interaction.user.id;
  const scheduledCount = Object.keys(state.dailyQuotes || {}).filter(k => k === userId || k.startsWith(userId + '_')).length;
  const [hour, minute] = time.split(':').map(Number);
  const quoteKey = scheduledCount === 0 ? userId : `${userId}_${scheduledCount + 1}`;
  
  state.dailyQuotes[quoteKey] = { category, hour, minute, location, channelId, active: true };
  await db.saveDailyQuote(quoteKey, state.dailyQuotes[quoteKey]);
  await saveStateToFile();
  
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('✅ Success').setDescription(`Daily **${category}** quotes set for **${time}**!`)],
    components: []
  });
}

async function viewScheduledQuotes(interaction) {
  const userId = interaction.user.id;
  const userQuotes = Object.entries(state.dailyQuotes || {}).filter(([k]) => k === userId || k.startsWith(userId + '_'));
  
  if (userQuotes.length === 0) return interaction.update({ content: "No schedules found.", components: [] });
  
  const list = userQuotes.map(([_, d], i) => `${i+1}. ${d.category} @ ${String(d.hour).padStart(2,'0')}:${String(d.minute).padStart(2,'0')}`).join('\n');
  await interaction.update({ embeds: [new EmbedBuilder().setTitle('📋 Your Quotes').setDescription(list)], components: [] });
}

async function removeQuoteSetup(interaction) {
  const userId = interaction.user.id;
  const userQuotes = Object.entries(state.dailyQuotes || {}).filter(([k]) => k === userId || k.startsWith(userId + '_'));
  
  if (userQuotes.length === 0) return interaction.update({ content: "Nothing to remove.", components: [] });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`quote_rem_sel_${userId}`)
    .addOptions(userQuotes.map(([k, d]) => ({ label: `${d.category} @ ${d.hour}:${d.minute}`, value: k })));

  await interaction.update({ components: [new ActionRowBuilder().addComponents(menu)] });
}

export async function handleQuoteRemoveSelect(interaction) {
  const key = interaction.values[0];
  delete state.dailyQuotes[key];
  await db.deleteDailyQuote(key);
  await saveStateToFile();
  await interaction.update({ content: "✅ Quote schedule removed.", embeds: [], components: [] });
}

async function generateQuote(category) {
  try {
    const prompt = `Generate a short ${category} quote with author attribution. Format: "Text" - Author`;
    const result = await genAI.models.generateContent({ model: QUOTE_MODEL, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
    return result.text || '"Be yourself; everyone else is already taken." - Oscar Wilde';
  } catch {
    return '"The only way to do great work is to love what you do." - Steve Jobs';
  }
}

export function initializeDailyQuotes(client) {
  if (!state.dailyQuotes) return;
  
  for (const quoteKey in state.dailyQuotes) {
    if (state.dailyQuotes[quoteKey].active) {
      scheduleDailyQuote(client, quoteKey, state.dailyQuotes[quoteKey]);
    }
  }
}

export function scheduleDailyQuote(client, quoteKey, config) {
  const checkAndSend = async () => {
    const now = new Date();
    if (now.getHours() === config.hour && now.getMinutes() === config.minute) {
      await sendDailyQuote(client, quoteKey, config);
    }
  };
  
  const intervalId = setInterval(checkAndSend, 60 * 1000);
  
  if (!client.quoteIntervals) {
    client.quoteIntervals = new Map();
  }
  client.quoteIntervals.set(quoteKey, intervalId);
}

async function sendDailyQuote(client, quoteKey, config) {
  const quote = await generateQuote(config.category);
  const userId = quoteKey.split('_')[0];
  
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`✨ Daily ${config.category} Quote`)
    .setDescription(quote)
    .setTimestamp();
  
  if (config.location === 'dm') {
    try {
      const user = await client.users.fetch(userId);
      await user.send({ embeds: [embed] });
    } catch (err) { console.error(err); }
  } else if (config.location === 'server' && config.channelId) {
    try {
      const channel = client.channels.cache.get(config.channelId);
      if (channel) await channel.send({ embeds: [embed] });
    } catch (err) { console.error(err); }
  }
    }
