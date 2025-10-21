// index.js
import {
 MessageFlags,
 ActionRowBuilder,
 ButtonBuilder,
 ButtonStyle,
 ChannelType,
 TextInputBuilder,
 TextInputStyle,
 ModalBuilder,
 PermissionsBitField,
 EmbedBuilder,
 AttachmentBuilder,
 ActivityType,
 ComponentType,
 REST,
 Routes,
 StringSelectMenuBuilder,
 StringSelectMenuOptionBuilder,
} from 'discord.js';
import {
 HarmBlockThreshold,
 HarmCategory
} from '@google/genai';
import fs from 'fs/promises';
import {
 createWriteStream
} from 'fs';
import path from 'path';
import {
 getTextExtractor
} from 'office-text-extractor'
import osu from 'node-os-utils';
const {
 mem,
 cpu
} = osu;
import axios from 'axios';
import express from 'express';

import config from './config.js';
import {
 client,
 genAI,
 createPartFromUri,
 token,
 activeRequests,
 chatHistoryLock,
 state,
 TEMP_DIR,
 initialize,
 saveStateToFile,
 getHistory,
 updateChatHistory,
 getUserResponsePreference,
 getUserModelPreference,
 getUserContinuousReply,
 getUserActionButtons,
 getUserEmbedColor,
 initializeBlacklistForGuild
} from './botManager.js';

initialize().catch(console.error);

// <=====[Configuration]=====>

// Available text generation models (excluding 2.5 pro)
const TEXT_MODELS = [
 "gemini-2.5-flash-lite",
 "gemini-2.5-flash",
 "gemini-2.0-flash",
];

// Image generation model (as per user request)
const IMAGE_MODEL = "gemini-2.5-flash-image";

// Activities Configuration
const activities = config.activities.map(activity => ({
 name: activity.name,
 type: ActivityType[activity.type]
}));

/*
`BLOCK_NONE`  -  Always show regardless of probability of unsafe content
`BLOCK_ONLY_HIGH`  -  Block when high probability of unsafe content
`BLOCK_MEDIUM_AND_ABOVE`  -  Block when medium or high probability of unsafe content
`BLOCK_LOW_AND_ABOVE`  -  Block when low, medium or high probability of unsafe content
`HARM_BLOCK_THRESHOLD_UNSPECIFIED`  -  Threshold is unspecified, block using default threshold
*/
const safetySettings = [{
   category: HarmCategory.HARM_CATEGORY_HARASSMENT,
   threshold: HarmBlockThreshold.BLOCK_NONE,
 },
 {
   category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
   threshold: HarmBlockThreshold.BLOCK_NONE,
 },
 {
   category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
   threshold: HarmBlockThreshold.BLOCK_NONE,
 },
 {
   category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
   threshold: HarmBlockThreshold.BLOCK_NONE,
 },
];

const generationConfig = {
 temperature: 1.0,
 topP: 0.95,
 // maxOutputTokens: 1000,
 thinkingConfig: {
   thinkingBudget: -1
 }
};

const defaultPersonality = config.defaultPersonality;
const workInDMs = config.workInDMs;
const SEND_RETRY_ERRORS_TO_DISCORD = config.SEND_RETRY_ERRORS_TO_DISCORD;


import {
 delay,
 retryOperation,
} from './others.js';

// <=====[Express Server]=====>
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
 res.send('Gemini Discord Bot is Running!');
});

app.listen(port, () => {
 console.log(`Express server running on port ${port}`);
});
// <==========>


// <=====[Register Commands And Activities]=====>

import {
 commands
} from './commands.js';

let activityIndex = 0;
client.once('ready', async () => {
 console.log(`Logged in as ${client.user.tag}!`);

 const rest = new REST().setToken(token);
 try {
   console.log('Started refreshing application (/) commands.');

   // Only update commands if the environment has permissions, otherwise skip
   await retryOperation(() => rest.put(
     Routes.applicationCommands(client.user.id), {
       body: commands
     },
   ), 3);

   console.log('Successfully reloaded application (/) commands.');
 } catch (error) {
   console.error('Error reloading commands:', error);
 }

 client.user.setPresence({
   activities: [activities[activityIndex]],
   status: 'idle',
 });

 setInterval(() => {
   activityIndex = (activityIndex + 1) % activities.length;
   client.user.setPresence({
     activities: [activities[activityIndex]],
     status: 'idle',
   });
 }, 30000);
});

// <==========>


// <=====[Messages And Interaction]=====>

client.on('messageUpdate', async (oldMessage, newMessage) => {
 // Prevent loop, check if content changed, ignore bot messages
 if (newMessage.author.bot || oldMessage.content === newMessage.content) return;

 const originalMessage = oldMessage;
 const editedMessage = newMessage;
 const userId = originalMessage.author.id;
 const historyId = userId; // User-based memory is always by userId

 // Check if message is older than 10 minutes (10 * 60 * 1000 ms)
 if (Date.now() - originalMessage.createdTimestamp > 600000) {
   return;
 }

 // Check if the user is currently in the middle of a generation process
 if (activeRequests.has(userId)) {
     console.log(`User ${userId} edited message but generation is already active. Skipping.`);
     return;
 }
 
 try {
   // Check if the bot has a reply for this specific message ID in the user's history
   const userHistory = state.chatHistories[historyId];
   if (userHistory && userHistory[originalMessage.id]) {
     // Find the bot's reply ID, which was saved with the assistant's content
     const botReplyId = userHistory[originalMessage.id].find(entry => entry.role === 'assistant')?.replyId;
     
     if (botReplyId) {
       // Attempt to fetch the bot's reply
       const botMessage = await originalMessage.channel.messages.fetch(botReplyId).catch(() => null);
       
       if (botMessage && botMessage.author.id === client.user.id) {
           
           // Delete the old chat history entry associated with this message ID
           // This prevents the old, incorrect response from being used in future context
           delete state.chatHistories[historyId][originalMessage.id];

           // Rerun the generation with the new message content
           activeRequests.add(userId);
           
           // Delete the original bot message to prevent confusion, then re-trigger
           await botMessage.delete().catch(console.error);

           // Create a mock message for handleTextMessage with the updated content
           const updatedMessage = {
               ...originalMessage,
               content: editedMessage.content,
               attachments: editedMessage.attachments,
               // Ensure other necessary properties are carried over
           };

           // Rerun the generation with the edited message content
           await handleTextMessage(updatedMessage);
       }
     }
   }
 } catch (error) {
   console.error('Error handling message update:', error);
   if (activeRequests.has(userId)) {
     activeRequests.delete(userId);
   }
 }
});

client.on('messageCreate', async (message) => {
 try {
   if (message.author.bot) return;
   if (message.content.startsWith('!')) return;

   const isDM = message.channel.type === ChannelType.DM;
   const botMention = new RegExp(`<@!?${client.user.id}>`);

   const shouldRespond = (
     workInDMs && isDM ||
     state.alwaysRespondChannels[message.channelId] ||
     (message.mentions.users.has(client.user.id) && !isDM) ||
     state.activeUsersInChannels[message.channelId]?.[message.author.id]
   );

   if (shouldRespond) {
     if (message.guild) {
       initializeBlacklistForGuild(message.guild.id);
       if (state.blacklistedUsers[message.guild.id]?.includes(message.author.id)) {
         const embed = new EmbedBuilder()
           .setColor(0xFF0000)
           .setTitle('Blacklisted')
           .setDescription('You are blacklisted and cannot use this bot.');
         return message.reply({ embeds: [embed] });
       }
     }
     
     const effectiveSettings = getEffectiveSettings(message.guild?.id, message.author.id);
     const shouldMention = !effectiveSettings.continuousReply;
     
     // Check for active request
     if (activeRequests.has(message.author.id)) {
       const embed = new EmbedBuilder()
         .setColor(0xFFFF00)
         .setTitle('Request In Progress')
         .setDescription('Please wait until your previous action is complete.');
       
       // Only reply if continuous reply is OFF (i.e., we are mentioning user for every response)
       if (!shouldMention) {
         // If continuous reply is ON, we don't want to spam with "wait" messages
         console.log(`User ${message.author.id} is active, suppressing 'wait' reply.`);
       } else {
           await message.reply({ embeds: [embed] });
       }
     } else {
       activeRequests.add(message.author.id);
       await handleTextMessage(message);
     }
   }
 } catch (error) {
   console.error('Error processing the message:', error);
   if (activeRequests.has(message.author.id)) {
     activeRequests.delete(message.author.id);
   }
 }
});

