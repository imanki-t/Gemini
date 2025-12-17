import { EmbedBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } from 'discord.js';
import { state, saveStateToFile, genAI } from '../botManager.js';
import * as db from '../database.js';

const REMINDER_MODEL = 'gemini-2.5-flash-lite';
const FALLBACK_MODEL = 'gemini-2.5-flash';
const MAX_REMINDERS_PER_USER = 10;

export const reminderCommand = {
  name: 'reminder',
  description: 'Set reminders for yourself (max 10 reminders)'
};

export async function handleReminderCommand(interaction) {
  const userId = interaction.user.id;
  
  // Check current reminder count
  const currentReminders = state.reminders?.[userId] || [];
  const activeReminders = currentReminders.filter(r => r.active);
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⏰ Reminder Setup')
    .setDescription(`Choose an action:\n\n**Active Reminders:** ${activeReminders.length}/${MAX_REMINDERS_PER_USER}`);

  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId('reminder_action')
    .setPlaceholder('Select an action')
    .addOptions(
      { label: 'Add Reminder', value: 'add', description: 'Create a new reminder', emoji: '➕' },
      { label: 'View Reminders', value: 'view', description: 'See all your reminders', emoji: '📋' },
      { label: 'Delete Reminder', value: 'delete', description: 'Remove a reminder', emoji: '🗑️' }
    );

  const row = new ActionRowBuilder().addComponents(actionSelect);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}

export async function handleReminderActionSelect(interaction) {
  const action = interaction.values[0];
  
  if (action === 'add') {
    await showReminderTypeSelect(interaction);
  } else if (action === 'view') {
    await viewReminders(interaction);
  } else if (action === 'delete') {
    await showDeleteReminderMenu(interaction);
  }
}

async function showReminderTypeSelect(interaction) {
  const userId = interaction.user.id;
  const currentReminders = state.reminders?.[userId] || [];
  const activeReminders = currentReminders.filter(r => r.active);
  
  if (activeReminders.length >= MAX_REMINDERS_PER_USER) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Reminder Limit Reached')
      .setDescription(`You have reached the maximum limit of ${MAX_REMINDERS_PER_USER} reminders.\n\nPlease delete some old reminders before creating new ones.`);
    
    const deleteButton = new ButtonBuilder()
      .setCustomId('reminder_action_delete')
      .setLabel('Delete Reminders')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️');
    
    const row = new ActionRowBuilder().addComponents(deleteButton);
    
    return interaction.update({
      embeds: [embed],
      components: [row]
    });
  }
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⏰ Reminder Setup')
    .setDescription('Choose how often you want to be reminded:');

  const typeSelect = new StringSelectMenuBuilder()
    .setCustomId('reminder_type')
    .setPlaceholder('Select reminder frequency')
    .addOptions(
      { label: 'Once (specific time)', value: 'once', description: 'One-time reminder', emoji: '⏱️' },
      { label: 'Daily', value: 'daily', description: 'Repeats every day', emoji: '📅' },
      { label: 'Weekly', value: 'weekly', description: 'Repeats every week', emoji: '📆' },
      { label: 'Monthly', value: 'monthly', description: 'Repeats every month', emoji: '🗓️' }
    );

  const row = new ActionRowBuilder().addComponents(typeSelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleReminderTypeSelect(interaction) {
  const type = interaction.values[0];
  
  const modal = new ModalBuilder()
    .setCustomId(`reminder_modal_${type}`)
    .setTitle(`Set ${type.charAt(0).toUpperCase() + type.slice(1)} Reminder`);

  const messageInput = new TextInputBuilder()
    .setCustomId('reminder_message')
    .setLabel('What should I remind you about?')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('e.g., Take medication, Study for exam, Water plants')
    .setRequired(true)
    .setMaxLength(500);

  let timeInput;
  if (type === 'once') {
    timeInput = new TextInputBuilder()
      .setCustomId('reminder_time')
      .setLabel('When? (format: YYYY-MM-DD HH:MM)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., 2024-12-25 14:30')
      .setRequired(true);
  } else if (type === 'daily') {
    timeInput = new TextInputBuilder()
      .setCustomId('reminder_time')
      .setLabel('What time each day? (24h format: HH:MM)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., 09:00, 14:30, 20:00')
      .setRequired(true);
  } else if (type === 'weekly') {
    timeInput = new TextInputBuilder()
      .setCustomId('reminder_time')
      .setLabel('Day and time? (format: Monday 09:00)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., Monday 09:00, Friday 17:00')
      .setRequired(true);
  } else if (type === 'monthly') {
    timeInput = new TextInputBuilder()
      .setCustomId('reminder_time')
      .setLabel('Day and time? (format: 15 09:00)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., 1 09:00, 15 14:00 (day of month)')
      .setRequired(true);
  }

  modal.addComponents(
    new ActionRowBuilder().addComponents(messageInput),
    new ActionRowBuilder().addComponents(timeInput)
  );

  await interaction.showModal(modal);
}

export async function handleReminderModal(interaction) {
  const [_, __, type] = interaction.customId.split('_');
  const message = interaction.fields.getTextInputValue('reminder_message');
  const timeStr = interaction.fields.getTextInputValue('reminder_time');
  
  const userId = interaction.user.id;
  const guildId = interaction.guild?.id;
  
  // Show location preference selector
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⏰ Reminder Location')
    .setDescription(`**Reminder:** ${message}\n**Type:** ${type}\n**Time:** ${timeStr}\n\nWhere should I send this reminder?`);

  const locationSelect = new StringSelectMenuBuilder()
    .setCustomId(`reminder_location_${type}_${Buffer.from(message).toString('base64').slice(0, 20)}_${Buffer.from(timeStr).toString('base64').slice(0, 20)}`)
    .setPlaceholder('Choose notification location');
  
  if (guildId) {
    locationSelect.addOptions(
      { label: 'DM Only', value: 'dm', description: 'Receive in direct messages', emoji: '📬' },
      { label: 'Server Only', value: 'server', description: 'Get notified in this server', emoji: '💬' },
      { label: 'Both', value: 'both', description: 'DM + Server notification', emoji: '📢' }
    );
  } else {
    locationSelect.addOptions(
      { label: 'DM', value: 'dm', description: 'Receive in direct messages', emoji: '📬' }
    );
  }

  const row = new ActionRowBuilder().addComponents(locationSelect);

  // Store temporarily
  if (!interaction.client.tempReminderData) {
    interaction.client.tempReminderData = new Map();
  }
  
  const tempKey = `${userId}_${Date.now()}`;
  interaction.client.tempReminderData.set(tempKey, {
    type,
    message,
    timeStr,
    guildId
  });

  await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral
  });
  
  // Clean up temp data after 5 minutes
  setTimeout(() => {
    interaction.client.tempReminderData.delete(tempKey);
  }, 5 * 60 * 1000);
}

