import { EmbedBuilder, MessageFlags, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { genAI } from '../botManager.js';

const GAME_MODEL = 'gemini-2.5-flash';

export const gameCommand = {
  name: 'game',
  description: 'Play interactive games with AI'
};

export async function handleGameCommand(interaction) {
  try {
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
  } catch (error) {
    console.error('Error in handleGameCommand:', error);
    await handleGameError(interaction, 'Failed to load game menu. Please try again.');
  }
}

export async function handleGameSelect(interaction) {
  try {
    const game = interaction.values[0];
    
    const gameHandlers = {
      'truth_dare': handleTruthOrDare,
      'akinator': showAkinatorModeSelection,
      'tds': handleTDS,
      'nhie': handleNHIE,
      'wyr': handleWYR
    };
    
    const handler = gameHandlers[game];
    if (handler) {
      await handler(interaction);
    } else {
      throw new Error('Unknown game selected');
    }
  } catch (error) {
    console.error('Error in handleGameSelect:', error);
    await handleGameError(interaction, 'Failed to start game. Please try again.');
  }
}

async function handleTruthOrDare(interaction) {
  try {
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
  } catch (error) {
    console.error('Error in handleTruthOrDare:', error);
    await handleGameError(interaction, 'Failed to load Truth or Dare options.');
  }
}

export async function handleTODChoice(interaction) {
  try {
    const choice = interaction.values[0];
    
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0xE91E63).setDescription('🎲 Generating your challenge...')],
      components: []
    });
    
    const chat = genAI.chats.create({
      model: GAME_MODEL,
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
  } catch (error) {
    console.error('Error in handleTODChoice:', error);
    await handleGameError(interaction, 'Failed to generate challenge. Please try again.', true);
  }
}

export async function handleTODAgain(interaction) {
  try {
    await handleTruthOrDare(interaction);
  } catch (error) {
    console.error('Error in handleTODAgain:', error);
    await handleGameError(interaction, 'Failed to restart game.');
  }
}

async function showAkinatorModeSelection(interaction) {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('🔮 Akinator - Choose Mode')
      .setDescription('How do you want to play?');

    const modeSelect = new StringSelectMenuBuilder()
      .setCustomId('akinator_mode')
      .setPlaceholder('Select game mode')
      .addOptions(
        { label: 'Individual', value: 'individual', description: 'Only you can answer', emoji: '👤' },
        { label: 'Group', value: 'group', description: 'Everyone can participate', emoji: '👥' }
      );

    const row = new ActionRowBuilder().addComponents(modeSelect);

    await interaction.update({
      embeds: [embed],
      components: [row]
    });
  } catch (error) {
    console.error('Error in showAkinatorModeSelection:', error);
    await handleGameError(interaction, 'Failed to show Akinator mode selection.');
  }
}

export async function handleAkinatorModeSelect(interaction) {
  try {
    const mode = interaction.values[0];
    await startAkinator(interaction, mode);
  } catch (error) {
    console.error('Error in handleAkinatorModeSelect:', error);
    await handleGameError(interaction, 'Failed to start Akinator game.');
  }
}

async function startAkinator(interaction, mode = 'group') {
  try {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x9B59B6).setDescription('🔮 Starting Akinator...')],
      components: []
    });
    
    const chat = genAI.chats.create({
      model: GAME_MODEL,
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
    
    if (!interaction.client.akinatorGames) {
      interaction.client.akinatorGames = new Map();
    }
    
    const gameId = `${interaction.user.id}_${Date.now()}`;
    interaction.client.akinatorGames.set(gameId, {
      chat,
      questionCount: 0,
      answers: [],
      mode: mode,
      starterId: interaction.user.id
    });
    
    const result = await chat.sendMessage({
      message: 'Start the game by asking the first yes/no question.'
    });
    
    const question = result.text || 'Is your character real (not fictional)?';
    
    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('🔮 Akinator - Question 1')
      .setDescription(question)
      .setFooter({ text: mode === 'individual' ? `Individual Mode - Only ${interaction.user.username} can answer` : 'Group Mode - Everyone can participate!' });

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
  } catch (error) {
    console.error('Error in startAkinator:', error);
    await handleGameError(interaction, 'Failed to initialize Akinator. Please try again.', true);
  }
}

