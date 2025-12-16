import { EmbedBuilder, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { state, saveStateToFile, genAI } from '../botManager.js';
import * as db from '../database.js';

export const birthdayCommand = {
  name: 'birthday',
  description: 'Manage your birthday reminders',
  options: [
    {
      name: 'action',
      description: 'What do you want to do?',
      type: 3,
      required: true,
      choices: [
        { name: 'Set Birthday', value: 'set' },
        { name: 'Remove Birthday', value: 'remove' },
        { name: 'List Birthdays', value: 'list' }
      ]
    }
  ]
};

export async function handleBirthdayCommand(interaction) {
  const action = interaction.options.getString('action');
  
  if (action === 'set') {
    await showBirthdaySetup(interaction);
  } else if (action === 'remove') {
    await removeBirthday(interaction);
  } else if (action === 'list') {
    await listBirthdays(interaction);
  }
}

async function showBirthdaySetup(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xFF69B4)
    .setTitle('🎂 Birthday Setup')
    .setDescription('Let\'s set up your birthday reminder!\n\nPlease select your birth month first:')
    .setFooter({ text: 'Your birthday will never be shared without permission' });

  const monthSelect = new StringSelectMenuBuilder()
    .setCustomId('birthday_month')
    .setPlaceholder('Select your birth month')
    .addOptions(
      { label: 'January', value: '01', emoji: '❄️' },
      { label: 'February', value: '02', emoji: '💝' },
      { label: 'March', value: '03', emoji: '🌸' },
      { label: 'April', value: '04', emoji: '🌷' },
      { label: 'May', value: '05', emoji: '🌺' },
      { label: 'June', value: '06', emoji: '☀️' },
      { label: 'July', value: '07', emoji: '🎆' },
      { label: 'August', value: '08', emoji: '🏖️' },
      { label: 'September', value: '09', emoji: '🍂' },
      { label: 'October', value: '10', emoji: '🎃' },
      { label: 'November', value: '11', emoji: '🍁' },
      { label: 'December', value: '12', emoji: '🎄' }
    );

  const row = new ActionRowBuilder().addComponents(monthSelect);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
}

function getDaysInMonth(month) {
  const monthNum = parseInt(month);
  if (monthNum === 2) return 29;
  if ([4, 6, 9, 11].includes(monthNum)) return 30;
  return 31;
}

export async function handleBirthdayMonthSelect(interaction) {
  const month = interaction.values[0];
  const maxDays = getDaysInMonth(month);
  
  const embed = new EmbedBuilder()
    .setColor(0xFF69B4)
    .setTitle('🎂 Birthday Setup - Day')
    .setDescription(`You selected **${getMonthName(month)}**.\nNow select the day of the month:`);

  const daySelect1 = new StringSelectMenuBuilder()
    .setCustomId(`birthday_day_${month}_1`)
    .setPlaceholder('Select day (1-15)')
    .addOptions(
      Array.from({ length: 15 }, (_, i) => ({
        label: String(i + 1),
        value: String(i + 1).padStart(2, '0')
      }))
    );

  const remainingDays = maxDays - 15;
  const daySelect2 = new StringSelectMenuBuilder()
    .setCustomId(`birthday_day_${month}_2`)
    .setPlaceholder(`Select day (16-${maxDays})`)
    .addOptions(
      Array.from({ length: remainingDays }, (_, i) => ({
        label: String(i + 16),
        value: String(i + 16).padStart(2, '0')
      }))
    );

  const row1 = new ActionRowBuilder().addComponents(daySelect1);
  const row2 = new ActionRowBuilder().addComponents(daySelect2);

  await interaction.update({
    embeds: [embed],
    components: [row1, row2]
  });
}

