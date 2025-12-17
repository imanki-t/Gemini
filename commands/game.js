import { EmbedBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { genAI } from '../botManager.js';

const GAME_MODEL = 'gemini-2.5-flash';
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Game State Storage
// Key: State Key (usually based on User ID or Channel ID depending on game mode)
// Value: { type, lastMessageId, timeout, ...gameSpecificData }
const gameStates = new Map();

export const gameCommand = {
  name: 'game',
  description: 'Play interactive games with AI'
};

/**
 * Utility to clean up components (buttons/select menus) from a specific message.
 * Used when moving to the next turn or when the game expires.
 */
async function removeComponentsFromMessage(channel, messageId) {
  if (!channel || !messageId) return;
  try {
    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (msg && msg.components.length > 0) {
      await msg.edit({ components: [] });
    }
  } catch (e) {
    // Message might be deleted or inaccessible, ignore
  }
}

/**
 * Sets a timeout to clean up the current game state after inactivity.
 * It removes buttons from the last message to indicate the game has closed.
 */
function setExpiryTimeout(stateKey, channel, messageId) {
  const state = gameStates.get(stateKey);
  if (state?.timeout) clearTimeout(state.timeout);
  
  const timeout = setTimeout(async () => {
    const currentState = gameStates.get(stateKey);
    // Only clean up if this specific game instance is still active
    if (currentState) {
      await removeComponentsFromMessage(channel, messageId);
      gameStates.delete(stateKey);
    }
  }, INACTIVITY_TIMEOUT);

  if (state) state.timeout = timeout;
}

export async function handleGameCommand(interaction) {
  try {
    const embed = new EmbedBuilder()
      .setColor(0xE91E63)
      .setTitle('🎮 Interactive Games')
      .setDescription('Select a game to start playing!\n\n**Note:** New turns will appear as new messages.');

    const gameSelect = new StringSelectMenuBuilder()
      .setCustomId('game_select')
      .setPlaceholder('Select a game')
      .addOptions(
        { label: 'Truth, Dare or Situation', value: 'tds', description: 'Classic party game with scenarios', emoji: '🎭' },
        { label: 'Akinator', value: 'akinator', description: 'I\'ll guess who you\'re thinking of!', emoji: '🔮' },
        { label: 'Never Have I Ever', value: 'nhie', description: 'Share experiences with others', emoji: '🙈' },
        { label: 'Would You Rather', value: 'wyr', description: 'Pick between two dilemmas', emoji: '🤔' }
      );

    const row = new ActionRowBuilder().addComponents(gameSelect);

    await interaction.reply({
      embeds: [embed],
      components: [row]
    });
  } catch (error) {
    console.error('Error in handleGameCommand:', error);
    await handleGameError(interaction, 'Failed to load game menu.');
  }
}

export async function handleGameSelect(interaction) {
  try {
    const game = interaction.values[0];
    
    // We don't strictly clear previous game states here because multiple games can run in a channel 
    // if they are user-specific. The games themselves handle their own initialization cleanup.

    const handlers = {
      'tds': handleTDSInit,
      'akinator': handleAkinatorInit,
      'nhie': handleNHIE,
      'wyr': handleWYR
    };

    const handler = handlers[game];
    if (handler) await handler(interaction);
  } catch (error) {
    console.error('Error in handleGameSelect:', error);
    await handleGameError(interaction, 'Failed to start selected game.');
  }
}

// --- TRUTH, DARE, OR SITUATION ---

async function handleTDSInit(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xFF6B6B)
    .setTitle('🎭 Truth, Dare, or Situation')
    .setDescription('Choose your path...');

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('tds_choice')
      .setPlaceholder('Pick one')
      .addOptions(
        { label: 'Truth', value: 'truth', emoji: '💭' },
        { label: 'Dare', value: 'dare', emoji: '⚡' },
        { label: 'Situation', value: 'situation', emoji: '🎭' }
      )
  );

  // If this was triggered from the main menu, update the menu.
  if (interaction.isStringSelectMenu()) {
    await interaction.update({ embeds: [embed], components: [row] });
  } else {
    // Fallback if called differently
    await interaction.reply({ embeds: [embed], components: [row] });
  }
}