export async function handleReminderLocationSelect(interaction) {
  const location = interaction.values[0];
  const userId = interaction.user.id;
  
  // Get temp data
  const tempData = Array.from(interaction.client.tempReminderData?.entries() || [])
    .find(([key]) => key.startsWith(userId))?.[1];
  
  if (!tempData) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Expired')
      .setDescription('This reminder setup expired. Please start again with `/reminder`');
    
    return interaction.update({
      embeds: [embed],
      components: []
    });
  }
  
  const { type, message, timeStr, guildId } = tempData;
  
  try {
    const parsedTime = parseReminderTime(type, timeStr);
    
    if (!state.reminders) {
      state.reminders = {};
    }
    
    if (!state.reminders[userId]) {
      state.reminders[userId] = [];
    }
    
    // Double-check limit before adding
    const activeReminders = state.reminders[userId].filter(r => r.active);
    if (activeReminders.length >= MAX_REMINDERS_PER_USER) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Reminder Limit Reached')
        .setDescription(`You have reached the maximum limit of ${MAX_REMINDERS_PER_USER} reminders.\n\nPlease delete some old reminders before creating new ones.`);
      
      return interaction.update({
        embeds: [embed],
        components: []
      });
    }
    
    const reminder = {
      id: `${userId}_${Date.now()}`,
      type,
      message,
      time: parsedTime,
      location,
      guildId: location !== 'dm' ? guildId : null,
      active: true,
      createdAt: Date.now()
    };
    
    state.reminders[userId].push(reminder);
    await db.saveReminder(userId, reminder);
    await saveStateToFile();
    
    scheduleReminder(interaction.client, reminder);
    
    const locationText = {
      dm: 'DMs',
      server: 'this server',
      both: 'DMs and this server'
    }[location];
    
    const timeDisplay = formatReminderTime(type, parsedTime);
    const activeCount = state.reminders[userId].filter(r => r.active).length;
    
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Reminder Set!')
      .setDescription(`**Message:** ${message}\n**Type:** ${type}\n**Next trigger:** ${timeDisplay}\n**Location:** ${locationText}`)
      .setFooter({ text: `Active reminders: ${activeCount}/${MAX_REMINDERS_PER_USER}` });

    await interaction.update({
      embeds: [embed],
      components: []
    });
    
  } catch (error) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Invalid Time Format')
      .setDescription(`Could not parse the time: "${timeStr}"\n\n${error.message}\n\nPlease try again with the correct format.`);

    await interaction.update({
      embeds: [embed],
      components: []
    });
  }
}

