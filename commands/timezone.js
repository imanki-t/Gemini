import { EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { state, saveStateToFile } from '../botManager.js';
import * as db from '../database.js';

export const timezoneCommand = {
  name: 'timezone',
  description: 'Set your timezone for time-based features (birthdays, reminders, quotes)'
};

// Data Structure for Regions and Timezones
const TIMEZONE_DATA = {
  'North America': [
    { label: 'New York (EST/EDT)', value: 'America/New_York', emoji: '🗽' },
    { label: 'Chicago (CST/CDT)', value: 'America/Chicago', emoji: '🌾' },
    { label: 'Denver (MST/MDT)', value: 'America/Denver', emoji: '⛰️' },
    { label: 'Los Angeles (PST/PDT)', value: 'America/Los_Angeles', emoji: '🌊' },
    { label: 'Phoenix (MST)', value: 'America/Phoenix', emoji: '🏜️' },
    { label: 'Anchorage (AKST/AKDT)', value: 'America/Anchorage', emoji: '🐻' },
    { label: 'Honolulu (HST)', value: 'Pacific/Honolulu', emoji: '🌺' },
    { label: 'Toronto', value: 'America/Toronto', emoji: '🍁' },
    { label: 'Vancouver', value: 'America/Vancouver', emoji: '🌧️' },
    { label: 'Mexico City', value: 'America/Mexico_City', emoji: '🇲🇽' },
    { label: 'Santo Domingo', value: 'America/Santo_Domingo', emoji: '🇩🇴' },
    { label: 'Guatemala', value: 'America/Guatemala', emoji: '🇬🇹' },
    { label: 'Costa Rica', value: 'America/Costa_Rica', emoji: '🇨🇷' },
    { label: 'Puerto Rico', value: 'America/Puerto_Rico', emoji: '🇵🇷' },
    { label: 'Jamaica', value: 'America/Jamaica', emoji: '🇯🇲' }
  ],
  'Europe': [
    { label: 'London (GMT/BST)', value: 'Europe/London', emoji: '🇬🇧' },
    { label: 'Paris (CET/CEST)', value: 'Europe/Paris', emoji: '🇫🇷' },
    { label: 'Berlin', value: 'Europe/Berlin', emoji: '🇩🇪' },
    { label: 'Madrid', value: 'Europe/Madrid', emoji: '🇪🇸' },
    { label: 'Rome', value: 'Europe/Rome', emoji: '🇮🇹' },
    { label: 'Amsterdam', value: 'Europe/Amsterdam', emoji: '🇳🇱' },
    { label: 'Moscow (MSK)', value: 'Europe/Moscow', emoji: '🇷🇺' },
    { label: 'Istanbul', value: 'Europe/Istanbul', emoji: '🇹🇷' },
    { label: 'Kiev', value: 'Europe/Kiev', emoji: '🇺🇦' },
    { label: 'Athens', value: 'Europe/Athens', emoji: '🇬🇷' },
    { label: 'Warsaw', value: 'Europe/Warsaw', emoji: '🇵🇱' },
    { label: 'Zurich', value: 'Europe/Zurich', emoji: '🇨🇭' },
    { label: 'Stockholm', value: 'Europe/Stockholm', emoji: '🇸🇪' },
    { label: 'Oslo', value: 'Europe/Oslo', emoji: '🇳🇴' },
    { label: 'Vienna', value: 'Europe/Vienna', emoji: '🇦🇹' }
  ],
  'Asia': [
    { label: 'Tokyo (JST)', value: 'Asia/Tokyo', emoji: '🇯🇵' },
    { label: 'Shanghai (CST)', value: 'Asia/Shanghai', emoji: '🇨🇳' },
    { label: 'Singapore (SGT)', value: 'Asia/Shanghai', emoji: '🇸🇬' },
    { label: 'Hong Kong (HKT)', value: 'Asia/Hong_Kong', emoji: '🇭🇰' },
    { label: 'Seoul (KST)', value: 'Asia/Seoul', emoji: '🇰🇷' },
    { label: 'Kolkata (IST)', value: 'Asia/Kolkata', emoji: '🇮🇳' },
    { label: 'Dubai (GST)', value: 'Asia/Dubai', emoji: '🇦🇪' },
    { label: 'Bangkok (ICT)', value: 'Asia/Bangkok', emoji: '🇹🇭' },
    { label: 'Jakarta (WIB)', value: 'Asia/Jakarta', emoji: '🇮🇩' },
    { label: 'Manila (PHT)', value: 'Asia/Manila', emoji: '🇵🇭' },
    { label: 'Taipei', value: 'Asia/Taipei', emoji: '🇹🇼' },
    { label: 'Kuala Lumpur', value: 'Asia/Kuala_Lumpur', emoji: '🇲🇾' },
    { label: 'Ho Chi Minh', value: 'Asia/Ho_Chi_Minh', emoji: '🇻🇳' },
    { label: 'Riyadh', value: 'Asia/Riyadh', emoji: '🇸🇦' },
    { label: 'Tehran', value: 'Asia/Tehran', emoji: '🇮🇷' }
  ],
  'Oceania': [
    { label: 'Sydney (AEST)', value: 'Australia/Sydney', emoji: '🇦🇺' },
    { label: 'Melbourne', value: 'Australia/Melbourne', emoji: '🏙️' },
    { label: 'Brisbane', value: 'Australia/Brisbane', emoji: '🏖️' },
    { label: 'Perth', value: 'Australia/Perth', emoji: '🌅' },
    { label: 'Adelaide', value: 'Australia/Adelaide', emoji: '🍷' },
    { label: 'Auckland (NZST)', value: 'Pacific/Auckland', emoji: '🇳🇿' },
    { label: 'Wellington', value: 'Pacific/Wellington', emoji: '🌬️' },
    { label: 'Fiji', value: 'Pacific/Fiji', emoji: '🇫🇯' },
    { label: 'Guam', value: 'Pacific/Guam', emoji: '🇬🇺' },
    { label: 'Port Moresby', value: 'Pacific/Port_Moresby', emoji: '🇵🇬' }
  ],
  'South America': [
    { label: 'Sao Paulo (BRT)', value: 'America/Sao_Paulo', emoji: '🇧🇷' },
    { label: 'Buenos Aires (ART)', value: 'America/Argentina/Buenos_Aires', emoji: '🇦🇷' },
    { label: 'Santiago', value: 'America/Santiago', emoji: '🇨🇱' },
    { label: 'Bogota', value: 'America/Bogota', emoji: '🇨🇴' },
    { label: 'Lima', value: 'America/Lima', emoji: '🇵🇪' },
    { label: 'Caracas', value: 'America/Caracas', emoji: '🇻🇪' },
    { label: 'Montevideo', value: 'America/Montevideo', emoji: '🇺🇾' },
    { label: 'La Paz', value: 'America/La_Paz', emoji: '🇧🇴' },
    { label: 'Quito', value: 'America/Guayaquil', emoji: '🇪🇨' },
    { label: 'Asuncion', value: 'America/Asuncion', emoji: '🇵🇾' }
  ],
  'Africa': [
    { label: 'Cairo (EET)', value: 'Africa/Cairo', emoji: '🇪🇬' },
    { label: 'Johannesburg (SAST)', value: 'Africa/Johannesburg', emoji: '🇿🇦' },
    { label: 'Lagos (WAT)', value: 'Africa/Lagos', emoji: '🇳🇬' },
    { label: 'Nairobi (EAT)', value: 'Africa/Nairobi', emoji: '🇰🇪' },
    { label: 'Casablanca', value: 'Africa/Casablanca', emoji: '🇲🇦' },
    { label: 'Accra', value: 'Africa/Accra', emoji: '🇬🇭' },
    { label: 'Addis Ababa', value: 'Africa/Addis_Ababa', emoji: '🇪🇹' },
    { label: 'Algiers', value: 'Africa/Algiers', emoji: '🇩🇿' },
    { label: 'Tunis', value: 'Africa/Tunis', emoji: '🇹🇳' },
    { label: 'Kinshasa', value: 'Africa/Kinshasa', emoji: '🇨🇩' }
  ],
  'UTC': [
    { label: 'Universal Time (UTC)', value: 'UTC', emoji: '🌍' }
  ]
};

const ITEMS_PER_PAGE = 5;

// Initial Command - Region Selection
export async function handleTimezoneCommand(interaction) {
  const userId = interaction.user.id;
  const currentTz = state.userTimezones?.[userId] || 'Not set (using UTC)';
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🌍 Timezone Setup')
    .setDescription(`Select your region to find your timezone.\n\n**Current Timezone:** \`${currentTz}\``)
    .setFooter({ text: 'Setting your timezone ensures reminders and birthdays happen at the right time.' });

  const regions = Object.keys(TIMEZONE_DATA);
  const regionOptions = regions.map(region => ({
    label: region,
    value: region,
    emoji: getRegionEmoji(region)
  }));

  const regionSelect = new StringSelectMenuBuilder()
    .setCustomId('timezone_region')
    .setPlaceholder('Select a Region')
    .addOptions(regionOptions);
  
  const customButton = new ButtonBuilder()
    .setCustomId('timezone_custom')
    .setLabel('Enter Custom Timezone')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('⌨️');

  const row1 = new ActionRowBuilder().addComponents(regionSelect);
  const row2 = new ActionRowBuilder().addComponents(customButton);

  await interaction.reply({
    embeds: [embed],
    components: [row1, row2],
    ephemeral: true
  });
}

// Region Selection Handler
export async function handleTimezoneRegionSelect(interaction) {
  const region = interaction.values[0];
  await showTimezonePage(interaction, region, 0);
}

// Pagination Handler
export async function handleTimezonePagination(interaction) {
  // customId format: timezone_page_REGION_PAGE
  const parts = interaction.customId.split('_');
  // parts[0] = timezone, parts[1] = page
  // The rest is the region name which might contain underscores
  const pageIndex = parseInt(parts.pop());
  const region = parts.slice(2).join('_').replace(/_/g, ' '); // Reconstruct region name
  
  await showTimezonePage(interaction, region, pageIndex);
}

// Show Timezone Page Logic
async function showTimezonePage(interaction, region, page) {
  const timezones = TIMEZONE_DATA[region];
  
  if (!timezones) {
    return interaction.update({ content: 'Region not found.', components: [] });
  }

  const totalPages = Math.ceil(timezones.length / ITEMS_PER_PAGE);
  const startIdx = page * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const currentItems = timezones.slice(startIdx, endIdx);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🌍 ${region} Timezones`)
    .setDescription(`Select your specific timezone.\nPage ${page + 1}/${totalPages}`)
    .setFooter({ text: 'Can\'t find yours? Use the "Enter Custom" button on the main menu.' });

  const timezoneSelect = new StringSelectMenuBuilder()
    .setCustomId('timezone_select')
    .setPlaceholder('Select your timezone')
    .addOptions(currentItems);

  const row1 = new ActionRowBuilder().addComponents(timezoneSelect);
  const row2 = new ActionRowBuilder();

  // Navigation Buttons
  if (page > 0) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`timezone_page_${region.replace(/ /g, '_')}_${page - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('◀️')
    );
  }

  if (page < totalPages - 1) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`timezone_page_${region.replace(/ /g, '_')}_${page + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('➡️')
    );
  }

  // Add Custom button here too for convenience
  row2.addComponents(
    new ButtonBuilder()
      .setCustomId('timezone_custom')
      .setLabel('Custom / Search')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('⌨️')
  );

  const components = [row1];
  if (row2.components.length > 0) {
    components.push(row2);
  }

  await interaction.update({
    embeds: [embed],
    components: components
  });
}

// Final Timezone Selection Handler
export async function handleTimezoneSelect(interaction) {
  const timezone = interaction.values[0];
  const userId = interaction.user.id;
  
  await saveTimezone(userId, timezone);
  
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

// Custom Timezone Handlers
export async function handleTimezoneCustomButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('timezone_modal')
    .setTitle('Custom Timezone');

  const input = new TextInputBuilder()
    .setCustomId('timezone_input')
    .setLabel('Enter IANA Timezone ID')
    .setPlaceholder('e.g., America/New_York, Europe/Paris')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const row = new ActionRowBuilder().addComponents(input);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

export async function handleTimezoneCustomModal(interaction) {
  const timezone = interaction.fields.getTextInputValue('timezone_input').trim();
  const userId = interaction.user.id;

  // Validate Timezone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }); // Throws if invalid
    
    await saveTimezone(userId, timezone);
    
    const currentTime = new Date().toLocaleString('en-US', { 
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'long'
    });

    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Timezone Set')
      .setDescription(`Your timezone has been set to **${timezone}**`)
      .addFields({
        name: '🕐 Current Time',
        value: currentTime
      });

    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });

  } catch (error) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Invalid Timezone')
      .setDescription(`\`${timezone}\` is not a valid IANA timezone identifier.\n\nExamples: \`America/New_York\`, \`Europe/London\`, \`Asia/Tokyo\`, \`UTC\`.`);

    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
}

// Helpers
async function saveTimezone(userId, timezone) {
  if (!state.userTimezones) {
    state.userTimezones = {};
  }
  state.userTimezones[userId] = timezone;
  await db.saveUserTimezone(userId, timezone);
  await saveStateToFile();
}

function getRegionEmoji(region) {
  const map = {
    'North America': '🌎',
    'Europe': '🌍',
    'Asia': '🌏',
    'Oceania': '🦘',
    'South America': '💃',
    'Africa': '🦁',
    'UTC': '🕒'
  };
  return map[region] || '🗺️';
}

// Existing Utility Exports
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
