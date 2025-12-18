import { 
  birthdayCommand, 
  handleBirthdayCommand, 
  handleBirthdayMonthSelect,
  handleBirthdayDaySelect,
  handleBirthdayNameSelect,
  handleBirthdayPrefSelect,
  handleBirthdayDeleteSelect,
  scheduleBirthdayChecks
} from './birthday.js';

import { 
  reminderCommand, 
  handleReminderCommand,
  handleReminderActionSelect,
  handleReminderTypeSelect,
  handleReminderModal,
  handleReminderLocationSelect,
  handleReminderDeleteSelect,
  initializeReminders
} from './reminder.js';

import {
  quoteCommand,
  handleQuoteCommand,
  handleQuoteActionSelect,
  handleQuoteCategorySelect,
  handleQuoteTimeSelect,
  handleQuoteLocationSelect,
  handleQuoteChannelSelect,
  handleQuoteRemoveSelect,
  initializeDailyQuotes
} from './quote.js';

import {
  rouletteCommand,
  handleRouletteCommand,
  handleRouletteActionSelect,
  handleRouletteRaritySelect,
  checkRoulette
} from './fun.js';

import {
  anniversaryCommand,
  handleAnniversaryCommand,
  digestCommand,
  handleDigestCommand,
  starterCommand,
  handleStarterCommand,
  complimentCommand,
  handleComplimentCommand
} from './fun.js';

import {
  gameCommand,
  handleGameCommand,
  handleGameSelect,
  handleTDSChoice,
  handleTDSAgain,
  handleAkinatorAnswer,
  handleAkinatorResult,
  handleAkinatorAgain,
  handleAkinatorModeSelect,
  handleNHIENext,
  handleWYRNext
} from './game.js';

import {
  timezoneCommand,
  handleTimezoneCommand,
  handleTimezoneSelect,
  handleTimezoneNextPage,
  handleTimezonePrevPage,
  handleTimezoneCustomButton,
  handleTimezoneCustomModal
} from './timezone.js';

import {
  summaryCommand,
  handleSummaryCommand
} from './summary.js';

import {
  realiveCommand,
  handleRealiveCommand,
  startRealiveLoop
} from './realive.js';

export function initializeScheduledTasks(client) {
  scheduleBirthdayChecks(client);
  initializeReminders(client);
  initializeDailyQuotes(client);
  startRealiveLoop(client);
}

export async function handleCommandInteraction(interaction) {
  const commandHandlers = {
    birthday: handleBirthdayCommand,
    reminder: handleReminderCommand,
    quote: handleQuoteCommand,
    roulette: handleRouletteCommand,
    anniversary: handleAnniversaryCommand,
    digest: handleDigestCommand,
    starter: handleStarterCommand,
    compliment: handleComplimentCommand,
    game: handleGameCommand,
    timezone: handleTimezoneCommand,
    summary: handleSummaryCommand,
    realive: handleRealiveCommand
  };

  const handler = commandHandlers[interaction.commandName];
  if (handler) {
    await handler(interaction);
  }
}

export async function handleSelectMenuInteraction(interaction) {
  const handlers = {
    'birthday_month': handleBirthdayMonthSelect,
    'birthday_day_': handleBirthdayDaySelect,
    'birthday_name_': handleBirthdayNameSelect,
    'birthday_pref_': handleBirthdayPrefSelect,
    'birthday_delete_select': handleBirthdayDeleteSelect,
    'reminder_action': handleReminderActionSelect,
    'reminder_type': handleReminderTypeSelect,
    'reminder_location_': handleReminderLocationSelect,
    'reminder_delete_select': handleReminderDeleteSelect,
    'quote_action': handleQuoteActionSelect,
    'quote_category': handleQuoteCategorySelect,
    'quote_time_': handleQuoteTimeSelect,
    'quote_location_': handleQuoteLocationSelect,
    'quote_channel_': handleQuoteChannelSelect,
    'quote_remove_select': handleQuoteRemoveSelect,
    'roulette_action': handleRouletteActionSelect,
    'roulette_rarity': handleRouletteRaritySelect,
    'game_select': handleGameSelect,
    'tds_choice': handleTDSChoice,
    'akinator_mode': handleAkinatorModeSelect,
    'timezone_region': handleTimezoneSelect,
    'timezone_select': handleTimezoneSelect
  };

  for (const [key, handler] of Object.entries(handlers)) {
    if (interaction.customId.startsWith(key)) {
      await handler(interaction);
      return;
    }
  }
}

export async function handleModalSubmission(interaction) {
  if (interaction.customId.startsWith('reminder_modal_')) {
    await handleReminderModal(interaction);
  } else if (interaction.customId === 'timezone_modal') {
    await handleTimezoneCustomModal(interaction);
  }
}

export async function handleButtonInteraction(interaction) {
  const handlers = {
    'akinator_yes_': handleAkinatorAnswer,
    'akinator_no_': handleAkinatorAnswer,
    'akinator_dk_': handleAkinatorAnswer,
    'akinator_prob_': handleAkinatorAnswer,
    'akinator_pn_': handleAkinatorAnswer,
    'akinator_correct_': handleAkinatorResult,
    'akinator_wrong_': handleAkinatorResult,
    'akinator_again': handleAkinatorAgain,
    'tds_again': handleTDSAgain,
    'nhie_next': handleNHIENext,
    'wyr_next': handleWYRNext,
    'timezone_next_page': handleTimezoneNextPage,
    'timezone_prev_page': handleTimezonePrevPage,
    'timezone_custom': handleTimezoneCustomButton,
    'reminder_action_delete': showReminderDeleteFromButton
  };

  for (const [key, handler] of Object.entries(handlers)) {
    if (interaction.customId.startsWith(key)) {
      await handler(interaction);
      return;
    }
  }
}

async function showReminderDeleteFromButton(interaction) {
  const userId = interaction.user.id;
  const { state } = await import('../botManager.js');
  const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = await import('discord.js');
  
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
      activeReminders.slice(0, 25).map((reminder, index) => {
        const formatReminderTime = (type, time) => {
          if (type === 'once') return new Date(time.timestamp).toLocaleString();
          if (type === 'daily') return `Every day at ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
          if (type === 'weekly') {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            return `Every ${days[time.day]} at ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
          }
          if (type === 'monthly') return `${time.day}th of every month at ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
        };
        
        return {
          label: `${index + 1}. ${reminder.message.slice(0, 50)}`,
          description: formatReminderTime(reminder.type, reminder.time).slice(0, 100),
          value: reminder.id
        };
      })
    );

  const row = new ActionRowBuilder().addComponents(deleteSelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export function processMessageRoulette(message) {
  checkRoulette(message);
}

export {
  birthdayCommand,
  reminderCommand,
  quoteCommand,
  rouletteCommand,
  anniversaryCommand,
  digestCommand,
  starterCommand,
  complimentCommand,
  gameCommand,
  timezoneCommand,
  summaryCommand,
  realiveCommand
};