client.on('interactionCreate', async (interaction) => {
 try {
   if (interaction.isChatInputCommand()) {
     await handleCommandInteraction(interaction);
   } else if (interaction.isButton()) {
     await handleButtonInteraction(interaction);
   } else if (interaction.isModalSubmit()) {
     await handleModalSubmit(interaction);
   } else if (interaction.isStringSelectMenu()) {
     await handleSelectMenuInteraction(interaction);
   }
 } catch (error) {
   console.error('Error handling interaction:', error.message);
   if (interaction.deferred || interaction.replied) {
     // Basic recovery for interactions
     await interaction.editReply({ content: 'An unexpected error occurred during interaction handling.', embeds: [], components: [] }).catch(console.error);
   } else {
     await interaction.reply({ content: 'An unexpected error occurred during interaction handling.', ephemeral: true }).catch(console.error);
   }
 }
});

async function handleCommandInteraction(interaction) {
 if (!interaction.isChatInputCommand()) return;

 const commandHandlers = {
   settings: showMainSettings,
   imagine: handleImagineCommand,
   search: handleSearchCommand,
   respond_to_all: handleRespondToAllCommand,
   toggle_channel_chat_history: toggleChannelChatHistory,
 };

 const handler = commandHandlers[interaction.commandName];
 if (handler) {
   // Enhanced error handling wrapper for commands
   try {
     await handler(interaction);
   } catch (error) {
     console.error(`Error in /${interaction.commandName} command:`, error);
     const errorMessage = 'An internal error occurred while processing this command.';
     if (interaction.deferred || interaction.replied) {
       await interaction.editReply({ content: errorMessage, ephemeral: true }).catch(console.error);
     } else {
       await interaction.reply({ content: errorMessage, ephemeral: true }).catch(console.error);
     }
   }
 } else {
   console.log(`Unknown command: ${interaction.commandName}`);
 }
}

async function handleButtonInteraction(interaction) {
 if (!interaction.isButton()) return;

 if (interaction.guild && state.blacklistedUsers[interaction.guild.id]?.includes(interaction.user.id)) {
   const embed = new EmbedBuilder()
     .setColor(0xFF0000)
     .setTitle('Blacklisted')
     .setDescription('You are blacklisted and cannot use this interaction.');
   return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 }

 const customId = interaction.customId;

 // Delegate based on prefix
 if (customId === 'user_settings') return showUserSettings(interaction);
 if (customId === 'server_settings') return showServerSettings(interaction);
 if (customId.startsWith('back_to_main_settings')) return showMainSettings(interaction, true);
 if (customId === 'back_to_user_settings') return showUserSettings(interaction, true);
 if (customId === 'back_to_server_settings') return showServerSettings(interaction, true);

 if (customId.startsWith('delete_message-')) {
   const msgId = customId.replace('delete_message-', '');
   return handleDeleteMessageInteraction(interaction, msgId);
 }
 
 if (customId === 'stopGenerating') {
   // This button is handled in handleModelResponse, but we need to prevent the interaction from timing out
   // The collector manages the stop flag; this just provides feedback.
   return interaction.reply({ content: 'Stopping generation...', flags: MessageFlags.Ephemeral });
 }


 const buttonHandlers = {
   // User Settings
   'clear-memory': clearChatHistory,
   'custom-personality': setCustomPersonality,
   'remove-personality': removeCustomPersonality,
   'toggle-continuous-reply-user': toggleUserContinuousReply,
   'toggle-action-buttons-user': toggleUserActionButtons,
   'toggle-response-mode-user': toggleUserResponsePreference,
   'custom-embed-color-user': handleCustomEmbedColorModal,
   'download-conversation': downloadConversation,

   // Server Settings
   'toggle-override-user-settings': toggleOverrideUserSettings,
   'server-chat-history': toggleServerWideChatHistory,
   'clear-server-memory': clearServerChatHistory,
   'toggle-continuous-reply-server': toggleServerContinuousReply,
   'toggle-action-buttons-server': toggleServerActionButtons,
   'toggle-response-mode-server': toggleServerResponsePreference,
   'custom-server-personality': serverPersonality,
   'remove-server-personality': removeServerPersonality,
   'custom-embed-color-server': handleCustomServerEmbedColorModal,
   'download-server-conversation': downloadServerConversation,
   
   // Action Button
   'download_message': downloadMessage,
 };

 const handler = buttonHandlers[customId];
 if (handler) {
   if (customId.endsWith('-server') || customId.includes('server-')) {
     if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
       return interaction.reply({
         embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('Permission Denied').setDescription('You need the `Manage Server` permission to change server settings.')],
         flags: MessageFlags.Ephemeral
       });
     }
   }
   await handler(interaction);
 }
}

async function handleDeleteMessageInteraction(interaction, msgId) {
 const userId = interaction.user.id;
 const historyId = userId; // Always check user history for deletion context
 const userChatHistory = state.chatHistories[historyId];
 const channel = interaction.channel;
 
 if (!userChatHistory) {
     return interaction.reply({ content: 'No active history found to manage deletion.', flags: MessageFlags.Ephemeral });
 }

 // Find the history entry linked to the original user message ID
 let originalMessageEntry = Object.values(userChatHistory).find(entries => entries[0]?.replyId === msgId);
 let originalMessageId;
 
 if (originalMessageEntry) {
     originalMessageId = originalMessageEntry[0]?.messageId;
     // Delete the history entry by its key (which is the original user message ID)
     if (originalMessageId) {
         delete userChatHistory[originalMessageId];
         await saveStateToFile();
         await deleteMsg();
         return;
     }
 }

 // Fallback: If not found in primary history structure, check if the user is the one the bot replied to
 try {
     const messageToDelete = channel ? (await channel.messages.fetch(msgId).catch(() => false)) : false;
     if (messageToDelete) {
         const replyingToId = messageToDelete.reference?.messageId;
         const originalMessage = replyingToId ? (await channel.messages.fetch(replyingToId).catch(() => false)) : false;
         
         if (originalMessage && originalMessage.author.id === userId) {
             await deleteMsg();
             return;
         }
     }
     
     const embed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Not For You')
       .setDescription('This button is not meant for you.');
     return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

 } catch (error) {
     console.error('Error during complex delete check:', error);
     const embed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Deletion Error')
       .setDescription('Could not verify ownership for deletion.');
     return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 }


 async function deleteMsg() {
   await interaction.message.delete().catch(console.error); // Delete the interaction message (bot's reply)
   
   // Attempt to delete the original user message too, but ignore if it fails (e.g., user deleted it already)
   if (channel && originalMessageId) {
       try {
           const userMsg = await channel.messages.fetch(originalMessageId);
           await userMsg.delete().catch(console.error);
       } catch (error) {
           // Ignore if user message is not found/already deleted
       }
   }

   await interaction.reply({ content: 'Messages deleted.', ephemeral: true });
 }
}

async function handleSelectMenuInteraction(interaction) {
 if (!interaction.isStringSelectMenu()) return;

 const customId = interaction.customId;
 const selectedModel = interaction.values[0];

 if (customId === 'model_select_user') {
   state.userModelPreference[interaction.user.id] = selectedModel;
   await saveStateToFile();
   await showUserSettings(interaction, true);
 } else if (customId === 'model_select_server') {
   if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
     return interaction.reply({
       embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('Permission Denied').setDescription('You need the `Manage Server` permission to change server settings.')],
       flags: MessageFlags.Ephemeral
     });
   }
   state.serverSettings[interaction.guild.id].model = selectedModel;
   await saveStateToFile();
   await showServerSettings(interaction, true);
 }
}