async function viewReminders(interaction) {
  const userId = interaction.user.id;
  const reminders = state.reminders?.[userId] || [];
  const activeReminders = reminders.filter(r => r.active);
  
  if (activeReminders.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('📋 No Active Reminders')
      .setDescription('You don\'t have any active reminders.\n\nUse `/reminder` to create one!');
    
    return interaction.update({
      embeds: [embed],
      components: []
    });
  }
  
  const reminderList = activeReminders
    .map((reminder, index) => {
      const timeDisplay = formatReminderTime(reminder.type, reminder.time);
      return `**${index + 1}.** ${reminder.message}\n⏰ ${timeDisplay}\n📍 ${reminder.location === 'dm' ? 'DMs' : reminder.location === 'both' ? 'DMs & Server' : 'Server'}`;
    })
    .join('\n\n');
  
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Your Active Reminders')
    .setDescription(reminderList)
    .setFooter({ text: `${activeReminders.length}/${MAX_REMINDERS_PER_USER} reminders active` });

  await interaction.update({
    embeds: [embed],
    components: []
  });
}

async function showDeleteReminderMenu(interaction) {
  const userId = interaction.user.id;
  const reminders = state.reminders?.[userId] || [];
  const activeReminders = reminders.filter(r => r.active);
  
  if (activeReminders.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ No Reminders')
      .setDescription('You don\'t have any active reminders to delete.');
    
    return interaction.update({
      embeds: [embed],
      components: []
    });
  }
  
  const embed = new EmbedBuilder()
    .setColor(0xFF6B6B)
    .setTitle('🗑️ Delete Reminder')
    .setDescription('Select a reminder to delete:');

  const deleteSelect = new StringSelectMenuBuilder()
    .setCustomId('reminder_delete_select')
    .setPlaceholder('Choose reminder to delete')
    .addOptions(
      activeReminders.slice(0, 25).map((reminder, index) => ({
        label: `${index + 1}. ${reminder.message.slice(0, 50)}`,
        description: formatReminderTime(reminder.type, reminder.time).slice(0, 100),
        value: reminder.id
      }))
    );

  const row = new ActionRowBuilder().addComponents(deleteSelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleReminderDeleteSelect(interaction) {
  const reminderId = interaction.values[0];
  const userId = interaction.user.id;
  
  if (!state.reminders?.[userId]) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Error')
      .setDescription('Could not find your reminders.');
    
    return interaction.update({
      embeds: [embed],
      components: []
    });
  }
  
  const reminderIndex = state.reminders[userId].findIndex(r => r.id === reminderId);
  
  if (reminderIndex === -1) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Reminder Not Found')
      .setDescription('Could not find that reminder.');
    
    return interaction.update({
      embeds: [embed],
      components: []
    });
  }
  
  const reminder = state.reminders[userId][reminderIndex];
  state.reminders[userId].splice(reminderIndex, 1);
  
  // Clear interval if it exists
  if (interaction.client.reminderIntervals?.has(reminderId)) {
    clearInterval(interaction.client.reminderIntervals.get(reminderId));
    interaction.client.reminderIntervals.delete(reminderId);
  }
  
  await db.updateReminder(reminderId, { active: false });
  await saveStateToFile();
  
  const activeCount = state.reminders[userId].filter(r => r.active).length;
  
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Reminder Deleted')
    .setDescription(`Deleted: **${reminder.message}**`)
    .setFooter({ text: `Active reminders: ${activeCount}/${MAX_REMINDERS_PER_USER}` });

  await interaction.update({
    embeds: [embed],
    components: []
  });
}