export async function handleTDSChoice(interaction) {
  const choice = interaction.values[0];
  const stateKey = `tds_${interaction.user.id}_${interaction.channelId}`;
  
  // 1. Remove components from the interaction message immediately (User selection accepted)
  await interaction.update({ components: [] });

  try {
    const prompt = `Generate one short, engaging ${choice} for a Discord game. 
    ${choice === 'truth' ? 'Ask a deep or funny question.' : choice === 'dare' ? 'Create a safe, doable challenge.' : 'Describe a hypothetical "What would you do?" scenario.'}
    Appropriate for teens. One sentence only.`;

    const chat = genAI.chats.create({ model: GAME_MODEL, config: { temperature: 0.9 } });
    const result = await chat.sendMessage({ message: prompt });
    const challenge = result.text || `Generated a ${choice}!`;

    const embed = new EmbedBuilder()
      .setColor(0xFF6B6B)
      .setTitle(`${choice.toUpperCase()}`)
      .setDescription(challenge)
      .setFooter({ text: 'Click below for another one!' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tds_again').setLabel('Play Again').setStyle(ButtonStyle.Primary).setEmoji('🔄')
    );
    
    // 2. Send result as a NEW message
    const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
    
    // 3. Update state to track this new message for inactivity cleanup
    gameStates.set(stateKey, { lastMessageId: msg.id });
    setExpiryTimeout(stateKey, interaction.channel, msg.id);

  } catch (error) {
    handleGameError(interaction, 'Failed to generate challenge.', true);
  }
}

export async function handleTDSAgain(interaction) {
  // 1. Remove "Play Again" button from the OLD message
  await interaction.update({ components: [] });

  // 2. Trigger the init flow again (sends the selection menu as a new message? 
  // actually handleTDSInit usually updates. We should modify handleTDSInit to support sending new if called from button)
  
  // Custom Init for "Play Again" flow to ensure new message
  const embed = new EmbedBuilder()
    .setColor(0xFF6B6B)
    .setTitle('🎭 Truth, Dare, or Situation')
    .setDescription('Choose your path...');

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('tds_choice')
      .setPlaceholder('Pick one')
      .addOptions(
        { label: 'Truth', value: 'truth', emoji: '💭' },
        { label: 'Dare', value: 'dare', emoji: '⚡' },
        { label: 'Situation', value: 'situation', emoji: '🎭' }
      )
  );

  const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
  
  // Update state so we clean up this menu if they abandon it
  const stateKey = `tds_${interaction.user.id}_${interaction.channelId}`;
  gameStates.set(stateKey, { lastMessageId: msg.id });
  setExpiryTimeout(stateKey, interaction.channel, msg.id);
}

// --- AKINATOR ---

async function handleAkinatorInit(interaction) {
  // If in DMs, skip mode selection and start directly in individual mode
  if (!interaction.guild) {
    return startAkinator(interaction, 'individual');
  }

  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('🔮 Akinator - Choose Mode')
    .setDescription('Would you like to play alone or with the server?');

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('akinator_mode')
      .setPlaceholder('Select mode')
      .addOptions(
        { label: 'Individual', value: 'individual', description: 'Only you can answer', emoji: '👤' },
        { label: 'Group', value: 'group', description: 'Anyone can answer', emoji: '👥' }
      )
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

export async function handleAkinatorModeSelect(interaction) {
  // Remove the menu from the previous message
  await interaction.update({ components: [] });
  await startAkinator(interaction, interaction.values[0]);
}

async function startAkinator(interaction, mode) {
  // Create a unique game ID. 
  // For Individual: bind to user. For Group: bind to channel.
  // We include timestamp to ensure uniqueness across sessions.
  const gameId = `aki_${interaction.channelId}_${Date.now()}`;
  
  const systemPrompt = `You are Akinator. Guess the character the user is thinking of.
  1. Ask one strategic Yes/No question at a time.
  2. If you are 90% sure, make a guess using EXACTLY this format: "I think you're thinking of: [NAME]".
  3. Keep questions very brief.`;

  const chat = genAI.chats.create({ 
    model: GAME_MODEL, 
    config: { systemInstruction: { parts: [{ text: systemPrompt }] }, temperature: 0.7 } 
  });

  const loadingEmbed = new EmbedBuilder().setColor(0x9B59B6).setDescription('🔮 Awakening the genie...');
  
  // Send loading as a NEW message (since we cleared the old one)
  const loadingMsg = await interaction.channel.send({ embeds: [loadingEmbed] });

  try {
    const result = await chat.sendMessage({ message: "Start the game with your first question." });
    const question = result.text || "Is your character real?";

    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('🔮 Akinator - Question 1')
      .setDescription(question)
      .setFooter({ text: mode === 'individual' ? `Individual Mode: Only ${interaction.user.username} can answer` : 'Group Mode: Anyone can answer!' });

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`akinator_yes_${gameId}`).setLabel('Yes').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`akinator_no_${gameId}`).setLabel('No').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`akinator_maybe_${gameId}`).setLabel('Maybe').setStyle(ButtonStyle.Secondary)
    );

    // Delete loading msg or edit it? User asked for "send new ones".
    // But loading msg was just a placeholder. Let's delete it and send the real one to be clean, 
    // OR just edit the loading message to become the first question (acceptable exception), 
    // THEN future questions are new messages. 
    // Let's stick to the prompt: "instead of editing messages it'd send new ones".
    // So we delete loading and send new.
    await loadingMsg.delete().catch(() => {});
    const msg = await interaction.channel.send({ embeds: [embed], components: [buttons] });
    
    gameStates.set(gameId, {
      chat,
      count: 1,
      mode,
      starterId: interaction.user.id,
      lastMessageId: msg.id
    });
    
    setExpiryTimeout(gameId, interaction.channel, msg.id);
  } catch (err) {
    console.error(err);
    await loadingMsg.delete().catch(() => {});
    await interaction.channel.send("❌ Failed to start Akinator.");
  }
}