async function handleModalSubmit(interaction) {
 const customId = interaction.customId;

 if (customId === 'custom-personality-modal') {
   try {
     const customInstructionsInput = interaction.fields.getTextInputValue('custom-personality-input');
     state.customInstructions[interaction.user.id] = customInstructionsInput.trim();
     await saveStateToFile();

     const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('Success').setDescription('Custom User Personality Saved!');
     await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
   } catch (error) {
     console.log(error.message);
   }
 } else if (customId === 'custom-server-personality-modal') {
   try {
     const customInstructionsInput = interaction.fields.getTextInputValue('custom-server-personality-input');
     state.customInstructions[interaction.guild.id] = customInstructionsInput.trim();
     await saveStateToFile();

     const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('Success').setDescription('Custom Server Personality Saved!');
     await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
   } catch (error) {
     console.log(error.message);
   }
 } else if (customId === 'custom-embed-color-modal-user') {
   const hexInput = interaction.fields.getTextInputValue('hex-color-input');
   await handleColorChange(interaction, hexInput, 'user');
 } else if (customId === 'custom-embed-color-modal-server') {
   const hexInput = interaction.fields.getTextInputValue('hex-color-input');
   await handleColorChange(interaction, hexInput, 'server');
 }
}

async function handleColorChange(interaction, hexInput, type) {
 const hexCode = hexInput.startsWith('#') ? hexInput : `#${hexInput}`;
 const hexRegex = /^#([0-9A-F]{3}){1,2}$/i;

 if (!hexRegex.test(hexCode)) {
   const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('Error').setDescription('Invalid HEX code. Please use a valid format (e.g., `#FF00FF` or `FF00FF`).');
   return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 }

 try {
   if (type === 'user') {
     state.userEmbedColor[interaction.user.id] = hexCode;
     await saveStateToFile();
     await showUserSettings(interaction, true);
   } else if (type === 'server') {
     if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
       return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('Permission Denied').setDescription('You need the `Manage Server` permission to change server settings.')], flags: MessageFlags.Ephemeral });
     }
     state.serverSettings[interaction.guild.id].embedColor = hexCode;
     await saveStateToFile();
     await showServerSettings(interaction, true);
   }

   const embed = new EmbedBuilder().setColor(hexCode).setTitle('Success').setDescription(`${type === 'user' ? 'User' : 'Server'} Embed Color set to **${hexCode}**.`);
   // Edit the previous settings message instead of replying if possible
   await interaction.updateMessage({ embeds: [embed], components: interaction.message.components }); 
 } catch (error) {
   console.error(`Error setting embed color for ${type}:`, error.message);
   const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('Error').setDescription('An error occurred while saving the color.');
   await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 }
}

// <==========>


// <=====[New Command Handlers]=====>

async function handleImagineCommand(interaction) {
 const prompt = interaction.options.getString('prompt');
 
 if (prompt.toLowerCase().includes('nano banana')) {
   return interaction.reply({ content: 'I cannot generate images for the term "nano banana". Please use a different prompt.', ephemeral: true });
 }

 await interaction.deferReply();

 try {
   const response = await retryOperation(async () => {
     return genAI.models.generateContent({
       model: IMAGE_MODEL,
       contents: [{ text: prompt }],
       config: {
         generationConfig: {
           responseModalities: ["IMAGE"],
         },
         safetySettings,
       }
     });
   }, 3);

   const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType.startsWith('image/'));

   if (imagePart) {
     const base64Data = imagePart.inlineData.data;
     const buffer = Buffer.from(base64Data, 'base64');
     
     const attachment = new AttachmentBuilder(buffer, {
       name: 'gemini-image.png'
     });
     
     const responseColor = getUserEmbedColor(interaction.user.id);


     const embed = new EmbedBuilder()
       .setColor(responseColor)
       .setTitle('Image Generation Complete')
       .setDescription(`**Prompt:** ${prompt}`)
       .setImage('attachment://gemini-image.png')
       .setFooter({ text: `Generated by ${IMAGE_MODEL}` })
       .setTimestamp();

     await interaction.editReply({
       embeds: [embed],
       files: [attachment]
     });
   } else {
     await interaction.editReply({
       content: `Sorry, I couldn't generate an image for that prompt. The model returned no image part.`,
       ephemeral: true
     });
   }
 } catch (error) {
   console.error('Image Generation Error:', error);
   await interaction.editReply({
     content: `An error occurred during image generation. Please try again later. Error: \`${error.message}\``,
     ephemeral: true
   });
 }
}

async function handleSearchCommand(interaction) {
 const prompt = interaction.options.getString('prompt');
 const attachment = interaction.options.getAttachment('attachment');
 const userId = interaction.user.id;
 
 if (!prompt && !attachment) {
   return interaction.reply({ content: 'Please provide a text prompt or an attachment to search with.', ephemeral: true });
 }

 await interaction.deferReply();

 let parts = [];
 let messageContent = prompt || 'What is this?';
 
 try {
     if (attachment) {
         // Temporarily create a mock message object for existing multimodal processing
         const mockMessage = {
             attachments: new Map([[attachment.id, attachment]]),
             author: interaction.user,
             id: interaction.id, // Use interaction ID as a unique message ID for file download
         };
         // The function processes and uploads the file to get parts
         parts = await processPromptAndMediaAttachments(messageContent, mockMessage);
     } else {
         parts.push({ text: messageContent });
     }

     // Force search tool for this command
     const tools = [{ googleSearch: {} }];
     
     const chat = genAI.chats.create({
         model: getUserModelPreference(userId),
         config: {
             ...generationConfig,
             safetySettings,
             tools,
         },
         history: [], // No history for a fresh search command
     });

     const responseStream = await chat.sendMessageStream({ message: parts });

     let finalResponse = '';
     let groundingMetadata = null;
     let urlContextMetadata = null;
     
     for await (const chunk of responseStream) {
         const chunkText = chunk.text || '';
         finalResponse += chunkText;

         if (chunk.candidates && chunk.candidates[0]?.groundingMetadata) {
             groundingMetadata = chunk.candidates[0].groundingMetadata;
         }

         if (chunk.candidates && chunk.candidates[0]?.url_context_metadata) {
             urlContextMetadata = chunk.candidates[0].url_context_metadata;
         }
     }
     
     const responseColor = getUserEmbedColor(userId);

     const embed = new EmbedBuilder()
         .setColor(responseColor)
         .setTitle(`🔍 Search Result for: ${messageContent.substring(0, 100)}...`)
         .setDescription(finalResponse.substring(0, 3900));

     if (groundingMetadata) {
         addGroundingMetadataToEmbed(embed, groundingMetadata);
     }
     if (urlContextMetadata) {
         addUrlContextMetadataToEmbed(embed, urlContextMetadata);
     }
     
     await interaction.editReply({ embeds: [embed] });

 } catch (error) {
     console.error('Multimodal Search Error:', error);
     await interaction.editReply({
         content: `An error occurred during the search. Error: \`${error.message}\``,
         ephemeral: true
     });
 }
}

// <==========>


// <=====[Discord Channel/Server Command Handlers]=====>

async function handleRespondToAllCommand(interaction) {
 try {
   if (interaction.channel.type === ChannelType.DM) {
     const dmEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Command Not Available')
       .setDescription('This command cannot be used in DMs.');
     return interaction.reply({ embeds: [dmEmbed], flags: MessageFlags.Ephemeral });
   }

   if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
     const adminEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Admin Required')
       .setDescription('You need to be an admin to use this command.');
     return interaction.reply({ embeds: [adminEmbed], flags: MessageFlags.Ephemeral });
   }

   const channelId = interaction.channelId;
   const enabled = interaction.options.getBoolean('enabled');

   if (enabled) {
     state.alwaysRespondChannels[channelId] = true;
     const startRespondEmbed = new EmbedBuilder()
       .setColor(0x00FF00)
       .setTitle('Bot Response Enabled')
       .setDescription('The bot will now respond to all messages in this channel.');
     await interaction.reply({ embeds: [startRespondEmbed], ephemeral: false });
   } else {
     delete state.alwaysRespondChannels[channelId];
     const stopRespondEmbed = new EmbedBuilder()
       .setColor(0xFFA500)
       .setTitle('Bot Response Disabled')
       .setDescription('The bot will now stop responding to all messages in this channel.');
     await interaction.reply({ embeds: [stopRespondEmbed], ephemeral: false });
   }
   await saveStateToFile();
 } catch (error) {
   console.error('Error in handleRespondToAllCommand:', error);
 }
}