function parseReminderTime(type, timeStr) {
  if (type === 'once') {
    // Format: YYYY-MM-DD HH:MM
    const match = timeStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (!match) throw new Error('Format should be: YYYY-MM-DD HH:MM (e.g., 2024-12-25 14:30)');
    
    const [, year, month, day, hour, minute] = match;
    const date = new Date(year, month - 1, day, hour, minute);
    
    if (date < new Date()) {
      throw new Error('Time must be in the future!');
    }
    
    return { timestamp: date.getTime() };
    
  } else if (type === 'daily') {
    // Format: HH:MM
    const match = timeStr.match(/(\d{2}):(\d{2})/);
    if (!match) throw new Error('Format should be: HH:MM (e.g., 09:00, 14:30)');
    
    const [, hour, minute] = match;
    return { hour: parseInt(hour), minute: parseInt(minute) };
    
  } else if (type === 'weekly') {
    // Format: Monday 09:00
    const match = timeStr.match(/(\w+)\s+(\d{2}):(\d{2})/);
    if (!match) throw new Error('Format should be: DayName HH:MM (e.g., Monday 09:00)');
    
    const [, dayName, hour, minute] = match;
    const dayMap = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
    const day = dayMap[dayName.toLowerCase()];
    
    if (day === undefined) throw new Error('Invalid day name. Use: Monday, Tuesday, etc.');
    
    return { day, hour: parseInt(hour), minute: parseInt(minute) };
    
  } else if (type === 'monthly') {
    // Format: 15 09:00
    const match = timeStr.match(/(\d{1,2})\s+(\d{2}):(\d{2})/);
    if (!match) throw new Error('Format should be: DD HH:MM (e.g., 15 09:00)');
    
    const [, day, hour, minute] = match;
    if (parseInt(day) < 1 || parseInt(day) > 31) {
      throw new Error('Day must be between 1 and 31');
    }
    
    return { day: parseInt(day), hour: parseInt(hour), minute: parseInt(minute) };
  }
}

function formatReminderTime(type, parsedTime) {
  if (type === 'once') {
    return new Date(parsedTime.timestamp).toLocaleString();
  } else if (type === 'daily') {
    return `Every day at ${String(parsedTime.hour).padStart(2, '0')}:${String(parsedTime.minute).padStart(2, '0')}`;
  } else if (type === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `Every ${days[parsedTime.day]} at ${String(parsedTime.hour).padStart(2, '0')}:${String(parsedTime.minute).padStart(2, '0')}`;
  } else if (type === 'monthly') {
    return `${parsedTime.day}th of every month at ${String(parsedTime.hour).padStart(2, '0')}:${String(parsedTime.minute).padStart(2, '0')}`;
  }
}

function scheduleReminder(client, reminder) {
  const checkAndTrigger = async () => {
    if (!reminder.active) return;
    
    const now = new Date();
    let shouldTrigger = false;
    
    if (reminder.type === 'once') {
      if (now.getTime() >= reminder.time.timestamp) {
        shouldTrigger = true;
        reminder.active = false; // Disable after triggering once
      }
    } else if (reminder.type === 'daily') {
      if (now.getHours() === reminder.time.hour && now.getMinutes() === reminder.time.minute) {
        shouldTrigger = true;
      }
    } else if (reminder.type === 'weekly') {
      if (now.getDay() === reminder.time.day && 
          now.getHours() === reminder.time.hour && 
          now.getMinutes() === reminder.time.minute) {
        shouldTrigger = true;
      }
    } else if (reminder.type === 'monthly') {
      if (now.getDate() === reminder.time.day && 
          now.getHours() === reminder.time.hour && 
          now.getMinutes() === reminder.time.minute) {
        shouldTrigger = true;
      }
    }
    
    if (shouldTrigger) {
      await sendReminder(client, reminder);
      if (!reminder.active) {
        await db.updateReminder(reminder.id, { active: false });
      }
    }
  };
  
  // Check every minute
  const intervalId = setInterval(checkAndTrigger, 60 * 1000);
  
  // Store interval ID for cleanup
  if (!client.reminderIntervals) {
    client.reminderIntervals = new Map();
  }
  client.reminderIntervals.set(reminder.id, intervalId);
}

async function sendReminder(client, reminder) {
  const userId = reminder.id.split('_')[0];
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;
  
  const embed = new EmbedBuilder()
    .setColor(0xFF8C00)
    .setTitle('⏰ Reminder!')
    .setDescription(reminder.message)
    .setFooter({ text: `Type: ${reminder.type}` })
    .setTimestamp();
  
  // Send to DM
  if (reminder.location === 'dm' || reminder.location === 'both') {
    try {
      await user.send({ embeds: [embed] });
    } catch (error) {
      console.error(`Could not send reminder DM to ${userId}:`, error);
    }
  }
  
  // Send to server
  if ((reminder.location === 'server' || reminder.location === 'both') && reminder.guildId) {
    try {
      const guild = client.guilds.cache.get(reminder.guildId);
      if (guild) {
        const channel = guild.channels.cache.find(ch => 
          ch.isTextBased() && 
          ch.permissionsFor(guild.members.me).has('SendMessages')
        );
        
        if (channel) {
          await channel.send({
            content: `<@${userId}>`,
            embeds: [embed]
          });
        }
      }
    } catch (error) {
      console.error(`Could not send reminder in server ${reminder.guildId}:`, error);
    }
  }
}

export function initializeReminders(clien
