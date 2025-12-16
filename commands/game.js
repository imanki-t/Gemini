import { EmbedBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { genAI } from '../botManager.js';

export const gameCommand = {
  name: 'game',
  description: 'Play interactive games with AI'
};

export async function handleGameCommand(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('🎮 Interactive Games')
    .setDescription('Choose a game to play!');

  const gameSelect = new StringSelectMenuBuilder()
    .setCustomId('game_select')
    .setPlaceholder('Select a game')
    .addOptions(
      { label: 'Truth or Dare', value: 'truth_dare', description: 'Classic party game', emoji: '🎲' },
      { label: 'Akinator', value: 'akinator', description: 'I\'ll guess who you\'re thinking of!', emoji: '🔮' },
      { label: 'Truth, Dare or Situation', value: 'tds', description: 'Extended version with situations', emoji: '🎭' },
      { label: 'Never Have I Ever', value: 'nhie', description: 'Share experiences', emoji: '🙈' },
      { label: 'Would You Rather', value: 'wyr', description: 'Difficult choices', emoji: '🤔' }
    );

  const row = new ActionRowBuilder().addComponents(gameSelect);

  await interaction.reply({
    embeds: [embed],
    components: [row]
  });
}

export async function handleGameSelect(interaction) {
  const game = interaction.values[0];
  
  const gameHandlers = {
    'truth_dare': handleTruthOrDare,
    'akinator': handleAkinator,
    'tds': handleTDS,
    'nhie': handleNHIE,
    'wyr': handleWYR
  };
  
  await gameHandlers[game](interaction);
}

// ============= TRUTH OR DARE =============
async function handleTruthOrDare(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle('🎲 Truth or Dare')
    .setDescription('Choose wisely...');

  const choiceSelect = new StringSelectMenuBuilder()
    .setCustomId('tod_choice')
    .setPlaceholder('Pick one')
    .addOptions(
      { label: 'Truth', value: 'truth', description: 'Answer honestly', emoji: '💭' },
      { label: 'Dare', value: 'dare', description: 'Accept the challenge', emoji: '⚡' }
    );

  const row = new ActionRowBuilder().addComponents(choiceSelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleTODChoice(interaction) {
  const choice = interaction.values[0];
  
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0xE91E63).setDescription('🎲 Generating your challenge...')],
    components: []
  });
  
  const chat = genAI.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: `Generate a ${choice === 'truth' ? 'truth question' : 'dare challenge'} for a Discord game. 
Rules:
- ${choice === 'truth' ? 'Ask an interesting, thought-provoking question' : 'Create a fun, safe dare (nothing dangerous or inappropriate)'}
- Keep it appropriate for all ages
- Make it engaging and creative
- One sentence only`,
      temperature: 0.9
    }
  });
  
  const result = await chat.sendMessage({
    message: `Generate one ${choice}`
  });
  
  const challenge = result.text || (choice === 'truth' ? 
    'What\'s the most embarrassing thing that happened to you in public?' : 
    'Do 10 jumping jacks and share a video!');
  
  const embed = new EmbedBuilder()
    .setColor(0xE91E63)
    .setTitle(`${choice === 'truth' ? '💭 Truth' : '⚡ Dare'}`)
    .setDescription(challenge)
    .setFooter({ text: 'Use /game to play again!' });

  const againButton = new ButtonBuilder()
    .setCustomId('tod_again')
    .setLabel('Play Again')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('🔄');

  const row = new ActionRowBuilder().addComponents(againButton);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
}

export async function handleTODAgain(interaction) {
  await handleTruthOrDare(interaction);
}

// ============= AKINATOR =============
async function handleAkinator(interaction) {
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setDescription('🔮 Starting Akinator...')],
    components: []
  });
  
  const chat = genAI.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: `You are Akinator, the genie who guesses characters. 
Rules:
1. Ask ONE yes/no question at a time
2. Be strategic and narrow down based on previous answers
3. After 5-7 questions, make a guess
4. Keep questions concise and clear
5. Ask about: appearance, personality, occupation, fictional/real, time period, etc.

Start with a broad question.`,
      temperature: 0.8
    }
  });
  
  // Store game state
  if (!interaction.client.akinatorGames) {
    interaction.client.akinatorGames = new Map();
  }
  
  const gameId = `${interaction.user.id}_${Date.now()}`;
  interaction.client.akinatorGames.set(gameId, {
    chat,
    questionCount: 0,
    answers: []
  });
  
  const result = await chat.sendMessage({
    message: 'Start the game by asking the first yes/no question.'
  });
  
  const question = result.text || 'Is your character real (not fictional)?';
  
  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('🔮 Akinator - Question 1')
    .setDescription(question);

  const yesButton = new ButtonBuilder()
    .setCustomId(`akinator_yes_${gameId}`)
    .setLabel('Yes')
    .setStyle(ButtonStyle.Success);

  const noButton = new ButtonBuilder()
    .setCustomId(`akinator_no_${gameId}`)
    .setLabel('No')
    .setStyle(ButtonStyle.Danger);

  const maybeButton = new ButtonBuilder()
    .setCustomId(`akinator_maybe_${gameId}`)
    .setLabel('Maybe/Probably')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(yesButton, noButton, maybeButton);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
}