export async function handleAkinatorAnswer(interaction) {
  const [_, answer, gameId] = interaction.customId.split('_');
  const game = gameStates.get(gameId);

  if (!game) {
    return interaction.reply({ content: '🔮 This session has expired. Start a new one!', flags: MessageFlags.Ephemeral });
  }

  if (game.mode === 'individual' && interaction.user.id !== game.starterId) {
    return interaction.reply({ content: '❌ Only the game starter can answer in Individual mode.', flags: MessageFlags.Ephemeral });
  }

  // 1. Remove buttons from the PREVIOUS question
  await interaction.update({ components: [] });

  try {
    const response = await game.chat.sendMessage({ message: `The answer is ${answer}.` });
    const text = response.text || "I'm not sure... is your character fictional?";
    
    if (text.toLowerCase().includes("i think you're thinking of")) {
      const guessEmbed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🔮 I have a guess!')
        .setDescription(text);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`akinator_correct_${gameId}`).setLabel('Correct!').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`akinator_wrong_${gameId}`).setLabel('Wrong').setStyle(ButtonStyle.Danger)
      );

      // 2. Send guess as NEW message
      const msg = await interaction.channel.send({ embeds: [guessEmbed], components: [row] });
      game.lastMessageId = msg.id;
    } else {
      game.count++;
      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🔮 Question ${game.count}`)
        .setDescription(text)
        .setFooter({ text: game.mode === 'individual' ? `Playing with ${interaction.user.username}` : 'Anyone can jump in!' });

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`akinator_yes_${gameId}`).setLabel('Yes').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`akinator_no_${gameId}`).setLabel('No').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`akinator_maybe_${gameId}`).setLabel('Maybe').setStyle(ButtonStyle.Secondary)
      );

      // 2. Send next question as NEW message
      const msg = await interaction.channel.send({ embeds: [embed], components: [buttons] });
      game.lastMessageId = msg.id;
    }
    
    // Refresh timeout for the NEW message
    setExpiryTimeout(gameId, interaction.channel, game.lastMessageId);

  } catch (err) {
    console.error(err);
    handleGameError(interaction, "Genie had a hiccup!", true);
  }
}

export async function handleAkinatorResult(interaction) {
  const [_, result, gameId] = interaction.customId.split('_');
  const game = gameStates.get(gameId);

  if (!game) return;
  
  // 1. Remove buttons from guess message
  await interaction.update({ components: [] });

  const embed = new EmbedBuilder()
    .setColor(result === 'correct' ? 0x00FF00 : 0xFF5555)
    .setTitle(result === 'correct' ? '🎉 Victory!' : '🔮 So close!')
    .setDescription(result === 'correct' ? 'I guessed it! I truly am a genius! ✨' : 'Darn! You beat me this time! Let\'s try again?');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('akinator_again').setLabel('Play Again').setStyle(ButtonStyle.Primary)
  );

  // 2. Send result as NEW message
  const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
  
  // Clean up old state, create temp state just for the "Play Again" button expiry
  gameStates.delete(gameId); // End the actual game logic
  
  const playAgainKey = `aki_again_${interaction.channelId}_${Date.now()}`;
  gameStates.set(playAgainKey, { lastMessageId: msg.id });
  setExpiryTimeout(playAgainKey, interaction.channel, msg.id);
}

export async function handleAkinatorAgain(interaction) {
  await interaction.update({ components: [] });
  await handleAkinatorInit(interaction);
}

// --- NEVER HAVE I EVER ---

export async function handleNHIE(interaction) {
  const stateKey = `nhie_${interaction.user.id}_${interaction.channelId}`;
  
  // 1. Remove button from previous message if this is a "Next" click
  if (interaction.isButton()) {
    await interaction.update({ components: [] });
  } else if (interaction.isStringSelectMenu()) {
    // If coming from main menu
    await interaction.update({ components: [] });
  }

  try {
    const chat = genAI.chats.create({ model: GAME_MODEL, config: { temperature: 0.9 } });
    const result = await chat.sendMessage({ message: 'Generate a fun "Never Have I Ever" statement. One sentence.' });
    const statement = result.text || "Never have I ever lied to a friend.";

    const embed = new EmbedBuilder()
      .setColor(0xF39C12)
      .setTitle('🙈 Never Have I Ever')
      .setDescription(statement)
      .setFooter({ text: 'React with 👍 / 👎 | Click Next for new one' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nhie_next').setLabel('Next').setStyle(ButtonStyle.Primary).setEmoji('➡️')
    );

    // 2. Send as NEW message
    const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
    
    // Add reactions
    try {
      await msg.react('👍');
      await msg.react('👎');
    } catch (e) {}

    gameStates.set(stateKey, { lastMessageId: msg.id });
    setExpiryTimeout(stateKey, interaction.channel, msg.id);
  } catch (error) {
    console.error(error);
    // Fallback if genAI fails
    await interaction.channel.send("Failed to generate NHIE statement.");
  }
}

export async function handleNHIENext(interaction) {
  await handleNHIE(interaction);
}

// --- WOULD YOU RATHER ---

export async function handleWYR(interaction) {
  const stateKey = `wyr_${interaction.user.id}_${interaction.channelId}`;
  
  // 1. Clean up previous message
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update({ components: [] });
  }

  try {
    const chat = genAI.chats.create({ model: GAME_MODEL, config: { temperature: 0.9 } });
    const result = await chat.sendMessage({ message: 'Generate a "Would You Rather" question with two options. Format: "Would you rather [A] or [B]?"' });
    const question = result.text || "Would you rather have 10 children or 0?";

    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('🤔 Would You Rather')
      .setDescription(question)
      .setFooter({ text: 'React with 1️⃣ / 2️⃣ | Click Next for new one' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wyr_next').setLabel('Next Dilemma').setStyle(ButtonStyle.Primary).setEmoji('➡️')
    );

    // 2. Send as NEW message
    const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
    
    // Simple reactions
    try {
      await msg.react('1️⃣');
      await msg.react('2️⃣');
    } catch (e) {}

    gameStates.set(stateKey, { lastMessageId: msg.id });
    setExpiryTimeout(stateKey, interaction.channel, msg.id);
  } catch (error) {
    console.error(error);
    await interaction.channel.send("Failed to generate WYR question.");
  }
}

export async function handleWYRNext(interaction) {
  await handleWYR(interaction);
}

// --- ERROR HANDLING ---

async function handleGameError(interaction, message, isEdit = false) {
  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('❌ Game Error')
    .setDescription(message);

  try {
    if (isEdit) {
      // If we are editing, we can't reply ephemerally usually, but we can send to channel
      await interaction.channel.send({ embeds: [embed] });
    } else if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ embeds: [embed], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (e) {}
}

// Kept for compatibility if imported elsewhere, but functionally empty or deprecated
export async function handleWYRVote() {} 
export async function handleWYRResults() {}