async function toggleChannelChatHistory(interaction) {
 try {
   if (interaction.channel.type === ChannelType.DM) {
     const dmEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Command Not Available')
       .setDescription('This command cannot be used in DMs.');
     return interaction.reply({ embeds: [dmEmbed], flags: MessageFlags.Ephemeral });
   }

   if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
     const adminEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Admin Required')
       .setDescription('You need to be an admin to use this command.');
     return interaction.reply({ embeds: [adminEmbed], flags: MessageFlags.Ephemeral });
   }

   const channelId = interaction.channelId;
   const enabled = interaction.options.getBoolean('enabled');
   const instructions = interaction.options.getString('instructions') || defaultPersonality;

   if (enabled) {
     state.channelWideChatHistory[channelId] = true;
     state.customInstructions[channelId] = instructions;

     const enabledEmbed = new EmbedBuilder()
       .setColor(0x00FF00)
       .setTitle('Channel History Enabled')
       .setDescription(`Channel-wide chat history has been enabled.`);
     await interaction.reply({ embeds: [enabledEmbed], ephemeral: false });
   } else {
     delete state.channelWideChatHistory[channelId];
     delete state.customInstructions[channelId];
     delete state.chatHistories[channelId];

     const disabledEmbed = new EmbedBuilder()
       .setColor(0xFFA500)
       .setTitle('Channel History Disabled')
       .setDescription('Channel-wide chat history has been disabled.');
     await interaction.reply({ embeds: [disabledEmbed], ephemeral: false });
   }
   await saveStateToFile();
 } catch (error) {
   console.error('Error in toggleChannelChatHistory:', error);
 }
}

// <==========>


// <=====[Settings UI Handlers]=====>

async function showMainSettings(interaction, update = false) {
 const isServer = interaction.guild !== null;
 const embed = new EmbedBuilder()
   .setColor(config.hexColour)
   .setTitle('✨ Gemini Bot Settings')
   .setDescription('Welcome to the bot configuration menu. Please select whether you want to manage your **personal settings** or the **server settings** (Admin required).');

 const buttons = [
   new ButtonBuilder()
     .setCustomId('user_settings')
     .setLabel('👤 User Settings')
     .setStyle(ButtonStyle.Primary),
   isServer ? new ButtonBuilder()
     .setCustomId('server_settings')
     .setLabel('🏠 Server Settings')
     .setStyle(ButtonStyle.Secondary)
     .setDisabled(!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) : null,
 ].filter(b => b);

 const actionRow = new ActionRowBuilder().addComponents(...buttons);

 const replyOptions = {
   embeds: [embed],
   components: [actionRow],
   flags: MessageFlags.Ephemeral
 };

 if (update) {
   await interaction.update(replyOptions);
 } else {
   await interaction.reply(replyOptions);
 }
}

function createModelSelectMenu(isServer, currentModel) {
 const options = TEXT_MODELS.map(model =>
   new StringSelectMenuOptionBuilder()
   .setLabel(model)
   .setValue(model)
   .setDefault(model === currentModel)
 );

 return new StringSelectMenuBuilder()
   .setCustomId(isServer ? 'model_select_server' : 'model_select_user')
   .setPlaceholder('Choose a language model...')
   .addOptions(options);
}

function formatStatus(value) {
 return value ? '✅ ON' : '❌ OFF';
}

function getEffectiveSettings(guildId, userId) {
 const serverSettings = state.serverSettings[guildId] || config.defaultServerSettings;
 const userSettings = {};

 if (guildId && serverSettings.overrideUserSettings) {
   // Server overrides everything
   userSettings.model = serverSettings.model;
   userSettings.continuousReply = serverSettings.continuousReply;
   userSettings.actionButtons = serverSettings.actionButtons;
   userSettings.responseStyle = serverSettings.responseStyle;
   userSettings.embedColor = serverSettings.embedColor;
   userSettings.customInstructions = state.customInstructions[guildId] || config.defaultPersonality;
   userSettings.isOverridden = true;
 } else {
   // User preferences apply
   userSettings.model = getUserModelPreference(userId);
   userSettings.continuousReply = getUserContinuousReply(userId);
   userSettings.actionButtons = getUserActionButtons(userId);
   userSettings.responseStyle = getUserResponsePreference(userId);
   userSettings.embedColor = getUserEmbedColor(userId);
   userSettings.customInstructions = state.customInstructions[userId] || config.defaultPersonality;
   userSettings.isOverridden = false;
 }
 return userSettings;
}

async function showUserSettings(interaction, update = false) {
 const userId = interaction.user.id;
 const guildId = interaction.guild?.id;

 const effectiveSettings = getEffectiveSettings(guildId, userId);
 const currentPersonality = state.customInstructions[userId] || 'Default';
 const userModelPreference = getUserModelPreference(userId);
 
 const embed = new EmbedBuilder()
   .setColor(effectiveSettings.embedColor)
   .setTitle('👤 Your Personal Settings')
   .setDescription('Configure how the bot behaves for you across all servers and DMs.')
   .addFields(
     { name: 'Model', value: userModelPreference, inline: true },
     { name: 'Reply Mention', value: formatStatus(!getUserContinuousReply(userId)), inline: true },
     { name: 'Response Style', value: getUserResponsePreference(userId), inline: true },
     { name: 'Custom Personality', value: currentPersonality.length > 50 ? `${currentPersonality.substring(0, 50)}...` : currentPersonality, inline: true },
     { name: 'Action Buttons (Save/Del)', value: formatStatus(getUserActionButtons(userId)), inline: true },
     { name: 'Embed Color', value: getUserEmbedColor(userId), inline: true }
   )
   .setTimestamp();

 if (effectiveSettings.isOverridden) {
   embed.setFooter({ text: '⚠️ Server settings are currently overriding your personal settings.' });
 }

 const modelRow = new ActionRowBuilder().addComponents(createModelSelectMenu(false, userModelPreference));

 const actionButtonsRow1 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('toggle-continuous-reply-user').setLabel(`Continuous Reply (No @): ${formatStatus(getUserContinuousReply(userId))}`).setStyle(getUserContinuousReply(userId) ? ButtonStyle.Success : ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('toggle-response-mode-user').setLabel(`Response Format: ${getUserResponsePreference(userId)}`).setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('toggle-action-buttons-user').setLabel(`Action Buttons: ${formatStatus(getUserActionButtons(userId))}`).setStyle(getUserActionButtons(userId) ? ButtonStyle.Success : ButtonStyle.Danger),
 );

 const actionButtonsRow2 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('custom-personality').setLabel('Set Personality').setStyle(ButtonStyle.Primary),
   new ButtonBuilder().setCustomId('remove-personality').setLabel('Reset Personality').setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('custom-embed-color-user').setLabel('Embed Color').setStyle(ButtonStyle.Secondary),
 );
 
 const actionButtonsRow3 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('clear-memory').setLabel('Clear History').setStyle(ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('download-conversation').setLabel('Download History').setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('back_to_main_settings').setLabel('Back').setStyle(ButtonStyle.Secondary),
 );


 const replyOptions = {
   embeds: [embed],
   components: [modelRow, actionButtonsRow1, actionButtonsRow2, actionButtonsRow3],
   flags: MessageFlags.Ephemeral
 };

 if (update) {
   await interaction.update(replyOptions);
 } else {
   await interaction.reply(replyOptions);
 }
}