export async function handleAkinatorAnswer(interaction) {
  const [_, answer, gameId] = interaction.customId.split('_');
  
  const game = interaction.client.akinatorGames.get(gameId);
  
  if (!game) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Game Expired')
      .setDescription('This game session has expired. Start a new one with `/game`!');
    
    return interaction.update({
      embeds: [embed],
      components: []
    });
  }
  
  game.questionCount++;
  game.answers.push(answer);
  
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x9B59B6).setDescription('🔮 Thinking...')],
    components: []
  });
  
  // Check if we should guess
  if (game.questionCount >= 6) {
    const result = await game.chat.sendMessage({
      message: `Based on the answers, make your final guess. Say "I think you're thinking of: [CHARACTER NAME]" with a brief explanation why.`
    });
    
    const guess = result.text || 'I think you\'re thinking of: Someone mysterious!';
    
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('🔮 Final Guess!')
      .setDescription(guess)
      .setFooter({ text: `Questions asked: ${game.questionCount}` });

    const correctButton = new ButtonBuilder()
      .setCustomId(`akinator_correct_${gameId}`)
      .setLabel('Correct!')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅');

    const wrongButton = new ButtonBuilder()
      .setCustomId(`akinator_wrong_${gameId}`)
      .setLabel('Wrong')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌');

    const row = new ActionRowBuilder().addComponents(correctButton, wrongButton);

    await interaction.editReply({
      embeds: [embed],
      components: [row]
    });
    
  } else {
    // Ask another question
    const result = await game.chat.sendMessage({
      message: `The answer was "${answer}". Ask the next strategic yes/no question.`
    });
    
    const question = result.text || 'Does your character have special powers?';
    
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle(`🔮 Akinator - Question ${game.questionCount + 1}`)
      .setDescription(question);

    const yesButton = new ButtonBuilder()
      .setCustomId(`akinator_yes_${gameId}`)
      .setLabel('Yes')
      .setStyle(ButtonStyle.Success);

    const noButton = new ButtonBuilder()
      .setCustomId(`akinator_no_${gameId}`)
      .setLabel('No')
      .setStyle(ButtonStyle.Danger);

    const maybeButton = new ButtonBuilder()
      .setCustomId(`akinator_maybe_${gameId}`)
      .setLabel('Maybe/Probably')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(yesButton, noButton, maybeButton);

    await interaction.editReply({
      embeds: [embed],
      components: [row]
    });
  }
}

export async function handleAkinatorResult(interaction) {
  const [_, result, gameId] = interaction.customId.split('_');
  
  const game = interaction.client.akinatorGames.get(gameId);
  if (game) {
    interaction.client.akinatorGames.delete(gameId);
  }
  
  const emoji = result === 'correct' ? '🎉' : '😅';
  const message = result === 'correct' ? 
    'I knew it! I\'m Akinator, after all! 🔮✨' : 
    'Darn! I was so close! Want to play again?';
  
  const embed = new EmbedBuilder()
    .setColor(result === 'correct' ? 0x00FF00 : 0xFF5555)
    .setTitle(`${emoji} ${result === 'correct' ? 'Victory!' : 'So Close!'}`)
    .setDescription(message);

  const playAgainButton = new ButtonBuilder()
    .setCustomId('akinator_again')
    .setLabel('Play Again')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('🔄');

  const row = new ActionRowBuilder().addComponents(playAgainButton);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleAkinatorAgain(interaction) {
  await handleAkinator(interaction);
}

// ============= TRUTH DARE SITUATION =============
async function handleTDS(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xFF6B6B)
    .setTitle('🎭 Truth, Dare, or Situation')
    .setDescription('Choose your challenge type!');

  const choiceSelect = new StringSelectMenuBuilder()
    .setCustomId('tds_choice')
    .setPlaceholder('Pick one')
    .addOptions(
      { label: 'Truth', value: 'truth', description: 'Answer a question honestly', emoji: '💭' },
      { label: 'Dare', value: 'dare', description: 'Complete a challenge', emoji: '⚡' },
      { label: 'Situation', value: 'situation', description: 'Hypothetical scenario', emoji: '🎭' }
    );

  const row = new ActionRowBuilder().addComponents(choiceSelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleTDSChoice(interaction) {
  const choice = interaction.values[0];
  
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0xFF6B6B).setDescription('🎭 Creating your challenge...')],
    components: []
  });
  
  let prompt = '';
  if (choice === 'truth') {
    prompt = 'Generate an interesting truth question';
  } else if (choice === 'dare') {
    prompt = 'Generate a fun, safe dare';
  } else {
    prompt = 'Generate a hypothetical situation question (e.g., "What would you do if...")';
  }
  
  const chat = genAI.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: `${prompt}. Keep it appropriate, engaging, and creative. One sentence only.`,
      temperature: 0.9
    }
  });
  
  const result = await chat.sendMessage({
    message: prompt
  });
  
  const challenge = result.text || `Here's your ${choice}!`;
  
  const emojiMap = { truth: '💭', dare: '⚡', situation: '🎭' };
  
  const embed = new EmbedBuilder()
    .setColor(0xFF6B6B)
    .setTitle(`${emojiMap[choice]} ${choice.charAt(0).toUpperCase() + choice.slice(1)}`)
    .setDescription(challenge);

  const againButton = new ButtonBuilder()
    .setCustomId('tds_again')
    .setLabel('Play Again')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('🔄');

  const row = new ActionRowBuilder().addComponents(againButton);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
}

