import { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
import { state, saveStateToFile } from '../botManager.js';

export const timezoneCommand = {
  name: 'timezone',
  description: 'Set your timezone for time-based features (birthdays, reminders, quotes)'
};

// Common timezones for quick selection
const commonTimezones = [
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
  { label: 'UTC (Universal Time)', value: 'UTC', emoji: '🌍' }
];

export async function handleTimezoneCommand(interaction) {
  const userId = interaction.user.id;
  const currentTz = state.userTimezones?.[userId] || 'Not set (using UTC)';
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🌍 Set Your Timezone')
    .setDescription(`Your timezone is used for:\n• Birthday wishes (sent at midnight your time)\n• Daily quotes (sent at your chosen time)\n• Reminders (scheduled in your local time)\n\n**Current Timezone:** ${currentTz}`)
    .setFooter({ text: 'Select your timezone below' });

  const select = new StringSelectMenuBuilder()
    .setCustomId('timezone_select')
    .setPlaceholder('Choose your timezone')
    .addOptions(commonTimezones);

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
}

export async function handleTimezoneSelect(interaction) {
  const timezone = interaction.values[0];
  const userId = interaction.user.id;
  
  if (!state.userTimezones) {
    state.userTimezones = {};
  }
  
  state.userTimezones[userId] = timezone;
  await saveStateToFile();
  
  // Get current time in selected timezone
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

// Utility function to get user's local time
export function getUserTime(userId, date = new Date()) {
  const timezone = state.userTimezones?.[userId] || 'UTC';
  
  try {
    return new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  } catch (error) {
    console.error('Error getting user time:', error);
    return date; // Fallback to UTC
  }
}

// Utility function to check if it's a specific hour in user's timezone
export function isUserHour(userId, targetHour) {
  const userTime = getUserTime(userId);
  return userTime.getHours() === targetHour;
}

// Utility function to get midnight in user's timezone
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

// Format time for display in user's timezone
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