async function showServerSettings(interaction, update = false) {
 if (!interaction.guild) {
   return interaction.reply({ content: 'Server settings can only be managed in a server.', ephemeral: true });
 }
 if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
   return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('Permission Denied').setDescription('You need the `Manage Server` permission to view server settings.')], flags: MessageFlags.Ephemeral });
 }

 const guildId = interaction.guild.id;
 initializeBlacklistForGuild(guildId); // Ensure defaults are set
 const settings = state.serverSettings[guildId];
 const currentPersonality = state.customInstructions[guildId] || 'Default';
 const embedColor = settings.embedColor || config.hexColour;


 const embed = new EmbedBuilder()
   .setColor(embedColor)
   .setTitle(`🏠 ${interaction.guild.name} Server Settings`)
   .setDescription('These settings apply to all users in this server.')
   .addFields(
     { name: 'Chat History', value: formatStatus(settings.serverChatHistory), inline: true },
     { name: 'Model', value: settings.model, inline: true },
     { name: 'Reply Mention', value: formatStatus(!settings.continuousReply), inline: true },
     { name: 'Response Style', value: settings.responseStyle, inline: true },
     { name: 'Action Buttons', value: formatStatus(settings.actionButtons), inline: true },
     { name: 'Embed Color', value: settings.embedColor, inline: true },
     { name: 'Custom Personality', value: currentPersonality.length > 50 ? `${currentPersonality.substring(0, 50)}...` : currentPersonality, inline: false },
     { name: 'Override User Settings', value: formatStatus(settings.overrideUserSettings), inline: false },
   )
   .setTimestamp();

 const modelRow = new ActionRowBuilder().addComponents(createModelSelectMenu(true, settings.model));

 const actionButtonsRow1 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('toggle-override-user-settings').setLabel(`Override User Settings: ${formatStatus(settings.overrideUserSettings)}`).setStyle(settings.overrideUserSettings ? ButtonStyle.Success : ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('server-chat-history').setLabel(`Server Chat History: ${formatStatus(settings.serverChatHistory)}`).setStyle(settings.serverChatHistory ? ButtonStyle.Success : ButtonStyle.Danger),
 );

 const actionButtonsRow2 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('toggle-continuous-reply-server').setLabel(`Continuous Reply (No @): ${formatStatus(settings.continuousReply)}`).setStyle(settings.continuousReply ? ButtonStyle.Success : ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('toggle-response-mode-server').setLabel(`Response Format: ${settings.responseStyle}`).setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('toggle-action-buttons-server').setLabel(`Action Buttons: ${formatStatus(settings.actionButtons)}`).setStyle(settings.actionButtons ? ButtonStyle.Success : ButtonStyle.Danger),
 );
 
 const actionButtonsRow3 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('custom-server-personality').setLabel('Set Personality').setStyle(ButtonStyle.Primary),
   new ButtonBuilder().setCustomId('remove-server-personality').setLabel('Reset Personality').setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('custom-embed-color-server').setLabel('Embed Color').setStyle(ButtonStyle.Secondary),
 );

 const actionButtonsRow4 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('clear-server-memory').setLabel('Clear Server History').setStyle(ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('download-server-conversation').setLabel('Download Server History').setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('back_to_main_settings').setLabel('Back').setStyle(ButtonStyle.Secondary),
 );

 const replyOptions = {
   embeds: [embed],
   components: [modelRow, actionButtonsRow1, actionButtonsRow2, actionButtonsRow3, actionButtonsRow4],
   flags: MessageFlags.Ephemeral
 };

 if (update) {
   await interaction.update(replyOptions);
 } else {
   await interaction.reply(replyOptions);
 }
}

// <==========>


// <=====[Toggle Handlers (User & Server)]=====>

// ... (Toggle handlers for User and Server settings remain the same, they were correct) ...

async function toggleUserContinuousReply(interaction) {
 state.userContinuousReply[interaction.user.id] = !getUserContinuousReply(interaction.user.id);
 await saveStateToFile();
 await showUserSettings(interaction, true);
}

async function toggleUserActionButtons(interaction) {
 state.userActionButtons[interaction.user.id] = !getUserActionButtons(interaction.user.id);
 await saveStateToFile();
 await showUserSettings(interaction, true);
}

async function toggleUserResponsePreference(interaction) {
 const current = getUserResponsePreference(interaction.user.id);
 state.userResponsePreference[interaction.user.id] = current === 'Embedded' ? 'Normal' : 'Embedded';
 await saveStateToFile();
 await showUserSettings(interaction, true);
}


async function clearChatHistory(interaction) {
 state.chatHistories[interaction.user.id] = {};
 await saveStateToFile();
 await showUserSettings(interaction, true);
}

// Server Toggles
async function toggleOverrideUserSettings(interaction) {
 const guildId = interaction.guild.id;
 state.serverSettings[guildId].overrideUserSettings = !state.serverSettings[guildId].overrideUserSettings;
 await saveStateToFile();
 await showServerSettings(interaction, true);
 
 // Optionally notify the server channel if override is enabled/disabled
 const status = state.serverSettings[guildId].overrideUserSettings ? 'enabled (User settings will be ignored)' : 'disabled (User settings now apply)';
 const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('Override Toggled').setDescription(`Server override for user settings is now ${status}.`);
 await interaction.followUp({ embeds: [embed], ephemeral: false });
}