export async function handleTDSAgain(interaction) {
  await handleTDS(interaction);
}

// ============= NEVER HAVE I EVER =============
async function handleNHIE(interaction) {
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0xF39C12).setDescription('🙈 Generating statement...')],
    components: []
  });
  
  const chat = genAI.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: 'Generate a "Never Have I Ever" statement. Keep it appropriate, interesting, and relatable. Format: "Never have I ever [action]"',
      temperature: 0.9
    }
  });
  
  const result = await chat.sendMessage({
    message: 'Generate one Never Have I Ever statement'
  });
  
  const statement = result.text || 'Never have I ever stayed up all night gaming';
  
  const embed = new EmbedBuilder()
    .setColor(0xF39C12)
    .setTitle('🙈 Never Have I Ever')
    .setDescription(statement)
    .setFooter({ text: 'React with 👍 if you HAVE, 👎 if you HAVEN\'T' });

  const nextButton = new ButtonBuilder()
    .setCustomId('nhie_next')
    .setLabel('Next Statement')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('➡️');

  const row = new ActionRowBuilder().addComponents(nextButton);

  const message = await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
  
  // Add reactions
  await message.react('👍');
  await message.react('👎');
}

export async function handleNHIENext(interaction) {
  await handleNHIE(interaction);
}

// ============= WOULD YOU RATHER =============
// ADDED: Export this function that was missing
export async function handleWYR(interaction) {
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x3498DB).setDescription('🤔 Creating dilemma...')],
    components: []
  });
  
  const chat = genAI.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: 'Generate a "Would You Rather" question with two difficult but interesting choices. Make them balanced in difficulty. Format: "Would you rather [option A] or [option B]?"',
      temperature: 0.9
    }
  });
  
  const result = await chat.sendMessage({
    message: 'Generate one Would You Rather question'
  });
  
  const question = result.text || 'Would you rather have the ability to fly or be invisible?';
  
  const embed = new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle('🤔 Would You Rather')
    .setDescription(question)
    .setFooter({ text: 'Click a button to vote!' });

  const option1Button = new ButtonBuilder()
    .setCustomId('wyr_option1')
    .setLabel('Option 1')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('1️⃣');

  const option2Button = new ButtonBuilder()
    .setCustomId('wyr_option2')
    .setLabel('Option 2')
    .setStyle(ButtonStyle.Success)
    .setEmoji('2️⃣');

  const nextButton = new ButtonBuilder()
    .setCustomId('wyr_next')
    .setLabel('Next Question')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('➡️');

  const row = new ActionRowBuilder().addComponents(option1Button, option2Button, nextButton);

  await interaction.editReply({
    embeds: [embed],
    components: [row]
  });
}

export async function handleWYRVote(interaction) {
  const choice = interaction.customId.includes('option1') ? 'Option 1' : 'Option 2';
  
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Vote Recorded')
    .setDescription(`You chose: **${choice}**!`)
    .setFooter({ text: 'Click "Next Question" for another dilemma' });

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral
  });
}

export async function handleWYRNext(interaction) {
  await handleWYR(interaction);
}
