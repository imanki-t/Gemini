import { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { state, saveStateToFile } from '../botManager.js';
import * as db from '../database.js';

export const timezoneCommand = {
  name: 'timezone',
  description: 'Set your timezone for time-based features (birthdays, reminders, quotes)'
};

const allTimezones = [
  { label: 'Pacific Time (PST/PDT)', value: 'America/Los_Angeles', emoji: '🌊' },
  { label: 'Mountain Time (MST/MDT)', value: 'America/Denver', emoji: '⛰️' },
  { label: 'Central Time (CST/CDT)', value: 'America/Chicago', emoji: '🌾' },
  { label: 'Eastern Time (EST/EDT)', value: 'America/New_York', emoji: '🗽' },
  { label: 'UK Time (GMT/BST)', value: 'Europe/London', emoji: '🇬🇧' },
  { label: 'Central European (CET/CEST)', value: 'Europe/Paris', emoji: '🇪🇺' },
  { label: 'India (IST)', value: 'Asia/Kolkata', emoji: '🇮🇳' },
  { label: 'China (CST)', value: 'Asia/Shanghai', emoji: '🇨🇳' },
  { label: 'Japan (JST)', value: 'Asia/Tokyo', emoji: '🇯🇵' },
  { label: 'Australia East (AEST/AEDT)', value: 'Australia/Sydney', emoji: '🇦🇺' },
  { label: 'New Zealand (NZST/NZDT)', value: 'Pacific/Auckland', emoji: '🇳🇿' },
  { label: 'UTC (Universal Time)', value: 'UTC', emoji: '🌍' },
  { label: 'Brazil (BRT)', value: 'America/Sao_Paulo', emoji: '🇧🇷' },
  { label: 'Argentina (ART)', value: 'America/Argentina/Buenos_Aires', emoji: '🇦🇷' },
  { label: 'South Africa (SAST)', value: 'Africa/Johannesburg', emoji: '🇿🇦' },
  { label: 'Dubai (GST)', value: 'Asia/Dubai', emoji: '🇦🇪' },
  { label: 'Singapore (SGT)', value: 'Asia/Singapore', emoji: '🇸🇬' },
  { label: 'Hong Kong (HKT)', value: 'Asia/Hong_Kong', emoji: '🇭🇰' },
  { label: 'South Korea (KST)', value: 'Asia/Seoul', emoji: '🇰🇷' },
  { label: 'Philippines (PHT)', value: 'Asia/Manila', emoji: '🇵🇭' },
  { label: 'Thailand (ICT)', value: 'Asia/Bangkok', emoji: '🇹🇭' },
  { label: 'Indonesia West (WIB)', value: 'Asia/Jakarta', emoji: '🇮🇩' },
  { label: 'Pakistan (PKT)', value: 'Asia/Karachi', emoji: '🇵🇰' },
  { label: 'Bangladesh (BST)', value: 'Asia/Dhaka', emoji: '🇧🇩' },
  { label: 'Russia Moscow (MSK)', value: 'Europe/Moscow', emoji: '🇷🇺' },
  { label: 'Turkey (TRT)', value: 'Europe/Istanbul', emoji: '🇹🇷' },
  { label: 'Egypt (EET)', value: 'Africa/Cairo', emoji: '🇪🇬' },
  { label: 'Kenya (EAT)', value: 'Africa/Nairobi', emoji: '🇰🇪' },
  { label: 'Nigeria (WAT)', value: 'Africa/Lagos', emoji: '🇳🇬' },
  { label: 'Mexico City (CST)', value: 'America/Mexico_City', emoji: '🇲🇽' },
  { label: 'Peru (PET)', value: 'America/Lima', emoji: '🇵🇪' },
  { label: 'Colombia (COT)', value: 'America/Bogota', emoji: '🇨🇴' },
  { label: 'Chile (CLT)', value: 'America/Santiago', emoji: '🇨🇱' },
  { label: 'Alaska (AKST/AKDT)', value: 'America/Anchorage', emoji: '🐻' },
  { label: 'Hawaii (HST)', value: 'Pacific/Honolulu', emoji: '🌺' }
];

const ITEMS_PER_PAGE = 25;

export async function handleTimezoneCommand(interaction) {
  const userId = interaction.user.id;
  const currentTz = state.userTimezones?.[userId] || 'Not set (using UTC)';
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🌍 Set Your Timezone')
    .setDescription(`Your timezone is used for:\n• Birthday wishes (sent at midnight your time)\n• Daily quotes (sent at your chosen time)\n• Reminders (scheduled in your local time)\n\n**Current Timezone:** ${currentTz}`)
    .setFooter({ text: 'Page 1 of 2 • Select your timezone below' });

  const page1Timezones = allTimezones.slice(0, ITEMS_PER_PAGE);
  
  const select = new StringSelectMenuBuilder()
    .setCustomId('timezone_select_page1')
    .setPlaceholder('Choose your timezone (Page 1)')
    .addOptions(page1Timezones);

  const nextButton = new ButtonBuilder()
    .setCustomId('timezone_next_page')
    .setLabel('Next Page')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('➡️');

  const row1 = new ActionRowBuilder().addComponents(select);
  const row2 = new ActionRowBuilder().addComponents(nextButton);

  await interaction.reply({
    embeds: [embed],
    components: [row1, row2],
    ephemeral: true
  });
}

export async function handleTimezoneNextPage(interaction) {
  const userId = interaction.user.id;
  const currentTz = state.userTimezones?.[userId] || 'Not set (using UTC)';
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🌍 Set Your Timezone')
    .setDescription(`Your timezone is used for:\n• Birthday wishes (sent at midnight your time)\n• Daily quotes (sent at your chosen time)\n• Reminders (scheduled in your local time)\n\n**Current Timezone:** ${currentTz}`)
    .setFooter({ text: 'Page 2 of 2 • Select your timezone below' });

  const page2Timezones = allTimezones.slice(ITEMS_PER_PAGE);
  
  const select = new StringSelectMenuBuilder()
    .setCustomId('timezone_select_page2')
    .setPlaceholder('Choose your timezone (Page 2)')
    .addOptions(page2Timezones);

  const backButton = new ButtonBuilder()
    .setCustomId('timezone_prev_page')
    .setLabel('Previous Page')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('◀️');

  const row1 = new ActionRowBuilder().addComponents(select);
  const row2 = new ActionRowBuilder().addComponents(backButton);

  await interaction.update({
    embeds: [embed],
    components: [row1, row2]
  });
}

export async function handleTimezonePrevPage(interaction) {
  const userId = interaction.user.id;
  const currentTz = state.userTimezones?.[userId] || 'Not set (using UTC)';
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🌍 Set Your Timezone')
    .setDescription(`Your timezone is used for:\n• Birthday wishes (sent at midnight your time)\n• Daily quotes (sent at your chosen time)\n• Reminders (scheduled in your local time)\n\n**Current Timezone:** ${currentTz}`)
    .setFooter({ text: 'Page 1 of 2 • Select your timezone below' });

  const page1Timezones = allTimezones.slice(0, ITEMS_PER_PAGE);
  
  const select = new StringSelectMenuBuilder()
    .setCustomId('timezone_select_page1')
    .setPlaceholder('Choose your timezone (Page 1)')
    .addOptions(page1Timezones);

  const nextButton = new ButtonBuilder()
    .setCustomId('timezone_next_page')
    .setLabel('Next Page')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('➡️');

  const row1 = new ActionRowBuilder().addComponents(select);
  const row2 = new ActionRowBuilder().addComponents(nextButton);

  await interaction.update({
    embeds: [embed],
    components: [row1, row2]
  });
}

export async function handleTimezoneSelect(interaction) {
  const timezone = interaction.values[0];
  const userId = interaction.user.id;
  
  if (!state.userTimezones) {
    state.userTimezones = {};
  }
  
  state.userTimezones[userId] = timezone;
  await db.saveUserTimezone(userId, timezone);
  await saveStateToFile();
  
  let currentTime;
  try {
    currentTime = new Date().toLocaleString('en-US', { 
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'long'
    });
  } catch (error) {
    currentTime = 'Unable to display';
  }
  
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Timezone Updated')
    .setDescription(`Your timezone has been set to **${timezone}**`)
    .addFields({
      name: '🕐 Current Time',
      value: currentTime
    })
    .setFooter({ text: 'All time-based features will now use your timezone!' });

  await interaction.update({
    embeds: [embed],
    components: []
  });
}

export function getUserTime(userId, date = new Date()) {
  const timezone = state.userTimezones?.[userId] || 'UTC';
  
  try {
    return new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  } catch (error) {
    console.error('Error getting user time:', error);
    return date;
  }
}

export function isUserHour(userId, targetHour) {
  const userTime = getUserTime(userId);
  return userTime.getHours() === targetHour;
}

export function getUserMidnight(userId) {
  const timezone = state.userTimezones?.[userId] || 'UTC';
  const now = new Date();
  
  try {
    const userNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    userNow.setHours(0, 0, 0, 0);
    return userNow;
  } catch (error) {
    const utcMidnight = new Date(now);
    utcMidnight.setHours(0, 0, 0, 0);
    return utcMidnight;
  }
}

export function formatTimeForUser(userId, date) {
  const timezone = state.userTimezones?.[userId] || 'UTC';
  
  try {
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  } catch (error) {
    return date.toLocaleString();
  }
    }
