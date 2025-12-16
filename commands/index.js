// commands/index.js
// Central handler for all new commands

import { 
  birthdayCommand, 
  handleBirthdayCommand, 
  handleBirthdayMonthSelect,
  handleBirthdayDaySelect,
  handleBirthdayPrefSelect,
  scheduleBirthdayChecks
} from './birthday.js';

import { 
  reminderCommand, 
  handleReminderCommand,
  handleReminderTypeSelect,
  handleReminderModal,
  handleReminderLocationSelect,
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
  handleTODChoice,
  handleTODAgain,
  handleAkinatorAnswer,
  handleAkinatorResult,
  handleAkinatorAgain,
  handleTDSChoice,
  handleTDSAgain,
  handleNHIENext,
  handleWYR,
  handleWYRVote,
  handleWYRNext
} from './game.js';

// Initialize all scheduled tasks
export function initializeScheduledTasks(client) {
  scheduleBirthdayChecks(client);
  initializeReminders(client);
  initializeDailyQuotes(client);
}

// Handle command interactions
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
    game: handleGameCommand
  };

  const handler = commandHandlers[interaction.commandName];
  if (handler) {
    await handler(interaction);
  }
}

// Handle select menu interactions
export async function handleSelectMenuInteraction(interaction) {
  const handlers = {
    'birthday_month': handleBirthdayMonthSelect,
    'birthday_day_': handleBirthdayDaySelect,
    'birthday_pref_': handleBirthdayPrefSelect,
    'reminder_type': handleReminderTypeSelect,
    'reminder_location_': handleReminderLocationSelect,
    'quote_action': handleQuoteActionSelect,
    'quote_category': handleQuoteCategorySelect,
    'quote_time_': handleQuoteTimeSelect,
    'quote_location_': handleQuoteLocationSelect,
    'quote_channel_': handleQuoteChannelSelect,
    'roulette_action': handleRouletteActionSelect,
    'roulette_rarity': handleRouletteRaritySelect,
    'game_select': handleGameSelect,
    'tod_choice': handleTODChoice,
    'tds_choice': handleTDSChoice
  };

  for (const [key, handler] of Object.entries(handlers)) {
    if (interaction.customId.startsWith(key)) {
      await handler(interaction);
      return;
    }
  }
}

// Handle modal submissions
export async function handleModalSubmission(interaction) {
  if (interaction.customId.startsWith('reminder_modal_')) {
    await handleReminderModal(interaction);
  }
}

// Handle button interactions
export async function handleButtonInteraction(interaction) {
  const handlers = {
    'tod_again': handleTODAgain,
    'akinator_yes_': handleAkinatorAnswer,
    'akinator_no_': handleAkinatorAnswer,
    'akinator_maybe_': handleAkinatorAnswer,
    'akinator_correct_': handleAkinatorResult,
    'akinator_wrong_': handleAkinatorResult,
    'akinator_again': handleAkinatorAgain,
    'tds_again': handleTDSAgain,
    'nhie_next': handleNHIENext,
    'wyr_option1': handleWYRVote,
    'wyr_option2': handleWYRVote,
    'wyr_next': handleWYRNext
  };

  for (const [key, handler] of Object.entries(handlers)) {
    if (interaction.customId.startsWith(key)) {
      await handler(interaction);
      return;
    }
  }
}

// Check roulette for each message
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
  gameCommand
};
