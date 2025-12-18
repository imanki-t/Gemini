import { EmbedBuilder, PermissionsBitField, MessageFlags } from 'discord.js';
import { state, saveStateToFile, genAI } from '../botManager.js';
import * as db from '../database.js';

// Model for generating revival messages
const REVIVAL_MODEL = 'gemini-2.5-flash-lite';

export const realiveCommand = {
  name: 'realive',
  description: 'Periodically send messages to revive dead chats (Server Only)'
};

export async function handleRealiveCommand(interaction) {
  const guild = interaction.guild;
  
  // 1. Check Server Only
  if (!guild) {
    return interaction.reply({
      content: '❌ This command can only be used in servers.',
      flags: MessageFlags.Ephemeral
    });
  }

  // 2. Check Permissions (Manage Server)
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({
      content: '🚫 You need **Manage Server** permission to configure chat revival.',
      flags: MessageFlags.Ephemeral
    });
  }

  const action = interaction.options.getString('action');
  const hours = interaction.options.getInteger('hours');
  const guildId = guild.id;

  // Initialize state if missing
  if (!state.realive) {
    state.realive = {};
  }
  if (!state.realive[guildId]) {
    state.realive[guildId] = {
      enabled: false,
      intervalHours: 12, // Default
      lastRun: 0,
      lastChannelId: null // Tracks where to send
    };
  }

  const config = state.realive[guildId];

  if (action === 'enable') {
    config.enabled = true;
    // If we have a last active channel, good. If not, we set it to current channel.
    if (!config.lastChannelId) {
      config.lastChannelId = interaction.channelId;
    }
    
    await saveConfig(guildId, config);
    
    return interaction.reply({
      content: `✅ **Chat Revival Enabled!**\n\nI will attempt to revive dead chats every **${config.intervalHours} hours** in the last active channel (<#${config.lastChannelId}>).`,
    });

  } else if (action === 'disable') {
    config.enabled = false;
    await saveConfig(guildId, config);

    return interaction.reply({
      content: '🛑 **Chat Revival Disabled.**',
    });

  } else if (action === 'interval') {
    if (!hours) {
      return interaction.reply({
        content: '⚠️ Please specify the number of hours using the `hours` option.',
        flags: MessageFlags.Ephemeral
      });
    }

    config.intervalHours = hours;
    await saveConfig(guildId, config);

    return interaction.reply({
      content: `⏱️ **Interval Updated!**\n\nI will now check for chat revival every **${hours} hours**.`,
    });

  } else if (action === 'status') {
    const channelText = config.lastChannelId ? `<#${config.lastChannelId}>` : 'None (Talk to me to set one!)';
    const statusText = config.enabled ? '✅ Enabled' : '❌ Disabled';
    
    const embed = new EmbedBuilder()
      .setColor(0x00FFFF)
      .setTitle('✨ Realive Status')
      .addFields(
        { name: 'Status', value: statusText, inline: true },
        { name: 'Interval', value: `${config.intervalHours} hours`, inline: true },
        { name: 'Target Channel', value: channelText, inline: false },
        { name: 'Last Run', value: config.lastRun ? new Date(config.lastRun).toLocaleString() : 'Never', inline: false }
      );

    return interaction.reply({ embeds: [embed] });
  }
}

async function saveConfig(guildId, config) {
  state.realive[guildId] = config;
  await db.saveRealiveConfig(guildId, config);
  await saveStateToFile();
}

// ------------------------------------------------------------------
// Background Task
// ------------------------------------------------------------------

export function startRealiveLoop(client) {
  // Check every 10 minutes (600000 ms)
  // We don't need to check every second since intervals are in hours.
  const CHECK_INTERVAL = 10 * 60 * 1000; 

  setInterval(() => {
    checkAndRevive(client);
  }, CHECK_INTERVAL);
  
  console.log('Started Realive background task.');
}

async function checkAndRevive(client) {
  if (!state.realive) return;

  const now = Date.now();

  for (const [guildId, config] of Object.entries(state.realive)) {
    if (!config.enabled || !config.lastChannelId) continue;

    const intervalMs = config.intervalHours * 60 * 60 * 1000;
    const timeSinceLastRun = now - (config.lastRun || 0);

    // 1. Check if enough time passed since we last tried to revive
    if (timeSinceLastRun >= intervalMs) {
      try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        const channel = guild.channels.cache.get(config.lastChannelId);
        if (!channel) continue;

        // 2. "Make a dead chat alive" -> Implies checking if it's actually dead.
        // Let's fetch the last message in the channel.
        const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
        if (!messages) continue;
        
        const lastMsg = messages.first();
        
        // Logic: If the last message was sent LESS than (Interval / 2) ago, the chat is active.
        // Or simply, if the last message is recent, don't interrupt.
        // User request: "periodically send messages ... to make a dead chat alive"
        // Interpretation: If last message > X hours ago, send starter.
        // Let's use the interval as the threshold for "deadness" too, or a fraction of it.
        // Let's say if no messages for (intervalHours) hours, then we revive.
        
        let shouldRevive = true;

        if (lastMsg) {
          const timeSinceLastMsg = now - lastMsg.createdTimestamp;
          // If conversation happened recently (within the interval window), skip
          if (timeSinceLastMsg < intervalMs) {
            shouldRevive = false;
          }
        }

        // If user strictly meant "send periodically" regardless, we would skip the check.
        // But "revive dead chat" strongly implies conditional logic.
        // However, the prompt also says "periodic hours interval like 6h... send messages".
        // To be safe and helpful, we'll only send if the chat is actually quiet (e.g., quiet for at least 30% of the interval or fixed time).
        // Let's go with: If last message was > 1 hour ago (hardcoded reasonable silence) OR > interval? 
        // Let's stick to the Interval. If I set it to 6h, and last msg was 10 mins ago, I shouldn't post.
        // If last msg was 7 hours ago, I post.
        
        if (shouldRevive) {
          await sendRevivalMessage(channel);
          config.lastRun = now;
          await saveConfig(guildId, config);
        } else {
          // It's active, but we should update lastRun so we don't check every 10 mins and 
          // potentially spam immediately after it becomes quiet. 
          // No, we want to check again. If we update lastRun, we delay the next check by 6h.
          // That's actually correct. If active now, we wait another cycle.
          // Wait, if I check at 12:00 (active), set next check 18:00. At 13:00 chat dies. 
          // Revive happens at 18:00 (5h silence). This is acceptable behavior for "periodic".
          
          // Optimization: If chat is active, we can perhaps delay check slightly less? 
          // For simplicity/stability: Reset timer.
           config.lastRun = now;
           await saveConfig(guildId, config);
        }

      } catch (error) {
        console.error(`Error in Realive task for guild ${guildId}:`, error);
      }
    }
  }
}

async function sendRevivalMessage(channel) {
  try {
    // Reuse generation logic similar to starter command
    const request = {
      model: REVIVAL_MODEL,
      contents: [{
        role: 'user',
        parts: [{
          text: 'Generate one unique, engaging conversation starter question to revive a dead chat. Keep it fun and short.'
        }]
      }],
      systemInstruction: {
        parts: [{
          text: 'You are a friendly bot trying to revive a quiet discord server. Output ONE sentence only. No quotes.'
        }]
      },
      generationConfig: {
        temperature: 0.9
      }
    };
    
    const result = await genAI.models.generateContent(request);
    const starter = result.text || "It's quiet... too quiet. Who has a fun story from this week?";
    
    await channel.send(starter);

  } catch (error) {
    console.error('Error generating revival message:', error);
  }
      }