export async function handleAkinatorAnswer(interaction) {
  try {
    const [_, answer, gameId] = interaction.customId.split('_');
    
    const game = interaction.client.akinatorGames?.get(gameId);
    
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
    
    if (game.mode === 'individual' && interaction.user.id !== game.starterId) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Not Your Turn')
        .setDescription(`This is an individual game! Only <@${game.starterId}> can answer.`);
      
      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }
    
    game.questionCount++;
    game.answers.push(answer);
    
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x9B59B6).setDescription('🔮 Thinking...')],
      components: []
    });
    
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
      const result = await game.chat.sendMessage({
        message: `The answer was "${answer}". Ask the next strategic yes/no question.`
      });
      
      const question = result.text || 'Does your character have special powers?';
      
      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🔮 Akinator - Question ${game.questionCount + 1}`)
        .setDescription(question)
        .setFooter({ text: game.mode === 'individual' ? `Individual Mode - Only ${(await interaction.client.users.fetch(game.starterId)).username} can answer` : 'Group Mode - Everyone can participate!' });

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
  } catch (error) {
    console.error('Error in handleAkinatorAnswer:', error);
    await handleGameError(interaction, 'An error occurred while processing your answer.', true);
  }
}

export async function handleAkinatorResult(interaction) {
  try {
    const [_, result, gameId] = interaction.customId.split('_');
    
    const game = interaction.client.akinatorGames?.get(gameId);
    
    if (game && game.mode === 'individual' && interaction.user.id !== game.starterId) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Not Your Turn')
        .setDescription(`This is an individual game! Only <@${game.starterId}> can respond.`);
      
      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }
    
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
  } catch (error) {
    console.error('Error in handleAkinatorResult:', error);
    await handleGameError(interaction, 'Failed to process game result.');
  }
}

export async function handleAkinatorAgain(interaction) {
  try {
    await showAkinatorModeSelection(interaction);
  } catch (error) {
    console.error('Error in handleAkinatorAgain:', error);
    await handleGameError(interaction, 'Failed to restart Akinator.');
  }
}

async function handleTDS(interaction) {
  try {
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
  } catch (error) {
    console.error('Error in handleTDS:', error);
    await handleGameError(interaction, 'Failed to load TDS options.');
  }
}

export async function handleTDSChoice(interaction) {
  try {
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
      model: GAME_MODEL,
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
  } catch (error) {
    console.error('Error in handleTDSChoice:', error);
    await handleGameError(interaction, 'Failed to generate challenge. Please try again.', true);
  }
}

export async function handleTDSAgain(interaction) {
  try {
    await handleTDS(interaction);
  } catch (error) {
    console.error('Error in handleTDSAgain:', error);
    await handleGameError(interaction, 'Failed to restart game.');
  }
}

async function handleNHIE(interaction) {
  try {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0xF39C12).setDescription('🙈 Generating statement...')],
      components: []
    });
    
    const chat = genAI.chats.create({
      model: GAME_MODEL,
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
    
    try {
      await message.react('👍');
      await message.react('👎');
    } catch (error) {
      console.error('Error adding reactions:', error);
    }
  } catch (error) {
    console.error('Error in handleNHIE:', error);
    await handleGameError(interaction, 'Failed to generate statement. Please try again.', true);
  }
}

export async function handleNHIENext(interaction) {
  try {
    try {
      const message = interaction.message;
      await message.reactions.removeAll();
    } catch (error) {
      console.error('Error removing reactions:', error);
    }
    
    await handleNHIE(interaction);
  } catch (error) {
    console.error('Error in handleNHIENext:', error);
    await handleGameError(interaction, 'Failed to generate next statement.');
  }
}

export async function handleWYR(interaction) {
  try {
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x3498DB).setDescription('🤔 Creating dilemma...')],
      components: []
    });
    
    const chat = genAI.chats.create({
      model: GAME_MODEL,
      config: {
        systemInstruction: 'Generate a "Would You Rather" question with two difficult but interesting choices. Make them balanced in difficulty. Format: "Would you rather [option A] or [option B]?"',
        temperature: 0.9
      }
    });
    
    const result = await chat.sendMessage({
      message: 'Generate one Would You Rather question'
    });
    
    const question = result.text || 'Would you rather have the ability to fly or be invisible?';
    
    const gameId = `wyr_${Date.now()}`;
    if (!interaction.client.wyrGames) {
      interaction.client.wyrGames = new Map();
    }
    
    interaction.client.wyrGames.set(gameId, {
      question,
      votes: {
        option1: [],
        option2: []
      }
    });
    
    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('🤔 Would You Rather')
      .setDescription(question)
      .setFooter({ text: 'Click a button to vote!' });

    const option1Button = new ButtonBuilder()
      .setCustomId(`wyr_option1_${gameId}`)
      .setLabel('Option 1')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('1️⃣');

    const option2Button = new ButtonBuilder()
      .setCustomId(`wyr_option2_${gameId}`)
      .setLabel('Option 2')
      .setStyle(ButtonStyle.Success)
      .setEmoji('2️⃣');

    const resultsButton = new ButtonBuilder()
      .setCustomId(`wyr_results_${gameId}`)
      .setLabel('Show Results')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📊');

    const nextButton = new ButtonBuilder()
      .setCustomId(`wyr_next_${gameId}`)
      .setLabel('Next Question')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('➡️');

    const row = new ActionRowBuilder().addComponents(option1Button, option2Button, resultsButton, nextButton);

    await interaction.editReply({
      embeds: [embed],
      components: [row]
    });
  } catch (error) {
    console.error('Error in handleWYR:', error);
    await handleGameError(interaction, 'Failed to generate question. Please try again.', true);
  }
}

export async function handleWYRVote(interaction) {
  try {
    const [_, option, gameId] = interaction.customId.split('_');
    
    const game = interaction.client.wyrGames?.get(gameId);
    
    if (!game) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Game Expired')
        .setDescription('This game has expired. Start a new one!');
      
      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }
    
    const userId = interaction.user.id;
    const selectedOption = option === 'option1' ? 'option1' : 'option2';
    const otherOption = selectedOption === 'option1' ? 'option2' : 'option1';
    
    game.votes[otherOption] = game.votes[otherOption].filter(id => id !== userId);
    
    if (game.votes[selectedOption].includes(userId)) {
      game.votes[selectedOption] = game.votes[selectedOption].filter(id => id !== userId);
      
      const embed = new EmbedBuilder()
        .setColor(0xFFAA00)
        .setTitle('🗳️ Vote Removed')
        .setDescription('Your vote has been removed!');
      
      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    } else {
      game.votes[selectedOption].push(userId);
      
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ Vote Recorded')
        .setDescription(`You voted for: **${selectedOption === 'option1' ? 'Option 1' : 'Option 2'}**!`);
      
      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }
  } catch (error) {
    console.error('Error in handleWYRVote:', error);
    await handleGameError(interaction, 'Failed to record vote. Please try again.', false, true);
  }
}

export async function handleWYRResults(interaction) {
  try {
    const [_, __, gameId] = interaction.customId.split('_');
    
    const game = interaction.client.wyrGames?.get(gameId);
    
    if (!game) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Game Expired')
        .setDescription('This game has expired. Start a new one!');
      
      return interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    }
    
    const totalVotes = game.votes.option1.length + game.votes.option2.length;
    const option1Percent = totalVotes > 0 ? Math.round((game.votes.option1.length / totalVotes) * 100) : 0;
    const option2Percent = totalVotes > 0 ? Math.round((game.votes.option2.length / totalVotes) * 100) : 0;
    
    const embed = new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle('📊 Vote Results')
      .setDescription(game.question)
      .addFields(
        { 
          name: `1️⃣ Option 1 (${option1Percent}%)`, 
          value: `${game.votes.option1.length} vote${game.votes.option1.length !== 1 ? 's' : ''}${game.votes.option1.length > 0 ? '\n' + game.votes.option1.map(id => `<@${id}>`).join(', ') : ''}`,
          inline: false 
        },
        { 
          name: `2️⃣ Option 2 (${option2Percent}%)`, 
          value: `${game.votes.option2.length} vote${game.votes.option2.length !== 1 ? 's' : ''}${game.votes.option2.length > 0 ? '\n' + game.votes.option2.map(id => `<@${id}>`).join(', ') : ''}`,
          inline: false 
        }
      )
      .setFooter({ text: `Total votes: ${totalVotes}` });
    
    await interaction.reply({
      embeds: [embed]
    });
  } catch (error) {
    console.error('Error in handleWYRResults:', error);
    await handleGameError(interaction, 'Failed to show results. Please try again.', false, true);
  }
}

export async function handleWYRNext(interaction) {
  try {
    const [_, __, oldGameId] = interaction.customId.split('_');
    
    const oldGame = interaction.client.wyrGames?.get(oldGameId);
    if (oldGame) {
      const totalVotes = oldGame.votes.option1.length + oldGame.votes.option2.length;
      const option1Percent = totalVotes > 0 ? Math.round((oldGame.votes.option1.length / totalVotes) * 100) : 0;
      const option2Percent = totalVotes > 0 ? Math.round((oldGame.votes.option2.length / totalVotes) * 100) : 0;
      
      const resultsEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('📊 Final Results - Previous Round')
        .setDescription(oldGame.question)
        .addFields(
          { 
            name: `1️⃣ Option 1 (${option1Percent}%)`, 
            value: `${oldGame.votes.option1.length} vote${oldGame.votes.option1.length !== 1 ? 's' : ''}`,
            inline: true 
          },
          { 
            name: `2️⃣ Option 2 (${option2Percent}%)`, 
            value: `${oldGame.votes.option2.length} vote${oldGame.votes.option2.length !== 1 ? 's' : ''}`,
            inline: true 
          }
        )
        .setFooter({ text: `Total votes: ${totalVotes}` });
      
      await interaction.channel.send({
        embeds: [resultsEmbed]
      });
      
      interaction.client.wyrGames.delete(oldGameId);
    }
    
    await handleWYR(interaction);
  } catch (error) {
    console.error('Error in handleWYRNext:', error);
    await handleGameError(interaction, 'Failed to start next round.');
  }
}

async function handleGameError(interaction, message, isEdit = false, isReply = false) {
  try {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Game Error')
      .setDescription(message)
      .setFooter({ text: 'Try using /game to start over' });

    if (isReply) {
      await interaction.reply({
        embeds: [embed],
        ephemeral: true
      });
    } else if (isEdit) {
      await interaction.editReply({
        embeds: [embed],
        components: []
      });
    } else {
      await interaction.update({
        embeds: [embed],
        components: []
      });
    }
  } catch (finalError) {
    console.error('Fatal error in handleGameError:', finalError);
  }
}