async function toggleServerContinuousReply(interaction) {
 const guildId = interaction.guild.id;
 state.serverSettings[guildId].continuousReply = !state.serverSettings[guildId].continuousReply;
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function toggleServerActionButtons(interaction) {
 const guildId = interaction.guild.id;
 state.serverSettings[guildId].actionButtons = !state.serverSettings[guildId].actionButtons;
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function toggleServerResponsePreference(interaction) {
 const guildId = interaction.guild.id;
 const current = state.serverSettings[guildId].responseStyle;
 state.serverSettings[guildId].responseStyle = current === 'Embedded' ? 'Normal' : 'Embedded';
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function serverPersonality(interaction) {
 const input = new TextInputBuilder().setCustomId('custom-server-personality-input').setLabel("What should the bot's personality be like?").setStyle(TextInputStyle.Paragraph).setPlaceholder("Enter the custom instructions here...").setMinLength(10).setMaxLength(4000);
 const modal = new ModalBuilder().setCustomId('custom-server-personality-modal').setTitle('Enter Custom Server Personality').addComponents(new ActionRowBuilder().addComponents(input));
 await interaction.showModal(modal);
}

async function removeServerPersonality(interaction) {
 delete state.customInstructions[interaction.guild.id];
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function clearServerChatHistory(interaction) {
 const guildId = interaction.guild.id;
 if (!state.serverSettings[guildId].serverChatHistory) {
   const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('Disabled').setDescription('Server-wide chat history is not enabled.');
   return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 }
 state.chatHistories[guildId] = {};
 await saveStateToFile();
 await showServerSettings(interaction, true);
}


// <==========>


// <=====[Utilities]=====>

// Text Upload Service Integration
const uploadText = async (text) => {
 const siteUrl = 'https://bin.mudfish.net';
 try {
   const response = await axios.post(`${siteUrl}/api/text`, {
     text: text,
     ttl: 10080
   }, {
     timeout: 3000
   });

   const key = response.data.tid;
   return `\nURL: ${siteUrl}/t/${key}`;
 } catch (error) {
   console.log('Text Upload Error:', error.message);
   return '\nURL Error :(';
 }
};

async function downloadMessage(interaction) {
 try {
   // Defer the reply to avoid timeout, but keep it ephemeral for the user
   await interaction.deferReply({ ephemeral: true });
   
   const message = interaction.message;
   let textContent = message.content;
   
   // Extract content from embed if it's an embedded response
   if (!textContent && message.embeds.length > 0) {
     textContent = message.embeds[0].description;
     // Also include fields content if present (like Sources/URL Context)
     if (message.embeds[0].fields?.length > 0) {
         textContent += "\n\n--- Metadata ---\n";
         message.embeds[0].fields.forEach(field => {
             textContent += `\n${field.name}:\n${field.value}`;
         });
     }
   }

   if (!textContent) {
     const emptyEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Empty Message')
       .setDescription('The message is empty..?');
     await interaction.editReply({ embeds: [emptyEmbed], files: [] });
     return;
   }

   const filePath = path.join(TEMP_DIR, `message_content_${interaction.id}.txt`);
   await fs.writeFile(filePath, textContent, 'utf8');

   const attachment = new AttachmentBuilder(filePath, {
     name: 'message_content.txt'
   });

   // Send the file as an ephemeral reply first
   await interaction.editReply({
     content: '> `Here is the content of the message:`',
     files: [attachment]
   });
   
   // Now get the shareable URL
   const msgUrl = await uploadText(textContent);

   // Edit the ephemeral reply to include the URL
   await interaction.editReply({
       content: `> \`Here is the content of the message:\`${msgUrl}`,
       files: [],
   });


   await fs.unlink(filePath).catch(console.error);

 } catch (error) {
   console.error('Failed to process download: ', error);
   await interaction.editReply({ content: 'An error occurred while preparing the download.', files: [] }).catch(console.error);
 }
}

async function downloadConversation(interaction) {
 // Use user-ID as history ID for personal conversation download
 await handleDownloadHistory(interaction, interaction.user.id, 'conversation_history.txt', 'Your conversation history has been sent to your DMs.');
}

async function downloadServerConversation(interaction) {
 // Use guild-ID as history ID for server-wide conversation download
 if (!state.serverSettings[interaction.guild.id]?.serverChatHistory) {
     return interaction.reply({ content: 'Server-wide chat history is not enabled.', ephemeral: true });
 }
 await handleDownloadHistory(interaction, interaction.guild.id, 'server_conversation_history.txt', 'Server-wide conversation history has been sent to your DMs.');
}

async function handleDownloadHistory(interaction, historyId, filename, successMessage) {
 try {
   await interaction.deferReply({ ephemeral: true });
   const conversationHistory = getHistory(historyId);

   if (!conversationHistory || conversationHistory.length === 0) {
     const noHistoryEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('No History Found').setDescription('No conversation history found.');
     await interaction.editReply({ embeds: [noHistoryEmbed], files: [] });
     return;
   }

   let conversationText = conversationHistory.map(entry => {
     const role = entry.role === 'user' ? '[User]' : '[Model]';
     const content = entry.parts.map(c => c.text).join('\n');
     return `${role}:\n${content}\n\n`;
   }).join('');

   const tempFileName = path.join(TEMP_DIR, `conversation_${interaction.id}.txt`);
   await fs.writeFile(tempFileName, conversationText, 'utf8');

   const file = new AttachmentBuilder(tempFileName, { name: filename });

   try {
     await interaction.user.send({ content: "> `Here's your conversation history:`", files: [file] });
     const dmSentEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('History Sent').setDescription(successMessage);
     await interaction.editReply({ embeds: [dmSentEmbed], files: [] });
   } catch (error) {
     console.error(`Failed to send DM: ${error}`);
     const failDMEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Delivery Failed').setDescription('Failed to send the conversation history to your DMs. Sending here instead.');
     await interaction.editReply({ embeds: [failDMEmbed], files: [file] });
   } finally {
     await fs.unlink(tempFileName).catch(console.error);
   }
 } catch (error) {
   console.error(`Failed to download conversation: ${error.message}`);
   await interaction.editReply({ content: 'An unexpected error occurred during history download.' }).catch(console.error);
 }
}

// ... (downloadFile, sanitizeFileName, extractFileText, downloadAndReadFile, processPromptAndMediaAttachments remain the same) ...

function downloadFile(url, filePath) {
 const writer = createWriteStream(filePath);
 const response = axios({
   url,
   method: 'GET',
   responseType: 'stream',
 });
 response.data.pipe(writer);
 return new Promise((resolve, reject) => {
   writer.on('finish', resolve);
   writer.on('error', reject);
 });
}

function sanitizeFileName(fileName) {
 return fileName
   .toLowerCase()
   .replace(/[^a-z0-9-]/g, '-')
   .replace(/^-+|-+$/g, '');
}


async function extractFileText(message, messageContent) {
 if (message.attachments.size > 0) {
   let attachments = Array.from(message.attachments.values());
   for (const attachment of attachments) {
     const fileType = path.extname(attachment.name) || '';
     const fileTypes = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

     if (fileTypes.includes(fileType)) {
       try {
         let fileContent = await downloadAndReadFile(attachment.url, fileType);
         messageContent += `\n\n[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent}\n\`\`\``;
       } catch (error) {
         console.error(`Error reading file ${attachment.name}: ${error.message}`);
       }
     }
   }
 }
 return messageContent;
}

async function downloadAndReadFile(url, fileType) {
 switch (fileType) {
   case 'pptx':
   case 'docx':
     const extractor = getTextExtractor();
     return (await extractor.extractText({
       input: url,
       type: 'url'
     }));
   default:
     const response = await fetch(url);
     if (!response.ok) throw new Error(`Failed to download ${response.statusText}`);
     return await response.text();
 }
}

// <==========>


// <=====[Core Message Logic]=====>

// Visual feedback during message processing (only when SEND_RETRY_ERRORS_TO_DISCORD is enabled)
const updateEmbedDescription = (textAttachmentStatus, imageAttachmentStatus, finalText) => {
 return `Let me think...\n\n- ${textAttachmentStatus}: Text Attachment Check\n- ${imageAttachmentStatus}: Media Attachment Check\n${finalText || ''}`;
};


async function handleTextMessage(message) {
 const botId = client.user.id;
 const userId = message.author.id;
 const guildId = message.guild?.id;
 const channelId = message.channel.id;
 
 // Use user-ID as the default history key for user-based memory
 let historyId = userId; 

 const effectiveSettings = getEffectiveSettings(guildId, userId);
 const textModel = effectiveSettings.model;
 let finalInstructions = effectiveSettings.customInstructions;
 const responseColor = effectiveSettings.embedColor;
 const shouldMention = !effectiveSettings.continuousReply;


 // Determine the actual history ID
 if (guildId) {
   if (state.channelWideChatHistory[channelId]) {
     historyId = channelId;
   } else if (state.serverSettings[guildId]?.serverChatHistory) {
     historyId = guildId;
     // Inject detailed user context into system instructions for server conversations
     const userInfo = {
       username: message.author.username,
       displayName: message.author.displayName
     };
     const infoStr = `\nYou are currently engaging with users in the ${message.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
     finalInstructions += infoStr;
   }
 }

 // Handle message content cleanup
 let messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

 if (messageContent === '' && !(message.attachments.size > 0 && hasSupportedAttachments(message))) {
   if (activeRequests.has(userId)) {
     activeRequests.delete(userId);
   }
   const embed = new EmbedBuilder().setColor(responseColor).setTitle('Empty Message').setDescription("It looks like you didn't say anything. What would you like to talk about?");
   const botMessage = await message.reply({ embeds: [embed] });
   // Only display settings button if action buttons are disabled
   if (!effectiveSettings.actionButtons) { 
       await addSettingsButton(botMessage);
   }
   return;
 }
 
 // Start typing indicator
 message.channel.sendTyping();
 const typingInterval = setInterval(() => { message.channel.sendTyping(); }, 4000);
 setTimeout(() => { clearInterval(typingInterval); }, 120000);
 
 let botMessage = false;
 let parts;
 try {
   if (SEND_RETRY_ERRORS_TO_DISCORD) {
     // Visual feedback during message processing (only when SEND_RETRY_ERRORS_TO_DISCORD is enabled)
     const embed = new EmbedBuilder()
       .setColor(0x00FFFF)
       .setTitle('Processing')
       .setDescription(updateEmbedDescription('[🔁]', '[🔁]'));
     
     // Ensure we reply with a mention if configured
     const initialContent = shouldMention ? `<@${userId}> ` : null;
     botMessage = await message.reply({ content: initialContent, embeds: [embed] });

     messageContent = await extractFileText(message, messageContent);
     embed.setDescription(updateEmbedDescription('[☑️]', '[🔁]'));
     await botMessage.edit({ embeds: [embed] });

     parts = await processPromptAndMediaAttachments(messageContent, message);
     embed.setDescription(updateEmbedDescription('[☑️]', '[☑️]', '### All checks done. Waiting for the response...'));
     await botMessage.edit({ embeds: [embed] });
   } else {
     messageContent = await extractFileText(message, messageContent);
     parts = await processPromptAndMediaAttachments(messageContent, message);
   }
 } catch (error) {
   clearInterval(typingInterval);
   activeRequests.delete(userId);
   console.error('Error initializing message parts:', error);
   const errorEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Processing Error').setDescription(`Failed to process attachments or text. Error: \`${error.message}\``);
   // If botMessage exists, edit it, otherwise reply to the original message
   if (botMessage) {
       await botMessage.edit({ content: null, embeds: [errorEmbed], components: [] });
   } else {
       await message.reply({ embeds: [errorEmbed] });
   }
   return;
 }
 
 // Always enable all three tools: Google Search, URL Context, and Code Execution
 const tools = [
   { googleSearch: {} },
   { urlContext: {} },
   { codeExecution: {} }
 ];

 // Create chat with new Google GenAI API format
 const chat = genAI.chats.create({
   model: textModel,
   config: {
     systemInstruction: {
       role: "system",
       parts: [{ text: finalInstructions || defaultPersonality }]
     },
     ...generationConfig,
     safetySettings,
     tools
   },
   history: getHistory(historyId)
 });

 await handleModelResponse(botMessage, chat, parts, message, typingInterval, historyId, effectiveSettings);
}


async function handleModelResponse(initialBotMessage, chat, parts, originalMessage, typingInterval, historyId, effectiveSettings) {
 const userId = originalMessage.author.id;
 const userResponsePreference = effectiveSettings.responseStyle;
 const responseColor = effectiveSettings.embedColor;
 const shouldMention = !effectiveSettings.continuousReply;
 const showActionButtons = effectiveSettings.actionButtons;
 
 const maxCharacterLimit = userResponsePreference === 'Embedded' ? 3900 : 1900;
 let attempts = 3;

 let updateTimeout;
 let tempResponse = '';
 let groundingMetadata = null;
 let urlContextMetadata = null;

 const stopGeneratingButton = new ActionRowBuilder()
   .addComponents(
     new ButtonBuilder().setCustomId('stopGenerating').setLabel('Stop Generating').setStyle(ButtonStyle.Danger)
   );
 
 let botMessage = initialBotMessage;
 
 // Reply to the original message for the first bot message, potentially with a mention, if not already replied (via SEND_RETRY_ERRORS_TO_DISCORD)
 if (!botMessage) {
     clearInterval(typingInterval); // Stop typing indicator before sending reply
     const initialContent = shouldMention ? `<@${userId}> Let me think...` : 'Let me think...';
     try {
         // Send the initial message with the stop button
         botMessage = await originalMessage.reply({ 
             content: initialContent, 
             components: [stopGeneratingButton],
             allowedMentions: { repliedUser: shouldMention } // Control mention based on setting
         });
     } catch (error) {
         console.error('Error sending initial bot message (no existing):', error);
         if (activeRequests.has(userId)) activeRequests.delete(userId);
         return;
     }
 } else {
     // If botMessage already exists (due to status check), edit it to add the stop button
     try {
         const contentPrefix = shouldMention ? `<@${userId}> ` : '';
         await botMessage.edit({ 
             content: contentPrefix + 'Let me think...', 
             embeds: botMessage.embeds.length ? botMessage.embeds : [], // Preserve embeds if they exist (from status update)
             components: [stopGeneratingButton],
             allowedMentions: { repliedUser: shouldMention }
         });
     } catch (error) {
         console.error('Error editing initial bot message (existing):', error);
         if (activeRequests.has(userId)) activeRequests.delete(userId);
         return;
     }
 }


 let stopGeneration = false;
 const filter = (interaction) => interaction.customId === 'stopGenerating';
 
 try {
   const collector = botMessage.createMessageComponentCollector({
     filter,
     time: 120000,
     componentType: ComponentType.Button
   });
   
   collector.on('collect', (interaction) => {
     if (interaction.user.id === originalMessage.author.id) {
       stopGeneration = true;
       collector.stop('user_stopped');
       interaction.reply({
           embeds: [new EmbedBuilder().setColor(0xFFA500).setTitle('Response Stopped').setDescription('Response generation stopped by the user.')],
           flags: MessageFlags.Ephemeral
       });
     } else {
       interaction.reply({
           embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('Access Denied').setDescription("It's not for you.")],
           flags: MessageFlags.Ephemeral
       });
     }
   });

   collector.on('end', (collected, reason) => {
     if (reason === 'time') {
       // Stop generation if timed out
       stopGeneration = true; 
     }
   });

 } catch (error) {
   console.error('Error creating or handling collector:', error);
 }

 const updateMessage = () => {
   if (stopGeneration || !botMessage || botMessage.deleted) {
     return;
   }
   const contentPrefix = shouldMention ? `<@${userId}> ` : '';
   
   if (tempResponse.trim() === "") {
     botMessage.edit({ content: `${contentPrefix}...`, embeds: [] }).catch(console.error);
   } else if (userResponsePreference === 'Embedded') {
     updateEmbed(botMessage, tempResponse, originalMessage, groundingMetadata, urlContextMetadata, responseColor, shouldMention);
   } else {
     botMessage.edit({ 
         content: contentPrefix + tempResponse, 
         embeds: [],
         allowedMentions: { repliedUser: shouldMention }
     }).catch(console.error);
   }
   clearTimeout(updateTimeout);
   updateTimeout = null;
 };

 while (attempts > 0 && !stopGeneration) {
   try {
     let finalResponse = '';
     let isLargeResponse = false;
     const newHistory = [];
     
     const userContent = { role: 'user', content: parts, messageId: originalMessage.id };
     newHistory.push(userContent);

     async function getResponse(parts) {
       let newResponse = '';
       const messageResult = await chat.sendMessageStream({ message: parts });
       for await (const chunk of messageResult) {
         if (stopGeneration) break;

         const chunkText = (chunk.text || (chunk.codeExecutionResult?.output ? `\n\`\`\`py\n${chunk.codeExecutionResult.output}\n\`\`\`\n` : "") || (chunk.executableCode ? `\n\`\`\`\n${chunk.executableCode}\n\`\`\`\n` : ""));
         if (chunkText && chunkText !== '') {
           finalResponse += chunkText;
           tempResponse += chunkText;
           newResponse += chunkText;
         }

         if (chunk.candidates && chunk.candidates[0]?.groundingMetadata) {
           groundingMetadata = chunk.candidates[0].groundingMetadata;
         }
         if (chunk.candidates && chunk.candidates[0]?.url_context_metadata) {
           urlContextMetadata = chunk.candidates[0].url_context_metadata;
         }

         if (finalResponse.length > maxCharacterLimit) {
           if (!isLargeResponse) {
             isLargeResponse = true;
             const embed = new EmbedBuilder().setColor(0xFFFF00).setTitle('Response Overflow').setDescription('The response got too large, will be sent as a text file once it is completed.');
             botMessage.edit({ embeds: [embed] }).catch(console.error);
           }
         } else if (!updateTimeout) {
           updateTimeout = setTimeout(updateMessage, 500);
         }
       }
       
       // Add model response to history, associating it with the bot's reply message ID
       newHistory.push({ role: 'assistant', content: [{ text: newResponse }], replyId: botMessage.id });
     }
     
     await getResponse(parts);

     clearInterval(typingInterval);
     if (updateTimeout) clearTimeout(updateTimeout);

     if (!botMessage || botMessage.deleted) {
         throw new Error('Bot message was deleted before response finished.');
     }
     
     const contentPrefix = shouldMention ? `<@${userId}> ` : '';

     if (stopGeneration) {
       await botMessage.edit({ content: contentPrefix + 'Generation was stopped by the user.', embeds: [], components: [] }).catch(console.error);
     } else if (isLargeResponse) {
       // Send large response as file
       sendAsTextFile(finalResponse, originalMessage, botMessage.id, effectiveSettings);
       // Clean up the streaming message
       await botMessage.delete().catch(console.error); 
     } else if (userResponsePreference === 'Embedded') {
       await updateEmbed(botMessage, finalResponse, originalMessage, groundingMetadata, urlContextMetadata, responseColor, shouldMention);
     } else {
       await botMessage.edit({ 
           content: contentPrefix + finalResponse, 
           embeds: [],
           components: [], // Remove stop button
           allowedMentions: { repliedUser: shouldMention }
       }).catch(console.error);
     }
     
     // Update action buttons after final response is sent
     if (showActionButtons && !isLargeResponse) { // Only add if not sent as a large file
       await addActionButtons(botMessage, botMessage.id);
     } else if (!isLargeResponse) {
       await addSettingsButton(botMessage);
     }

     await chatHistoryLock.runExclusive(async () => {
       // Update history with the message ID of the *user's* original message
       updateChatHistory(historyId, newHistory, originalMessage.id);
       await saveStateToFile();
     });
     break;

   } catch (error) {
     if (activeRequests.has(userId)) {
       activeRequests.delete(userId);
     }
     console.error('Generation Attempt Failed: ', error);
     attempts--;

     if (attempts === 0 || stopGeneration) {
       if (!stopGeneration && botMessage && !botMessage.deleted) {
         const finalErrorMsg = SEND_RETRY_ERRORS_TO_DISCORD ? `All Generation Attempts Failed :(\n\`\`\`${error.message}\`\`\`` : 'Something seems off, the bot might be overloaded! :(';
         const errorEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Bot Overloaded').setDescription(finalErrorMsg);
         await botMessage.edit({ content: `<@${userId}>`, embeds: [errorEmbed], components: [] }).catch(console.error);
         await addSettingsButton(botMessage);
       }
       break;
     } else if (SEND_RETRY_ERRORS_TO_DISCORD) {
       // This is the advanced error handling: Notify user of internal retry
       const errorMsg = await originalMessage.channel.send({
         content: `<@${originalMessage.author.id}>`,
         embeds: [new EmbedBuilder().setColor(0xFFFF00).setTitle('Retry in Progress').setDescription(`Generation Attempt(s) Failed, Retrying..\n\`\`\`${error.message}\`\`\``)]
       });
       setTimeout(() => errorMsg.delete().catch(console.error), 5000);
       await delay(500);
     }
   }
 }
 if (activeRequests.has(userId)) {
   activeRequests.delete(userId);
 }
}

function updateEmbed(botMessage, finalResponse, message, groundingMetadata = null, urlContextMetadata = null, responseColor, shouldMention) {
 try {
   const isGuild = message.guild !== null;
   const embed = new EmbedBuilder()
     .setColor(responseColor)
     .setDescription(finalResponse)
     .setAuthor({
       name: `To ${message.author.displayName}`,
       iconURL: message.author.displayAvatarURL()
     })
     .setTimestamp();

   if (groundingMetadata && shouldShowGroundingMetadata(message)) {
     addGroundingMetadataToEmbed(embed, groundingMetadata);
   }

   if (urlContextMetadata && shouldShowGroundingMetadata(message)) {
     addUrlContextMetadataToEmbed(embed, urlContextMetadata);
   }

   if (isGuild) {
     embed.setFooter({
       text: message.guild.name,
       iconURL: message.guild.iconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
     });
   }

   // Ensure we don't mention the user when in Embedded mode and continuous reply is enabled
   botMessage.edit({
     content: shouldMention ? `<@${message.author.id}> ` : ' ',
     embeds: [embed],
     components: [], // Remove stop button
     allowedMentions: { repliedUser: shouldMention }
   }).catch(console.error);

 } catch (error) {
   console.error("An error occurred while updating the embed:", error.message);
 }
}

function addGroundingMetadataToEmbed(embed, groundingMetadata) {
 // Add search queries used by the model
 if (groundingMetadata.webSearchQueries && groundingMetadata.webSearchQueries.length > 0) {
   embed.addFields({
     name: '🔍 Search Queries',
     value: groundingMetadata.webSearchQueries.map(query => `• ${query}`).join('\n'),
     inline: false
   });
 }

 // Add grounding sources with clickable links
 if (groundingMetadata.groundingChunks && groundingMetadata.groundingChunks.length > 0) {
   const chunks = groundingMetadata.groundingChunks
     .slice(0, 5) // Limit to first 5 chunks to avoid embed limits
     .map((chunk, index) => {
       if (chunk.web) {
         return `• [${chunk.web.title || 'Source'}](${chunk.web.uri})`;
       }
       return `• Source ${index + 1}`;
     })
     .join('\n');
   
   embed.addFields({
     name: '📚 Sources',
     value: chunks,
     inline: false
   });
 }
}

function addUrlContextMetadataToEmbed(embed, urlContextMetadata) {
 // Add URL retrieval status with success/failure indicators
 if (urlContextMetadata.url_metadata && urlContextMetadata.url_metadata.length > 0) {
   const urlList = urlContextMetadata.url_metadata
     .map(urlData => {
       const emoji = urlData.url_retrieval_status === 'URL_RETRIEVAL_STATUS_SUCCESS' ? '✔️' : '❌';
       return `${emoji} ${urlData.retrieved_url}`;
     })
     .join('\n');
   
   embed.addFields({
     name: '🔗 URL Context',
     value: urlList,
     inline: false
   });
 }
}

function shouldShowGroundingMetadata(message) {
 // Tools are always enabled; only show when user prefers Embedded responses
 const userId = message.author.id;
 const userResponsePreference = message.guild && state.serverSettings[message.guild.id]?.serverResponsePreference
   ? state.serverSettings[message.guild.id].responseStyle
   : getUserResponsePreference(userId);
 
 return userResponsePreference === 'Embedded';
}


async function sendAsTextFile(text, message, orgId, effectiveSettings) {
 try {
   const filename = `response-${Date.now()}.txt`;
   const tempFilePath = path.join(TEMP_DIR, filename);
   await fs.writeFile(tempFilePath, text);

   const shouldMention = !effectiveSettings.continuousReply;

   const botMessage = await message.channel.send({
     content: `${shouldMention ? `<@${message.author.id}>, ` : ''}Here is the response:`,
     files: [tempFilePath],
     allowedMentions: { repliedUser: shouldMention }
   });

   if (effectiveSettings.actionButtons) {
       await addActionButtons(botMessage, orgId);
   } else {
       await addSettingsButton(botMessage);
   }

   await fs.unlink(tempFilePath).catch(console.error);
 } catch (error) {
   console.error('An error occurred in sendAsTextFile:', error);
 }
}


async function addActionButtons(botMessage, msgId) {
 try {
   // 1. Download Button
   const downloadButton = new ButtonBuilder()
     .setCustomId('download_message')
     .setLabel('Save')
     .setEmoji('⬇️')
     .setStyle(ButtonStyle.Secondary);

   // 2. Delete Button
   const deleteButton = new ButtonBuilder()
     .setCustomId(`delete_message-${msgId}`)
     .setLabel('Delete')
     .setEmoji('🗑️')
     .setStyle(ButtonStyle.Secondary);
     
   // 3. Settings Button
   const settingsButton = new ButtonBuilder()
     .setCustomId('settings')
     .setEmoji('⚙️')
     .setStyle(ButtonStyle.Secondary);

   const actionRow = new ActionRowBuilder().addComponents(downloadButton, deleteButton, settingsButton);
   return await botMessage.edit({ components: [actionRow] }).catch(console.error);
 } catch (error) {
   console.error('Error adding action buttons:', error.message);
   return botMessage;
 }
}

async function addSettingsButton(botMessage) {
 try {
   // Only display the settings button
   const settingsButton = new ButtonBuilder()
     .setCustomId('settings')
     .setEmoji('⚙️')
     .setStyle(ButtonStyle.Secondary);

   const actionRow = new ActionRowBuilder().addComponents(settingsButton);
   return await botMessage.edit({ components: [actionRow] }).catch(console.error);
 } catch (error) {
   console.log('Error adding settings button:', error.message);
   return botMessage;
 }
}

// <==========>


client.login(token);
