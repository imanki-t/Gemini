import { EmbedBuilder, MessageFlags } from 'discord.js';
import { genAI, TEMP_DIR, checkSummaryRateLimit, incrementSummaryUsage } from '../botManager.js';
import { fetchMessagesForSummary } from '../modules/utils.js';
import path from 'path';
import fs from 'fs/promises';

const SUMMARY_MODEL = 'gemini-2.5-flash'; // Optimized for video/text reasoning

export const summaryCommand = {
  name: 'summary',
  description: 'Summarize a Discord conversation OR a YouTube video'
};

/**
 * Validates if a string is a valid YouTube URL
 */
function isYouTubeUrl(url) {
  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
  return ytRegex.test(url);
}

export async function handleSummaryCommand(interaction) {
  try {
    // 1. Check Rate Limit
    const limitCheck = checkSummaryRateLimit(interaction.user.id);
    if (!limitCheck.allowed) {
      return interaction.reply({
        content: limitCheck.message,
        flags: MessageFlags.Ephemeral
      });
    }

    const inputLink = interaction.options.getString('link');
    const count = interaction.options.getInteger('count') || 50;

    await interaction.deferReply();

    // ---------------------------------------------------------
    // Scenario A: YouTube Video Summarization
    // ---------------------------------------------------------
    if (isYouTubeUrl(inputLink)) {
      try {
        const result = await genAI.models.generateContent({
          model: SUMMARY_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                { text: "Please provide a comprehensive, structured summary of this YouTube video. Highlight key points, main takeaways, and any important details. Use bullet points for readability. Make sure the summary is short and concise." },
                { fileData: { fileUri: inputLink, mimeType: 'video/mp4' } } // Gemini treats YT links as video files via URI
              ]
            }
          ]
        });

        const summaryText = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!summaryText) {
          throw new Error("Gemini returned an empty response for the video.");
        }

        const embed = new EmbedBuilder()
          .setColor(0xFF0000) // YouTube Red
          .setTitle('📺 Video Summary')
          .setURL(inputLink)
          .setDescription(summaryText.slice(0, 4000))
          .setFooter({ text: `Summarized by Lumin • Gemini 3.0` })
          .setTimestamp();

        incrementSummaryUsage(interaction.user.id);
        return interaction.editReply({ embeds: [embed] });

      } catch (videoError) {
        console.error('YouTube summary failed:', videoError);
        const errorEmbed = new EmbedBuilder()
          .setColor(0xFF5555)
          .setTitle('❌ Video Summary Failed')
          .setDescription(`I couldn't summarize that video. Ensure the video has subtitles/transcripts available and isn't private or age-restricted.\n\n*Error: ${videoError.message}*`);
        return interaction.editReply({ embeds: [errorEmbed] });
      }
    }

    // ---------------------------------------------------------
    // Scenario B: Discord Conversation Summarization
    // ---------------------------------------------------------
    const result = await fetchMessagesForSummary(interaction, inputLink, count);

    if (result.error) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Discord Summary Failed')
        .setDescription(result.error);
      return interaction.editReply({ embeds: [errorEmbed] });
    }

    if (!result.success || !result.content) {
      return interaction.editReply({ content: 'Failed to fetch messages for summary.' });
    }

    // Prepare content for AI
    const fileName = `summary_${interaction.id}_${Date.now()}.txt`;
    const filePath = path.join(TEMP_DIR, fileName);
    const fileContent = `Discord Messages Summary Context\nChannel: #${result.channelName}\nServer: ${result.guildName}\nMessages Fetched: ${result.messageCount}\n\n${result.content}`;

    await fs.writeFile(filePath, fileContent);

    // Upload to Gemini
    const uploadResult = await genAI.files.upload({
      file: filePath,
      config: {
        mimeType: 'text/plain',
        displayName: 'Discord Conversation Context'
      }
    });

    const name = uploadResult.name;
    let file = await genAI.files.get({ name });
    let attempts = 0;
    while (file.state === 'PROCESSING' && attempts < 10) {
      await new Promise(r => setTimeout(r, 2000));
      file = await genAI.files.get({ name });
      attempts++;
    }

    const response = await genAI.models.generateContent({
      model: SUMMARY_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { text: "Analyze and summarize the Discord conversation in the attached file. Identify the main topics discussed, any decisions made, and the overall mood of the chat. Be concise and use bullet points. Make the summary short and concise." },
            { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } }
          ]
        }
      ]
    });

    const aiSummary = response.candidates?.[0]?.content?.parts?.[0]?.text || "I was unable to generate a summary.";

    const embed = new EmbedBuilder()
      .setColor(0x5865F2) // Discord Blurple
      .setTitle('📝 Conversation Summary')
      .setDescription(aiSummary.slice(0, 4000))
      .addFields(
        { name: '📍 Context', value: `#${result.channelName} (${result.guildName})`, inline: true },
        { name: '💬 Messages', value: result.messageCount.toString(), inline: true }
      )
      .setFooter({ text: 'Summarized by Lumin' })
      .setTimestamp();

    await fs.unlink(filePath).catch(() => {});
    incrementSummaryUsage(interaction.user.id);
    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('Error in summary command:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ An error occurred while processing the summary.', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.editReply({ content: '❌ An unexpected error occurred. Please try again later.' });
    }
  }
}
