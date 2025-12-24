import { EmbedBuilder, MessageFlags } from 'discord.js';
import { genAI, TEMP_DIR, checkSummaryRateLimit, incrementSummaryUsage } from '../botManager.js';
import { fetchMessagesForSummary } from '../modules/utils.js';
import { RATE_LIMIT_ERRORS } from '../modules/config.js';
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

/**
 * Execute AI generation with retry logic for rate limits and file rotation
 */
async function generateWithRetry(request, maxRetries = 3, reuploadCallback = null) {
  let attempts = 0;

  while (attempts < maxRetries) {
    try {
      const result = await genAI.models.generateContent(request);
      return { success: true, result };
    } catch (error) {
      attempts++;
      console.error(`Summary generation attempt ${attempts} failed:`, error.message);

      // Check for file permission error (caused by key rotation)
      const isFilePermissionError = 
        error.message?.includes('PERMISSION_DENIED') && 
        (error.message?.includes('File') || error.message?.includes('file'));

      if (isFilePermissionError && reuploadCallback && attempts < maxRetries) {
        console.log(`🔄 [FIX] Key rotation caused stale fileUri. Re-uploading file...`);
        
        try {
          // Re-upload file with new API key
          const newUri = await reuploadCallback();
          
          // Update request with new URI
          request.contents[0].parts = request.contents[0].parts.map(part => {
            if (part.fileData) {
              return { fileData: { fileUri: newUri, mimeType: part.fileData.mimeType } };
            }
            return part;
          });
          
          console.log(`✅ File re-uploaded successfully, retrying generation...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        } catch (reuploadError) {
          console.error('Failed to re-upload file:', reuploadError);
          return {
            success: false,
            error: 'File upload failed after key rotation'
          };
        }
      }

      const isRateLimitError = RATE_LIMIT_ERRORS.some(code => 
        error.message?.includes(code) || 
        error.status === code || 
        error.code?.includes(code)
      );

      if (isRateLimitError && attempts < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempts), 8000);
        console.log(`Rate limit hit, waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (attempts >= maxRetries) {
        return {
          success: false,
          error: error.message || 'Unknown error'
        };
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return {
    success: false,
    error: 'Failed after maximum retries'
  };
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
        const request = {
          model: SUMMARY_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                { text: "Please provide a comprehensive, structured summary of this YouTube video. Highlight key points, main takeaways, and any important details. Use bullet points for readability. Make sure the summary is short and concise." },
                { fileData: { fileUri: inputLink, mimeType: 'video/mp4' } }
              ]
            }
          ]
        };

        // Note: YouTube URLs are external and don't need re-uploading after key rotation
        const response = await generateWithRetry(request);

        if (!response.success) {
          throw new Error(response.error || "Failed to generate video summary");
        }

        const summaryText = response.result.candidates?.[0]?.content?.parts?.[0]?.text;

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
        
        // Note: We intentionally DO NOT update chat history here to prevent 
        // the summary from bloating future context.
        
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

    // Upload to Gemini with retry
    let uploadResult;
    let uploadAttempts = 0;
    const maxUploadRetries = 3;

    while (uploadAttempts < maxUploadRetries) {
      try {
        uploadResult = await genAI.files.upload({
          file: filePath,
          config: {
            mimeType: 'text/plain',
            displayName: 'Discord Conversation Context'
          }
        });
        break;
      } catch (uploadError) {
        uploadAttempts++;
        console.error(`Upload attempt ${uploadAttempts} failed:`, uploadError.message);

        const isRateLimitError = RATE_LIMIT_ERRORS.some(code => 
          uploadError.message?.includes(code) || 
          uploadError.status === code || 
          uploadError.code?.includes(code)
        );

        if (isRateLimitError && uploadAttempts < maxUploadRetries) {
          const delay = Math.min(1000 * Math.pow(2, uploadAttempts), 8000);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        if (uploadAttempts >= maxUploadRetries) {
          await fs.unlink(filePath).catch(() => {});
          const errorEmbed = new EmbedBuilder()
            .setColor(0xFF5555)
            .setTitle('❌ Upload Failed')
            .setDescription('Failed to upload conversation data after multiple attempts.');
          return interaction.editReply({ embeds: [errorEmbed] });
        }
      }
    }

    const name = uploadResult.name;
    let file = await genAI.files.get({ name });
    let attempts = 0;
    while (file.state === 'PROCESSING' && attempts < 10) {
      await new Promise(r => setTimeout(r, 2000));
      file = await genAI.files.get({ name });
      attempts++;
    }

    if (file.state === 'FAILED') {
      await fs.unlink(filePath).catch(() => {});
      const errorEmbed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ File Processing Failed')
        .setDescription('The uploaded file failed to process.');
      return interaction.editReply({ embeds: [errorEmbed] });
    }

    // Prepare reupload callback in case of key rotation during generation
    const reuploadCallback = async () => {
      console.log('🔄 Re-uploading Discord conversation file after key rotation...');
      
      // Re-upload the file with the new API key
      const newUploadResult = await genAI.files.upload({
        file: filePath,
        config: {
          mimeType: 'text/plain',
          displayName: 'Discord Conversation Context'
        }
      });

      // Wait for processing
      const newName = newUploadResult.name;
      let newFile = await genAI.files.get({ name: newName });
      let waitAttempts = 0;
      while (newFile.state === 'PROCESSING' && waitAttempts < 10) {
        await new Promise(r => setTimeout(r, 2000));
        newFile = await genAI.files.get({ name: newName });
        waitAttempts++;
      }

      if (newFile.state === 'FAILED') {
        throw new Error('Re-uploaded file failed to process');
      }

      return newUploadResult.uri;
    };

    const request = {
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
    };

    // Pass reupload callback to handle key rotation
    const aiResponse = await generateWithRetry(request, 3, reuploadCallback);

    await fs.unlink(filePath).catch(() => {});

    if (!aiResponse.success) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Summary Generation Failed')
        .setDescription(`Failed to generate summary: ${aiResponse.error}`);
      return interaction.editReply({ embeds: [errorEmbed] });
    }

    const aiSummary = aiResponse.result.candidates?.[0]?.content?.parts?.[0]?.text || "I was unable to generate a summary.";

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

    incrementSummaryUsage(interaction.user.id);
    
    // Note: We intentionally DO NOT update chat history here.
    
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