export async function handleBirthdayDaySelect(interaction) {
  const parts = interaction.customId.split('_');
  const month = parts[2]; 
  const day = interaction.values[0];
  
  const embed = new EmbedBuilder()
    .setColor(0xFF69B4)
    .setTitle('🎂 Birthday Setup - Notification Preferences')
    .setDescription(`Birthday: **${getMonthName(month)} ${parseInt(day)}**\n\nWhere should I send birthday wishes?`);

  const preferenceSelect = new StringSelectMenuBuilder()
    .setCustomId(`birthday_pref_${month}_${day}`)
    .setPlaceholder('Choose notification preference')
    .addOptions(
      { label: 'DMs Only', value: 'dm', description: 'Receive wishes in direct messages', emoji: '📬' },
      { label: 'Server Only', value: 'server', description: 'Get celebrated in the server', emoji: '🎉' },
      { label: 'Both', value: 'both', description: 'DM + Server celebration', emoji: '🎊' }
    );

  const row = new ActionRowBuilder().addComponents(preferenceSelect);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

export async function handleBirthdayPrefSelect(interaction) {
  const [_, __, month, day] = interaction.customId.split('_');
  const preference = interaction.values[0];
  
  const userId = interaction.user.id;
  const guildId = interaction.guild?.id;
  
  if (!state.birthdays) {
    state.birthdays = {};
  }
  
  if (!state.birthdays[userId]) {
    state.birthdays[userId] = {};
  }
  
  state.birthdays[userId] = {
    month,
    day,
    preference,
    guildId: preference !== 'dm' ? guildId : null,
    year: null
  };
  
  await db.saveBirthday(userId, state.birthdays[userId]);
  await saveStateToFile();
  
  const prefText = {
    dm: 'DMs only',
    server: 'this server only',
    both: 'DMs and this server'
  }[preference];
  
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Birthday Saved!')
    .setDescription(`Your birthday is set for **${getMonthName(month)} ${parseInt(day)}**!\n\nYou'll receive birthday wishes via: **${prefText}** 🎂`)
    .setFooter({ text: 'You can change or remove this anytime with /birthday' });

  await interaction.update({
    embeds: [embed],
    components: []
  });
}

async function removeBirthday(interaction) {
  const userId = interaction.user.id;
  
  if (!state.birthdays?.[userId]) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ No Birthday Found')
      .setDescription('You don\'t have a birthday set up yet!\n\nUse `/birthday set` to add one.');
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  delete state.birthdays[userId];
  await db.deleteBirthday(userId);
  await saveStateToFile();
  
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Birthday Removed')
    .setDescription('Your birthday reminder has been removed successfully.');

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function listBirthdays(interaction) {
  const guildId = interaction.guild?.id;
  
  if (!state.birthdays || Object.keys(state.birthdays).length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('📅 No Birthdays')
      .setDescription('No one has set their birthday yet!\n\nBe the first with `/birthday set`');
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  const birthdays = [];
  const currentMonth = new Date().getMonth() + 1;
  
  for (const [userId, data] of Object.entries(state.birthdays)) {
    if (guildId && data.guildId === guildId && data.preference !== 'dm') {
      const user = await interaction.client.users.fetch(userId).catch(() => null);
      if (user) {
        birthdays.push({
          user: user.username,
          month: data.month,
          day: data.day,
          monthNum: parseInt(data.month)
        });
      }
    }
  }
  
  if (birthdays.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('📅 No Server Birthdays')
      .setDescription('No birthdays are set to be celebrated in this server.');
    
    return interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
  
  birthdays.sort((a, b) => {
    if (a.monthNum !== b.monthNum) return a.monthNum - b.monthNum;
    return parseInt(a.day) - parseInt(b.day);
  });
  
  const upcomingBirthdays = birthdays.filter(b => 
    b.monthNum > currentMonth || (b.monthNum === currentMonth && parseInt(b.day) >= new Date().getDate())
  );
  
  const pastBirthdays = birthdays.filter(b => 
    b.monthNum < currentMonth || (b.monthNum === currentMonth && parseInt(b.day) < new Date().getDate())
  );
  
  const sortedBirthdays = [...upcomingBirthdays, ...pastBirthdays];
  
  const birthdayList = sortedBirthdays
    .map(b => `🎂 **${b.user}** - ${getMonthName(b.month)} ${parseInt(b.day)}`)
    .join('\n');
  
  const embed = new EmbedBuilder()
    .setColor(0xFF69B4)
    .setTitle('🎉 Server Birthdays')
    .setDescription(birthdayList || 'No birthdays to display')
    .setFooter({ text: `${birthdays.length} birthday${birthdays.length !== 1 ? 's' : ''} registered` });

  await interaction.reply({
    embeds: [embed]
  });
}

function getMonthName(monthNum) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return months[parseInt(monthNum) - 1];
}

export function scheduleBirthdayChecks(client) {
  const checkBirthdays = async () => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    if (!state.birthdays) return;
    
    for (const [userId, data] of Object.entries(state.birthdays)) {
      if (data.month === month && data.day === day) {
        await sendBirthdayWish(client, userId, data);
      }
    }
  };
  
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const timeUntilMidnight = tomorrow - now;
  
  setTimeout(() => {
    checkBirthdays();
    setInterval(checkBirthdays, 24 * 60 * 60 * 1000);
  }, timeUntilMidnight);
}

async function sendBirthdayWish(client, userId, data) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;
  
  try {
    const request = {
      model: 'gemini-2.0-flash-exp',
      contents: [{ role: 'user', parts: [{ text: `Write a birthday wish for ${user.username}` }] }],
      systemInstruction: { parts: [{ text: 'Generate a short, warm, and personalized birthday wish (2-3 sentences). Be genuine and heartfelt. Include emojis.' }] },
      generationConfig: {
        temperature: 0.9
      }
    };
    
    const result = await genAI.models.generateContent(request);
    const wishMessage = result.text || `Happy Birthday, ${user.username}! 🎂🎉 Wishing you an amazing day filled with joy!`;
    
    const embed = new EmbedBuilder()
      .setColor(0xFF69B4)
      .setTitle('🎉 Happy Birthday! 🎂')
      .setDescription(wishMessage)
      .setThumbnail(user.displayAvatarURL())
      .setFooter({ text: '🎊 Hope your day is as special as you are!' })
      .setTimestamp();
    
    if (data.preference === 'dm' || data.preference === 'both') {
      try {
        await user.send({ embeds: [embed] });
      } catch (error) {
        console.error(`Could not send birthday DM to ${userId}:`, error);
      }
    }
    
    if ((data.preference === 'server' || data.preference === 'both') && data.guildId) {
      try {
        const guild = client.guilds.cache.get(data.guildId);
        if (guild) {
          const channel = guild.channels.cache.find(ch => 
            ch.isTextBased() && 
            ch.permissionsFor(guild.members.me).has('SendMessages')
          );
          
          if (channel) {
            await channel.send({
              content: `🎉 @everyone It's <@${userId}>'s birthday today! 🎂`,
              embeds: [embed]
            });
          }
        }
      } catch (error) {
        console.error(`Could not send birthday message in server ${data.guildId}:`, error);
      }
    }
  } catch (error) {
    console.error('Error generating birthday wish:', error);
    const fallbackMessage = `Happy Birthday, ${user.username}! 🎂🎉 Wishing you an amazing day filled with joy!`;
    const embed = new EmbedBuilder()
      .setColor(0xFF69B4)
      .setTitle('🎉 Happy Birthday! 🎂')
      .setDescription(fallbackMessage)
      .setThumbnail(user.displayAvatarURL())
      .setFooter({ text: '🎊 Hope your day is as special as you are!' })
      .setTimestamp();
    
    if (data.preference === 'dm' || data.preference === 'both') {
      try {
        await user.send({ embeds: [embed] });
      } catch (e) {}
    }
    if ((data.preference === 'server' || data.preference === 'both') && data.guildId) {
      try {
        const guild = client.guilds.cache.get(data.guildId);
        const channel = guild?.channels.cache.find(ch => ch.isTextBased());
        if (channel) {
          await channel.send({ content: `🎉 It's <@${userId}>'s birthday!`, embeds: [embed] });
        }
      } catch (e) {}
    }
  }
}


    
