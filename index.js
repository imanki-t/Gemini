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
 ApplicationCommandOptionType,
 PermissionFlagsBits
} from 'discord.js';
import {
 HarmBlockThreshold,
 HarmCategory,
 Type
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
import express from 'express'; // Added Express

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

import {
 delay,
 retryOperation,
} from './tools/others.js';

initialize().catch(console.error);


// <=====[Configuration]=====>

// Models available for user selection
const MODEL_OPTIONS = {
 'flash': 'gemini-2.5-flash',
 'flash-lite': 'gemini-2.5-flash-lite',
 '2.0-flash': 'gemini-2.0-flash',
};
const MODEL_CHOICES = Object.keys(MODEL_OPTIONS);
const DEFAULT_MODEL = config.defaultTextModel;

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
 thinkingConfig: {
   thinkingBudget: -1
 }
};

const activities = config.activities.map(activity => ({
 name: activity.name,
 type: ActivityType[activity.type]
}));

// <==========>


// <=====[Helper Functions]=====>
// Moved helper functions here to fix 'is not defined' errors

function sanitizeFileName(fileName) {
 return fileName
   .toLowerCase()
   .replace(/[^a-z0-9-]/g, '-')
   .replace(/^-+|-+$/g, '');
}

async function downloadFile(url, filePath) {
 const writer = createWriteStream(filePath);
 const response = await axios({
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

function hasSupportedAttachments(message) {
 const supportedFileExtensions = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];
 return message.attachments.some((attachment) => {
   const contentType = (attachment.contentType || "").toLowerCase();
   const fileExtension = path.extname(attachment.name) || '';
   return (
     // Allow image (excluding gif), audio, video, pdf
     (contentType.startsWith('image/') && contentType !== 'image/gif') ||
     contentType.startsWith('audio/') ||
     contentType.startsWith('video/') ||
     contentType.startsWith('application/pdf') ||
     contentType.startsWith('application/x-pdf') ||
     // Allow specified text/code documents
     supportedFileExtensions.includes(fileExtension)
   );
 });
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

async function extractFileText(message, messageContent) {
 if (message.attachments.size > 0) {
   let attachments = Array.from(message.attachments.values());
   for (const attachment of attachments) {
     const fileType = path.extname(attachment.name) || '';
     const fileTypes = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

     if (fileTypes.includes(fileType)) {
       try {
         let fileContent = await downloadAndReadFile(attachment.url, fileType);
         // Inject file content into the prompt
         messageContent += `\n\n[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent}\n\`\`\``;
       } catch (error) {
         console.error(`Error reading file ${attachment.name}: ${error.message}`);
       }
     }
   }
 }
 return messageContent;
}

async function processPromptAndMediaAttachments(prompt, message) {
 const attachments = JSON.parse(JSON.stringify(Array.from(message.attachments.values())));
 let parts = [{
   text: prompt
 }];

 if (attachments.length > 0) {
   const validAttachments = attachments.filter(attachment => {
     const contentType = (attachment.contentType || "").toLowerCase();
     return (contentType.startsWith('image/') && contentType !== 'image/gif') ||
       contentType.startsWith('audio/') ||
       contentType.startsWith('video/') ||
       contentType.startsWith('application/pdf') ||
       contentType.startsWith('application/x-pdf');
   });

   if (validAttachments.length > 0) {
     const attachmentParts = await Promise.all(
       validAttachments.map(async (attachment) => {
         const sanitizedFileName = sanitizeFileName(attachment.name);
         const uniqueTempFilename = `${message.author.id}-${attachment.id}-${sanitizedFileName}`;
         const filePath = path.join(TEMP_DIR, uniqueTempFilename);

         try {
           await downloadFile(attachment.url, filePath);

           // Upload file using new Google GenAI API format
           const uploadResult = await genAI.files.upload({
             file: filePath,
             config: {
               mimeType: attachment.contentType,
               displayName: sanitizedFileName,
             }
           });

           const name = uploadResult.name;
           if (name === null) {
             throw new Error(`Unable to extract file name from upload result.`);
           }

           if (attachment.contentType.startsWith('video/')) {
             // Wait for video processing to complete using new API
             let file = await genAI.files.get({
               name: name
             });
             while (file.state === 'PROCESSING') {
               process.stdout.write(".");
               await new Promise((resolve) => setTimeout(resolve, 10_000));
               file = await genAI.files.get({
                 name: name
               });
             }
             if (file.state === 'FAILED') {
               throw new Error(`Video processing failed for ${sanitizedFileName}.`);
             }
           }

           return createPartFromUri(uploadResult.uri, uploadResult.mimeType);
         } catch (error) {
           console.error(`Error processing attachment ${sanitizedFileName}:`, error);
           return null;
         } finally {
           try {
             await fs.unlink(filePath);
           } catch (unlinkError) {
             if (unlinkError.code !== 'ENOENT') {
               console.error(`Error deleting temporary file ${filePath}:`, unlinkError);
             }
           }
         }
       })
     );
     parts = [...parts, ...attachmentParts.filter(part => part !== null)];
   }
 }
 return parts;
}

const updateEmbedDescription = (textAttachmentStatus, imageAttachmentStatus, finalText) => {
 return `Let me think...\n\n- ${textAttachmentStatus}: Text Attachment Check\n- ${imageAttachmentStatus}: Media Attachment Check\n${finalText || ''}`;
};

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
   console.log(error);
   return '\nURL Error :(';
 }
};

// <==========>


// <=====[Express Server]=====>
const app = express();
const port = 3000;

app.get('/', (req, res) => {
 res.send('Bot is running!');
});

app.listen(port, () => {
 console.log(`Express server listening at http://localhost:${port}`);
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

   await rest.put(
     Routes.applicationCommands(client.user.id), {
       body: commands
     },
   );

   console.log('Successfully reloaded application (/) commands.');
 } catch (error) {
   console.error(error);
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

client.on('messageCreate', async (message) => {
 try {
   if (message.author.bot) return;

   const botId = client.user.id;
   const isDM = message.channel.type === ChannelType.DM;
   const userId = message.author.id;
   const guildId = message.guild?.id;

   // Check conditions for bot response
   const shouldRespond = (
     config.workInDMs && isDM ||
     state.alwaysRespondChannels[message.channelId] ||
     (message.mentions.users.has(client.user.id) && !isDM) ||
     state.activeUsersInChannels[message.channelId]?.[userId]
   );

   if (shouldRespond) {
     if (guildId) {
       initializeBlacklistForGuild(guildId);
       if (state.blacklistedUsers[guildId].includes(userId)) {
         const embed = new EmbedBuilder()
           .setColor(0xFF0000)
           .setTitle('Blacklisted')
           .setDescription('You are blacklisted and cannot use this bot.');
         return message.reply({
           embeds: [embed]
         });
       }
     }
     if (activeRequests.has(userId)) {
       const embed = new EmbedBuilder()
         .setColor(0xFFFF00)
         .setTitle('Request In Progress')
         .setDescription('Please wait until your previous action is complete.');
       await message.reply({
         embeds: [embed]
       });
     } else {
       activeRequests.add(userId);
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

client.on('messageUpdate', async (oldMessage, newMessage) => {
 // Ignore partial messages or bot messages
 if (newMessage.partial || newMessage.author.bot) return;

 const userId = newMessage.author.id;
 const botId = client.user.id;

 // Only proceed if the message is from a user and is less than 10 minutes old
 const isRecent = (Date.now() - newMessage.createdTimestamp) < (10 * 60 * 1000);
 if (!isRecent) return;

 try {
   // Find the bot's direct reply to the user's message
   const botReply = await newMessage.channel.messages.fetch({ limit: 10 }).then(messages =>
     messages.find(msg =>
       msg.author.id === botId &&
       msg.reference?.messageId === newMessage.id
     )
   );

   if (botReply) {
     console.log(`User message edited. Regenerating response for ${userId}`);
     
     // Delete the old bot reply immediately
     await botReply.delete().catch(e => console.error("Could not delete old bot reply:", e));

     // Re-trigger the response generation logic with the new message content
     if (activeRequests.has(userId)) {
       // If a request is already running, wait for it to finish and then ignore this edit to prevent spamming
       await newMessage.channel.send({
         content: `🤖 I noticed your edit, but I'm currently processing another request. Please wait a moment.`,
         reply: { messageReference: newMessage.id }
       });
       return;
     }

     activeRequests.add(userId);
     await handleTextMessage(newMessage);
     
   }
 } catch (error) {
   console.error('Error handling message update:', error);
   if (activeRequests.has(userId)) {
     activeRequests.delete(userId);
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
   }
 } catch (error) {
   console.error('Error handling interaction:', error.message);
 }
});

async function handleCommandInteraction(interaction) {
 if (!interaction.isChatInputCommand()) return;

 const commandHandlers = {
   settings: handleSettingsCommand,
   search: handleSearchCommand,
   // Note: All other old admin commands are handled via the settings menu now.
 };

 const handler = commandHandlers[interaction.commandName];
 if (handler) {
   await handler(interaction);
 } else {
   console.log(`Unknown command: ${interaction.commandName}`);
 }
}

async function handleButtonInteraction(interaction) {
 if (!interaction.isButton()) return;

 if (interaction.guild) {
   initializeBlacklistForGuild(interaction.guild.id);
   if (state.blacklistedUsers[interaction.guild.id].includes(interaction.user.id)) {
     const embed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Blacklisted')
       .setDescription('You are blacklisted and cannot use this interaction.');
     return interaction.reply({
       embeds: [embed],
       flags: MessageFlags.Ephemeral
     });
   }
 }

 const [command, ...args] = interaction.customId.split('-');

 const buttonHandlers = {
   // Settings Navigation
   'user_settings': showUserSettings,
   'server_settings': showServerSettings,
   'back_to_main_settings': showSettings,

   // User Settings Sub-commands
   'clear_memory': clearChatHistory,
   'download_conversation': downloadConversation,
   'set_custom_personality': setCustomPersonality,
   'remove_personality': removeCustomPersonality,
   'toggle_response_mode': toggleUserResponsePreference,
   'model_select': toggleUserModelPreference,
   'action_buttons': toggleUserActionButtons,
   'continuous_reply': toggleUserContinuousReply,
   'embed_color': showEmbedColorModal,

   // Server Settings Sub-commands (Admin/Manage Guild Only)
   'toggle_override': toggleServerOverride,
   'server_clear_memory': clearServerChatHistory,
   'server_download_conversation': downloadServerConversation,
   'server_set_custom_personality': serverPersonality,
   'server_remove_personality': removeServerPersonality,
   'server_response_mode': toggleServerResponsePreference,
   'server_model_select': toggleServerModelPreference,
   'server_action_buttons': toggleServerActionButtons,
   'server_continuous_reply': toggleServerContinuousReply,
   'server_embed_color': showServerEmbedColorModal,
   
   // Message Action Buttons
   'download_message': downloadMessage,
 };

 if (buttonHandlers[command]) {
   await buttonHandlers[command](interaction, args.join('-'));
 } else if (command === 'delete_message') {
   await handleDeleteMessageInteraction(interaction, args[0]);
 } else {
   console.log(`Unknown button interaction: ${interaction.customId}`);
 }
}

async function handleDeleteMessageInteraction(interaction, msgId) {
 const userId = interaction.user.id;
 const historyId = interaction.guild ? interaction.guild.id : userId; // Use historyId based on server/user
 
 // Find the original user message associated with this bot message
 let userMessageId = null;
 for (const [messageKey, history] of Object.entries(state.chatHistories[historyId] || {})) {
     if (messageKey === msgId) {
         userMessageId = msgId;
         break;
     }
 }

 // Delete the bot message that contains the button
 await interaction.message.delete()
     .catch(e => console.error('Error deleting interaction message: ', e));

 // If a matching history entry was found, attempt to delete it
 if (userMessageId) {
     await chatHistoryLock.runExclusive(async () => {
         delete state.chatHistories[historyId][userMessageId];
         await saveStateToFile();
         console.log(`Chat history entry for ${userMessageId} deleted for ${historyId}.`);
     });
 }
}

async function handleModalSubmit(interaction) {
 const [modalType, targetId] = interaction.customId.split('-');

 if (modalType === 'custom-personality-modal') {
   const customInstructionsInput = interaction.fields.getTextInputValue('custom-personality-input');
   await handleCustomPersonalitySubmit(interaction, targetId, customInstructionsInput);
 } else if (modalType === 'embed-color-modal') {
   const colorInput = interaction.fields.getTextInputValue('embed-color-input').toUpperCase().replace(/[^0-9A-F]/g, '');
   await handleEmbedColorSubmit(interaction, targetId, colorInput);
 } else {
   console.log(`Unknown modal submission: ${interaction.customId}`);
 }
}

async function handleCustomPersonalitySubmit(interaction, targetId, instructions) {
 try {
   const isServer = targetId === 'server';
   const id = isServer ? interaction.guild.id : interaction.user.id;

   if (isServer && !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
     return interaction.reply({ content: 'You need `Manage Server` permission to change server personality.', flags: MessageFlags.Ephemeral });
   }

   state.customInstructions[id] = instructions.trim();

   const embed = new EmbedBuilder()
     .setColor(0x00FF00)
     .setTitle('Success')
     .setDescription(`${isServer ? 'Server' : 'User'} Personality Instructions Saved!`);
   
   await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

   // Update settings menu if it's the current active message
   if (!isServer) {
     await showUserSettings(interaction, true);
   } else {
     await showServerSettings(interaction, true);
   }

 } catch (error) {
   console.error('Error submitting personality modal:', error.message);
 }
}

async function handleEmbedColorSubmit(interaction, targetId, colorInput) {
 try {
   const isServer = targetId === 'server';
   const id = isServer ? interaction.guild.id : interaction.user.id;

   if (isServer && !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
     return interaction.reply({ content: 'You need `Manage Server` permission to change server embed color.', flags: MessageFlags.Ephemeral });
   }

   if (!/^#?[0-9A-F]{6}$/i.test(colorInput)) {
     return interaction.reply({ content: 'Invalid HEX code format. Use 6 characters (e.g., FF00FF).', flags: MessageFlags.Ephemeral });
   }

   const hexColor = colorInput.startsWith('#') ? colorInput : `#${colorInput}`;

   if (isServer) {
     state.serverSettings[id].embedColor = hexColor;
   } else {
     state.userEmbedColor[id] = hexColor;
   }

   const embed = new EmbedBuilder()
     .setColor(hexColor)
     .setTitle('Success')
     .setDescription(`${isServer ? 'Server' : 'User'} Embed color updated to ${hexColor}!`);

   await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

   // Update settings menu if it's the current active message
   if (!isServer) {
     await showUserSettings(interaction, true);
   } else {
     await showServerSettings(interaction, true);
   }

 } catch (error) {
   console.error('Error submitting color modal:', error.message);
 }
}

// <==========>


// <=====[Command Handlers]=====>

async function handleSettingsCommand(interaction) {
 await showSettings(interaction, false);
}

async function handleSearchCommand(interaction) {
 await interaction.deferReply();
 const userId = interaction.user.id;
 const prompt = interaction.options.getString('prompt') || 'Analyze the attached file and provide a detailed summary.';
 const attachment = interaction.options.getAttachment('attachment');

 if (!attachment && !prompt) {
   await interaction.editReply({
     content: 'Please provide a prompt or an attachment for the search.',
     ephemeral: true
   });
   return;
 }

 let fullPrompt = prompt;
 const tempMessage = {
   attachments: attachment ? new Map([
     [attachment.id, attachment]
   ]) : new Map(),
   author: interaction.user,
   content: ''
 };

 try {
   // 1. Extract text content from supported text/code documents
   fullPrompt = await extractFileText(tempMessage, prompt);

   // 2. Process media attachments (images/video/pdf)
   const parts = await processPromptAndMediaAttachments(fullPrompt, tempMessage);

   if (parts.length === 1 && !parts[0].text) {
       // This case should ideally not happen if a prompt was provided, but is a safe guard
       await interaction.editReply({
           content: "I couldn't process the file or the prompt was empty. Please try again.",
           ephemeral: true
       });
       return;
   }
   
   // Since this is a focused search command, we will force the model to use Google Search tool.
   const tools = [{ googleSearch: {} }];
   
   const userModel = getUserModelPreference(userId);
   const modelToUse = MODEL_OPTIONS[userModel] || DEFAULT_MODEL;

   const chat = genAI.chats.create({
     model: modelToUse,
     config: {
       systemInstruction: {
         role: "system",
         parts: [{ text: config.defaultPersonality + "\n\n**Task:** You are performing a focused search. Provide a concise, highly relevant answer to the user's query and attachment content using the available search tool." }]
       },
       ...generationConfig,
       safetySettings,
       tools
     },
     history: [] // Search command does not use chat history
   });

   const botMessage = await interaction.fetchReply(); // Use the deferred reply message
   await handleModelResponse(botMessage, chat, parts, interaction, null, userId);

 } catch (error) {
   console.error('Error in handleSearchCommand:', error);
   await interaction.editReply({
     content: 'An error occurred during the search operation. Please check the logs.',
     embeds: []
   });
 }
}

// <==========>


// <=====[Settings UI Logic]=====>

async function showSettings(interaction, isUpdate) {
 // Use deferReply or reply/update logic based on context
 if (!isUpdate && !interaction.replied && !interaction.deferred) {
   await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Opening settings..." });
 }

 const userId = interaction.user.id;
 const userColor = getUserEmbedColor(userId);

 const mainButtons = [{
     customId: 'user_settings',
     label: 'User Settings',
     emoji: '👤',
     style: ButtonStyle.Primary
   },
   {
     customId: 'server_settings',
     label: 'Server Settings (Admin)',
     emoji: '🌐',
     style: ButtonStyle.Secondary,
     disabled: !interaction.guild
   },
 ];

 const mainButtonsComponents = mainButtons.map(config =>
   new ButtonBuilder()
   .setCustomId(config.customId)
   .setLabel(config.label)
   .setEmoji(config.emoji)
   .setStyle(config.style)
   .setDisabled(config.disabled || false)
 );

 const mainActionRow = new ActionRowBuilder().addComponents(...mainButtonsComponents);

 const embed = new EmbedBuilder()
   .setColor(userColor)
   .setTitle('🤖 Main Settings Dashboard')
   .setDescription('Welcome! Choose a category below to manage your personal bot experience or server-wide preferences.');

 const payload = {
   embeds: [embed],
   components: [mainActionRow],
   flags: MessageFlags.Ephemeral
 };

 if (isUpdate) {
   await interaction.editReply(payload);
 } else {
   // If it was a slash command reply, edit the "Opening settings..."
   if (interaction.deferred) {
       await interaction.editReply(payload);
   } else {
       await interaction.reply(payload);
   }
 }
}

async function showUserSettings(interaction, isUpdate) {
 // Check if we need to defer/update/editReply
 if (!isUpdate && interaction.isButton()) {
   await interaction.deferUpdate();
 } else if (!isUpdate && !interaction.replied && !interaction.deferred) {
   await interaction.reply({ flags: MessageFlags.Ephemeral });
 }

 const userId = interaction.user.id;
 const userPersonality = state.customInstructions[userId] ? 'SET' : 'DEFAULT';
 const userResponseMode = getUserResponsePreference(userId);
 const userModel = getUserModelPreference(userId);
 const userContinuousReply = getUserContinuousReply(userId);
 const userActionButtons = getUserActionButtons(userId);
 const userColor = getUserEmbedColor(userId);

 const buttonsRow1 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('continuous_reply').setLabel(`Continuous Reply: ${userContinuousReply ? 'ON' : 'OFF'}`).setStyle(userContinuousReply ? ButtonStyle.Success : ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('action_buttons').setLabel(`Action Buttons: ${userActionButtons ? 'ON' : 'OFF'}`).setStyle(userActionButtons ? ButtonStyle.Success : ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('toggle_response_mode').setLabel(`Response Style: ${userResponseMode}`).setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('model_select').setLabel(`Model: ${userModel}`).setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('embed_color').setLabel(`Embed Color: ${userColor}`).setStyle(ButtonStyle.Secondary),
 );

 const buttonsRow2 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('clear_memory').setLabel('Clear History').setEmoji('🧹').setStyle(ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('download_conversation').setLabel('Download History').setEmoji('🗃️').setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('set_custom_personality').setLabel(`Personality: ${userPersonality}`).setEmoji('🤖').setStyle(userPersonality === 'SET' ? ButtonStyle.Primary : ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('remove_personality').setLabel('Remove Personality').setEmoji('❌').setStyle(ButtonStyle.Secondary).setDisabled(userPersonality === 'DEFAULT'),
 );

 const buttonsRow3 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('back_to_main_settings').setLabel('Back to Main').setEmoji('🔙').setStyle(ButtonStyle.Secondary),
 );

 const embed = new EmbedBuilder()
   .setColor(userColor)
   .setTitle('👤 User Settings')
   .setDescription('Manage your personal conversation preferences. Changes here apply to all your interactions with the bot across servers and DMs.')
   .addFields({
     name: 'Continuous Reply',
     value: userContinuousReply ? 'Bot will not mention you on replies.' : 'Bot will mention you on every reply.',
     inline: true
   }, {
     name: 'Action Buttons',
     value: userActionButtons ? 'Save/Stop/Delete buttons are shown on bot messages.' : 'Action buttons are hidden.',
     inline: true
   }, {
     name: 'Personality',
     value: userPersonality === 'SET' ? `Custom personality is active.` : 'Using default personality.',
     inline: false
   });

 const payload = {
   embeds: [embed],
   components: [buttonsRow1, buttonsRow2, buttonsRow3],
   flags: MessageFlags.Ephemeral
 };

 if (isUpdate) {
   await interaction.editReply(payload);
 } else if (interaction.isButton()) {
   await interaction.editReply(payload);
 } else {
   await interaction.reply(payload);
 }
}

async function showServerSettings(interaction, isUpdate) {
 if (!interaction.guild) {
   return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
 }
 
 // Check permission first (Manage Guild)
 const isManager = interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild);
 if (!isManager) {
   return interaction.reply({ content: 'You need **Manage Server** permission to access server settings.', flags: MessageFlags.Ephemeral });
 }

 // Check if we need to defer/update/editReply
 if (!isUpdate && interaction.isButton()) {
   await interaction.deferUpdate();
 } else if (!isUpdate && !interaction.replied && !interaction.deferred) {
   await interaction.reply({ flags: MessageFlags.Ephemeral });
 }

 const serverId = interaction.guild.id;
 initializeBlacklistForGuild(serverId); // Ensure server settings exist

 const settings = state.serverSettings[serverId];
 const serverPersonality = state.customInstructions[serverId] ? 'SET' : 'DEFAULT';
 const serverColor = settings.embedColor;

 const buttonsRow1 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('toggle_override').setLabel(`Override User Settings: ${settings.overrideUserSettings ? 'ON' : 'OFF'}`).setStyle(settings.overrideUserSettings ? ButtonStyle.Success : ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('server_continuous_reply').setLabel(`Continuous Reply: ${settings.continuousReply ? 'ON' : 'OFF'}`).setStyle(settings.continuousReply ? ButtonStyle.Success : ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('server_action_buttons').setLabel(`Action Buttons: ${settings.actionButtons ? 'ON' : 'OFF'}`).setStyle(settings.actionButtons ? ButtonStyle.Success : ButtonStyle.Danger),
 );

 const buttonsRow2 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('server_response_mode').setLabel(`Response Style: ${settings.responseStyle}`).setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('server_model_select').setLabel(`Model: ${settings.model}`).setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('server_embed_color').setLabel(`Embed Color: ${serverColor}`).setStyle(ButtonStyle.Secondary),
 );

 const buttonsRow3 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('server_clear_memory').setLabel('Clear Server History').setEmoji('🧹').setStyle(ButtonStyle.Danger),
   new ButtonBuilder().setCustomId('server_download_conversation').setLabel('Download Server History').setEmoji('🗃️').setStyle(ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('server_set_custom_personality').setLabel(`Personality: ${serverPersonality}`).setEmoji('🤖').setStyle(serverPersonality === 'SET' ? ButtonStyle.Primary : ButtonStyle.Secondary),
   new ButtonBuilder().setCustomId('server_remove_personality').setLabel('Remove Personality').setEmoji('❌').setStyle(ButtonStyle.Secondary).setDisabled(serverPersonality === 'DEFAULT'),
 );

 const buttonsRow4 = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('back_to_main_settings').setLabel('Back to Main').setEmoji('🔙').setStyle(ButtonStyle.Secondary),
 );

 const embed = new EmbedBuilder()
   .setColor(serverColor)
   .setTitle(`🌐 Server Settings for ${interaction.guild.name}`)
   .setDescription('Configure server-wide default preferences. **If Override is ON, these settings take precedence over individual user settings.**')
   .addFields({
     name: 'Override User Settings',
     value: settings.overrideUserSettings ? '**Active** - Server settings are enforced.' : '**Inactive** - Users can use their personal settings.',
     inline: false
   }, {
     name: 'Model / Response Style / Actions',
     value: `Model: \`${settings.model}\`\nResponse: \`${settings.responseStyle}\`\nActions: \`${settings.actionButtons ? 'ON' : 'OFF'}\`\nReply: \`${settings.continuousReply ? 'NO @MENTION' : '@MENTION'}\``,
     inline: false
   }, {
     name: 'Personality',
     value: serverPersonality === 'SET' ? 'Custom server personality is active.' : 'Using default bot personality.',
     inline: false
   });

 const payload = {
   embeds: [embed],
   components: [buttonsRow1, buttonsRow2, buttonsRow3, buttonsRow4],
   flags: MessageFlags.Ephemeral
 };

 if (isUpdate) {
   await interaction.editReply(payload);
 } else if (interaction.isButton() || interaction.isModalSubmit()) {
   await interaction.editReply(payload);
 } else {
   await interaction.reply(payload);
 }
}

// <==========>


// <=====[User Settings Handlers]=====>

async function clearChatHistory(interaction) {
 await chatHistoryLock.runExclusive(async () => {
   delete state.chatHistories[interaction.user.id];
   await saveStateToFile();
 });
 const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('Chat History Cleared').setDescription('Your personal conversation history has been cleared!');
 await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 await showUserSettings(interaction, true); // Update settings menu
}

async function setCustomPersonality(interaction) {
 const input = new TextInputBuilder().setCustomId('custom-personality-input').setLabel("What should the bot's personality be?").setStyle(TextInputStyle.Paragraph).setPlaceholder("Enter the custom instructions here...").setMinLength(10).setMaxLength(4000);
 const modal = new ModalBuilder().setCustomId('custom-personality-modal-user').setTitle('Enter Custom Personality').addComponents(new ActionRowBuilder().addComponents(input));
 await interaction.showModal(modal);
}

async function removeCustomPersonality(interaction) {
 delete state.customInstructions[interaction.user.id];
 await saveStateToFile();
 const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('Removed').setDescription('Custom personality instructions removed! Using default bot personality now.');
 await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 await showUserSettings(interaction, true); // Update settings menu
}

async function toggleUserResponsePreference(interaction) {
 const userId = interaction.user.id;
 const currentPreference = getUserResponsePreference(userId);
 state.userResponsePreference[userId] = currentPreference === 'Normal' ? 'Embedded' : 'Normal';
 await saveStateToFile();
 await showUserSettings(interaction, true);
}

async function toggleUserModelPreference(interaction) {
 const userId = interaction.user.id;
 const currentModel = getUserModelPreference(userId);
 const currentIndex = MODEL_CHOICES.indexOf(Object.keys(MODEL_OPTIONS).find(key => MODEL_OPTIONS[key] === currentModel));
 const nextIndex = (currentIndex + 1) % MODEL_CHOICES.length;
 state.userModelPreference[userId] = MODEL_OPTIONS[MODEL_CHOICES[nextIndex]];
 await saveStateToFile();
 await showUserSettings(interaction, true);
}

async function toggleUserContinuousReply(interaction) {
 const userId = interaction.user.id;
 state.userContinuousReply[userId] = !getUserContinuousReply(userId);
 await saveStateToFile();
 await showUserSettings(interaction, true);
}

async function toggleUserActionButtons(interaction) {
 const userId = interaction.user.id;
 state.userActionButtons[userId] = !getUserActionButtons(userId);
 await saveStateToFile();
 await showUserSettings(interaction, true);
}

async function showEmbedColorModal(interaction) {
 const currentColor = getUserEmbedColor(interaction.user.id);
 const input = new TextInputBuilder().setCustomId('embed-color-input').setLabel('Enter HEX Color Code (e.g., FF00FF)').setStyle(TextInputStyle.Short).setPlaceholder(currentColor).setMinLength(6).setMaxLength(7);
 const modal = new ModalBuilder().setCustomId('embed-color-modal-user').setTitle('Set Custom Embed Color').addComponents(new ActionRowBuilder().addComponents(input));
 await interaction.showModal(modal);
}

async function downloadConversation(interaction) {
 await interaction.deferReply({ flags: MessageFlags.Ephemeral });
 const userId = interaction.user.id;
 const conversationHistory = getHistory(userId);

 if (!conversationHistory || conversationHistory.length === 0) {
   const noHistoryEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('No History Found').setDescription('No personal conversation history found.');
   return interaction.editReply({ embeds: [noHistoryEmbed] });
 }

 let conversationText = conversationHistory.map(entry => {
   const role = entry.role === 'user' ? '[User]' : '[Model]';
   const content = entry.parts.map(c => c.text).join('\n');
   return `${role}:\n${content}\n\n`;
 }).join('');

 const tempFileName = path.join(TEMP_DIR, `conversation_${interaction.id}.txt`);
 await fs.writeFile(tempFileName, conversationText, 'utf8');
 const file = new AttachmentBuilder(tempFileName, { name: 'conversation_history.txt' });

 try {
   await interaction.user.send({ content: "> `Here's your conversation history:`", files: [file] });
   const dmSentEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('History Sent').setDescription('Your conversation history has been sent to your DMs.');
   await interaction.editReply({ embeds: [dmSentEmbed], files: [] });
 } catch (error) {
   console.error(`Failed to send DM: ${error}`);
   const failDMEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Delivery Failed').setDescription('Failed to send the conversation history to your DMs. You may have DMs disabled.');
   await interaction.editReply({ embeds: [failDMEmbed], files: [file] });
 } finally {
   await fs.unlink(tempFileName).catch(() => {});
 }
}

// <==========>


// <=====[Server Settings Handlers (Admin Only)]=====>

async function ensureAdmin(interaction) {
 if (!interaction.guild || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
   const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('Permission Denied').setDescription('You need **Manage Server** permission to modify server settings.');
   await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
   return false;
 }
 return true;
}

async function toggleServerOverride(interaction) {
 if (!await ensureAdmin(interaction)) return;
 const serverId = interaction.guild.id;
 const current = state.serverSettings[serverId].overrideUserSettings;
 state.serverSettings[serverId].overrideUserSettings = !current;
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function toggleServerContinuousReply(interaction) {
 if (!await ensureAdmin(interaction)) return;
 const serverId = interaction.guild.id;
 const current = state.serverSettings[serverId].continuousReply;
 state.serverSettings[serverId].continuousReply = !current;
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function toggleServerActionButtons(interaction) {
 if (!await ensureAdmin(interaction)) return;
 const serverId = interaction.guild.id;
 const current = state.serverSettings[serverId].actionButtons;
 state.serverSettings[serverId].actionButtons = !current;
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function toggleServerResponsePreference(interaction) {
 if (!await ensureAdmin(interaction)) return;
 const serverId = interaction.guild.id;
 const current = state.serverSettings[serverId].responseStyle;
 state.serverSettings[serverId].responseStyle = current === 'Normal' ? 'Embedded' : 'Normal';
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function toggleServerModelPreference(interaction) {
 if (!await ensureAdmin(interaction)) return;
 const serverId = interaction.guild.id;
 const currentModel = state.serverSettings[serverId].model;
 const currentIndex = MODEL_CHOICES.indexOf(Object.keys(MODEL_OPTIONS).find(key => MODEL_OPTIONS[key] === currentModel));
 const nextIndex = (currentIndex + 1) % MODEL_CHOICES.length;
 state.serverSettings[serverId].model = MODEL_OPTIONS[MODEL_CHOICES[nextIndex]];
 await saveStateToFile();
 await showServerSettings(interaction, true);
}

async function showServerEmbedColorModal(interaction) {
 if (!await ensureAdmin(interaction)) return;
 const currentColor = state.serverSettings[interaction.guild.id].embedColor;
 const input = new TextInputBuilder().setCustomId('embed-color-input').setLabel('Enter HEX Color Code (e.g., FF00FF)').setStyle(TextInputStyle.Short).setPlaceholder(currentColor).setMinLength(6).setMaxLength(7);
 const modal = new ModalBuilder().setCustomId('embed-color-modal-server').setTitle('Set Server Embed Color').addComponents(new ActionRowBuilder().addComponents(input));
 await interaction.showModal(modal);
}

async function serverPersonality(interaction) {
 if (!await ensureAdmin(interaction)) return;
 const input = new TextInputBuilder().setCustomId('custom-personality-input').setLabel("What should the bot's personality be?").setStyle(TextInputStyle.Paragraph).setPlaceholder("Enter the custom server instructions here...").setMinLength(10).setMaxLength(4000);
 const modal = new ModalBuilder().setCustomId('custom-personality-modal-server').setTitle('Enter Custom Server Personality').addComponents(new ActionRowBuilder().addComponents(input));
 await interaction.showModal(modal);
}

async function removeServerPersonality(interaction) {
 if (!await ensureAdmin(interaction)) return;
 delete state.customInstructions[interaction.guild.id];
 await saveStateToFile();
 const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('Removed').setDescription('Custom server personality instructions removed!');
 await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 await showServerSettings(interaction, true);
}

async function clearServerChatHistory(interaction) {
 if (!await ensureAdmin(interaction)) return;
 await chatHistoryLock.runExclusive(async () => {
   delete state.chatHistories[interaction.guild.id];
   await saveStateToFile();
 });
 const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('Chat History Cleared').setDescription('Server-wide conversation history cleared!');
 await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
 await showServerSettings(interaction, true);
}

async function downloadServerConversation(interaction) {
 if (!await ensureAdmin(interaction)) return;
 await interaction.deferReply({ flags: MessageFlags.Ephemeral });
 const guildId = interaction.guild.id;
 const conversationHistory = getHistory(guildId);

 if (!conversationHistory || conversationHistory.length === 0) {
   const noHistoryEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('No History Found').setDescription('No server-wide conversation history found.');
   return interaction.editReply({ embeds: [noHistoryEmbed] });
 }

 let conversationText = conversationHistory.map(entry => {
   const role = entry.role === 'user' ? '[User]' : '[Model]';
   const content = entry.parts.map(c => c.text).join('\n');
   return `${role}:\n${content}\n\n`;
 }).join('');

 const tempFileName = path.join(TEMP_DIR, `server_conversation_${interaction.id}.txt`);
 await fs.writeFile(tempFileName, conversationText, 'utf8');
 const file = new AttachmentBuilder(tempFileName, { name: 'server_conversation_history.txt' });

 try {
   await interaction.user.send({ content: "> `Here's the server-wide conversation history:`", files: [file] });
   const dmSentEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('History Sent').setDescription('Server conversation history has been sent to your DMs.');
   await interaction.editReply({ embeds: [dmSentEmbed], files: [] });
 } catch (error) {
   console.error(`Failed to send DM: ${error}`);
   const failDMEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Delivery Failed').setDescription('Failed to send the conversation history to your DMs. You may have DMs disabled.');
   await interaction.editReply({ embeds: [failDMEmbed], files: [file] });
 } finally {
   await fs.unlink(tempFileName).catch(() => {});
 }
}

// <==========>


// <=====[Main Conversation Logic]=====>

async function handleTextMessage(message) {
 const botId = client.user.id;
 const userId = message.author.id;
 const guildId = message.guild?.id;
 const channelId = message.channel.id;
 let messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

 // Determine effective settings
 const serverSettings = guildId ? state.serverSettings[guildId] : null;
 const override = serverSettings?.overrideUserSettings || false;
 
 const effectiveModel = override ? MODEL_OPTIONS[serverSettings.model] : (MODEL_OPTIONS[getUserModelPreference(userId)] || DEFAULT_MODEL);
 const effectivePersonality = override && state.customInstructions[guildId] ? state.customInstructions[guildId] : (state.customInstructions[userId] || config.defaultPersonality);

 if (messageContent === '' && !(message.attachments.size > 0 && hasSupportedAttachments(message))) {
   if (activeRequests.has(userId)) {
     activeRequests.delete(userId);
   }
   const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle('Empty Message').setDescription("It looks like you didn't say anything. What would you like to talk about?");
   const botMessage = await message.reply({ embeds: [embed] });
   await addSettingsButton(botMessage, userId);
   return;
 }
 
 // Start Typing
 message.channel.sendTyping();
 const typingInterval = setInterval(() => { message.channel.sendTyping(); }, 4000);
 setTimeout(() => { clearInterval(typingInterval); }, 120000);
 
 let botMessage = false;
 let parts;
 let initialReplyNeeded = true;
 
 try {
   if (config.SEND_RETRY_ERRORS_TO_DISCORD) {
     clearInterval(typingInterval);
     const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle('Processing').setDescription(updateEmbedDescription('[🔁]', '[🔁]'));
     botMessage = await message.reply({ embeds: [embed] });
     initialReplyNeeded = false;
     
     messageContent = await extractFileText(message, messageContent);
     embed.setDescription(updateEmbedDescription('[☑️]', '[🔁]'));
     await botMessage.edit({ embeds: [embed] });

     parts = await processPromptAndMediaAttachments(messageContent, message);
     embed.setDescription(updateEmbedDescription('[☑️]', '[☑️]', '### All checks done. Waiting for the response...'));
     await botMessage.edit({ embeds: [embed] });
   } else {
     // Normal processing without step-by-step updates
     messageContent = await extractFileText(message, messageContent);
     parts = await processPromptAndMediaAttachments(messageContent, message);
   }
 } catch (error) {
   console.error('Error initialising message', error);
   if (activeRequests.has(userId)) activeRequests.delete(userId);
   if (typingInterval) clearInterval(typingInterval);
   return;
 }

 // Final Instructions Assembly
 let infoStr = '';
 if (guildId) {
   const userInfo = { username: message.author.username, displayName: message.author.displayName };
   infoStr = `\nYou are currently engaging with users in the ${message.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
 }
 const finalInstructions = effectivePersonality + infoStr;
 
 // Determine History ID (User-Based Persistent Memory)
 const historyId = userId; 

 // Always enable all three tools: Google Search, URL Context, and Code Execution
 const tools = [
   { googleSearch: {} },
   { urlContext: {} },
   { codeExecution: {} }
 ];

 // Create chat with the selected model
 const chat = genAI.chats.create({
   model: effectiveModel,
   config: {
     systemInstruction: {
       role: "system",
       parts: [{ text: finalInstructions }]
     },
     ...generationConfig,
     safetySettings,
     tools
   },
   history: getHistory(historyId)
 });

 await handleModelResponse(botMessage, chat, parts, message, typingInterval, historyId, initialReplyNeeded);
}

// <==========>


// <=====[Model Response Handling]=====>

async function handleModelResponse(initialBotMessage, chat, parts, originalMessage, typingInterval, historyId, initialReplyNeeded) {
 const userId = originalMessage.author.id;
 
 // Determine effective settings
 const serverSettings = originalMessage.guild ? state.serverSettings[originalMessage.guild.id] : null;
 const override = serverSettings?.overrideUserSettings || false;
 
 const userResponsePreference = override ? serverSettings.responseStyle : getUserResponsePreference(userId);
 const continuousReply = override ? serverSettings.continuousReply : getUserContinuousReply(userId);
 const showActionButtons = override ? serverSettings.actionButtons : getUserActionButtons(userId);
 const embedColor = override ? serverSettings.embedColor : getUserEmbedColor(userId);

 const maxCharacterLimit = userResponsePreference === 'Embedded' ? 3900 : 1900;
 let attempts = 3;

 let updateTimeout;
 let tempResponse = '';
 let groundingMetadata = null;
 let urlContextMetadata = null;

 const stopGeneratingButton = new ActionRowBuilder().addComponents(
   new ButtonBuilder().setCustomId('stopGenerating').setLabel('Stop Generating').setStyle(ButtonStyle.Danger)
 );
 
 let botMessage = initialBotMessage;
 let mentionStr = continuousReply ? '' : `<@${userId}>, `;

 if (initialReplyNeeded) {
     clearInterval(typingInterval);
     try {
         // Reply with mention if continuousReply is OFF, otherwise just 'Thinking...'
         botMessage = await originalMessage.reply({
             content: `${mentionStr}Thinking...`,
             components: [stopGeneratingButton]
         });
     } catch (error) {
         console.error('Error sending initial reply:', error);
         if (activeRequests.has(userId)) activeRequests.delete(userId);
         return;
     }
 } else if (botMessage) {
     // If we already replied (due to SEND_RETRY_ERRORS_TO_DISCORD), just update components
     try {
         await botMessage.edit({ components: [stopGeneratingButton] });
     } catch (error) {
         console.error('Error adding stop button to existing message:', error);
     }
 }


 let stopGeneration = false;
 const filter = (interaction) => interaction.customId === 'stopGenerating' && interaction.user.id === userId;
 
 try {
     const collector = botMessage.createMessageComponentCollector({ filter, time: 120000 });
     collector.on('collect', (interaction) => {
         stopGeneration = true;
         collector.stop();
         interaction.reply({
             embeds: [new EmbedBuilder().setColor(0xFFA500).setTitle('Response Stopped').setDescription('Response generation stopped by the user.')],
             flags: MessageFlags.Ephemeral
         });
         // Remove the Stop button immediately
         botMessage.edit({ components: [] }).catch(() => {});
     });
     collector.on('end', () => {
         // If stopped due to time expiration, remove the button
         if (!stopGeneration) {
             botMessage.edit({ components: botMessage.components.map(row => ActionRowBuilder.from(row).setComponents(row.components.filter(c => c.customId !== 'stopGenerating'))) }).catch(() => {});
         }
     });
 } catch (error) {
     console.error('Error creating collector:', error);
 }

 const updateMessage = () => {
   if (stopGeneration) return;
   
   // Clear initial Thinking... message content
   const baseContent = continuousReply ? '' : `<@${userId}>`;
   
   if (tempResponse.trim() === "") {
     botMessage.edit({ content: `${baseContent} ...` }).catch(e => console.error("Error editing message with '...':", e));
   } else if (userResponsePreference === 'Embedded') {
     updateEmbed(botMessage, tempResponse, originalMessage, embedColor, groundingMetadata, urlContextMetadata, baseContent);
   } else {
     botMessage.edit({
       content: `${baseContent} ${tempResponse}`,
       embeds: []
     }).catch(e => console.error("Error editing message in Normal mode:", e));
   }
   clearTimeout(updateTimeout);
   updateTimeout = null;
 };

 while (attempts > 0 && !stopGeneration) {
   try {
     let finalResponse = '';
     let isLargeResponse = false;
     const newHistory = [];
     newHistory.push({ role: 'user', content: parts });
     
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

         // Capture metadata
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
             botMessage.edit({ embeds: [embed] }).catch(() => {});
           }
         } else if (!updateTimeout) {
           updateTimeout = setTimeout(updateMessage, 500);
         }
       }
       
       newHistory.push({ role: 'assistant', content: [{ text: newResponse }] });
     }
     
     await getResponse(parts);

     // Final update to ensure metadata is displayed
     if (!isLargeResponse) {
         const baseContent = continuousReply ? '' : `<@${userId}>`;
         if (userResponsePreference === 'Embedded') {
             updateEmbed(botMessage, finalResponse, originalMessage, embedColor, groundingMetadata, urlContextMetadata, baseContent);
         } else {
             botMessage.edit({ content: `${baseContent} ${finalResponse}`, embeds: [] }).catch(() => {});
         }
     }
     
     // Post-generation actions
     botMessage.edit({ components: [] }).catch(() => {}); // Remove stop button
     
     if (isLargeResponse) {
       sendAsTextFile(finalResponse, originalMessage, botMessage.id);
       botMessage = await addActionButtons(botMessage, botMessage.id, showActionButtons);
     } else {
       botMessage = await addActionButtons(botMessage, botMessage.id, showActionButtons);
     }

     await chatHistoryLock.runExclusive(async () => {
       updateChatHistory(historyId, newHistory, originalMessage.id); // Use original message ID for keying history
       await saveStateToFile();
     });
     break;
   } catch (error) {
     if (activeRequests.has(userId)) activeRequests.delete(userId);
     console.error('Generation Attempt Failed: ', error);
     attempts--;

     if (attempts === 0 || stopGeneration) {
       if (!stopGeneration) {
         const errorMessage = config.SEND_RETRY_ERRORS_TO_DISCORD ? `All Generation Attempts Failed :(\n\`\`\`${error.message}\`\`\`` : 'Something seems off, the bot might be overloaded! :(';
         const embedColor = config.SEND_RETRY_ERRORS_TO_DISCORD ? 0xFF0000 : 0xFFFF00;
         
         const errorEmbed = new EmbedBuilder().setColor(embedColor).setTitle('Bot Error').setDescription(errorMessage);
         
         const errorMsg = await originalMessage.channel.send({
           content: `<@${originalMessage.author.id}>`,
           embeds: [errorEmbed]
         });
         await addSettingsButton(errorMsg, userId);
         if (botMessage) await addSettingsButton(botMessage, userId); // Add setting button to original bot message
       }
       break;
     } else if (config.SEND_RETRY_ERRORS_TO_DISCORD) {
       const errorMsg = await originalMessage.channel.send({
         content: `<@${originalMessage.author.id}>`,
         embeds: [new EmbedBuilder().setColor(0xFFFF00).setTitle('Retry in Progress').setDescription(`Generation Attempt(s) Failed, Retrying..\n\`\`\`${error.message}\`\`\``)]
       });
       setTimeout(() => errorMsg.delete().catch(console.error), 5000);
       await delay(500);
     }
   }
 }
 if (activeRequests.has(userId)) activeRequests.delete(userId);
}

function updateEmbed(botMessage, finalResponse, message, embedColor, groundingMetadata = null, urlContextMetadata = null, baseContent = '') {
 try {
   const isGuild = message.guild !== null;
   const embed = new EmbedBuilder()
     .setColor(embedColor.replace('#', '0x')) // Convert HEX string to Discord compatible number/string
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
       iconURL: message.guild.iconIconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
     });
   }

   botMessage.edit({
     content: baseContent,
     embeds: [embed]
   }).catch(e => console.error("Error editing message embed:", e));
 } catch (error) {
   console.error("An error occurred while updating the embed:", error.message);
 }
}

function addGroundingMetadataToEmbed(embed, groundingMetadata) {
 if (groundingMetadata.webSearchQueries && groundingMetadata.webSearchQueries.length > 0) {
   embed.addFields({
     name: '🔍 Search Queries',
     value: groundingMetadata.webSearchQueries.map(query => `• ${query}`).join('\n'),
     inline: false
   });
 }

 if (groundingMetadata.groundingChunks && groundingMetadata.groundingChunks.length > 0) {
   const chunks = groundingMetadata.groundingChunks
     .slice(0, 5) 
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
 const userId = message.author.id;
 const serverSettings = message.guild ? state.serverSettings[message.guild.id] : null;
 const override = serverSettings?.overrideUserSettings || false;
 
 const userResponsePreference = override ? serverSettings.responseStyle : getUserResponsePreference(userId);
 
 return userResponsePreference === 'Embedded';
}

async function sendAsTextFile(text, message, orgId) {
 try {
   const filename = `response-${Date.now()}.txt`;
   const tempFilePath = path.join(TEMP_DIR, filename);
   await fs.writeFile(tempFilePath, text);

   const botMessage = await message.channel.send({
     content: `<@${message.author.id}>, Here is the response:`,
     files: [tempFilePath]
   });
   
   await addActionButtons(botMessage, orgId, true); // Always add buttons for overflow message
   await fs.unlink(tempFilePath).catch(() => {});
 } catch (error) {
   console.error('An error occurred in sendAsTextFile:', error);
 }
}

// <==========>


// <=====[Action Button Logic]=====>

async function addActionButtons(botMessage, msgId, showActionButtons) {
 if (!showActionButtons) {
     return botMessage;
 }
 
 try {
   const actionRow = new ActionRowBuilder();
   
   const settingsButton = new ButtonBuilder()
     .setCustomId('settings')
     .setEmoji('⚙️')
     .setLabel('Settings')
     .setStyle(ButtonStyle.Secondary);
     
   const downloadButton = new ButtonBuilder()
     .setCustomId('download_message')
     .setLabel('Save')
     .setEmoji('⬇️')
     .setStyle(ButtonStyle.Secondary);
     
   const deleteButton = new ButtonBuilder()
     .setCustomId(`delete_message-${msgId}`)
     .setLabel('Delete')
     .setEmoji('🗑️')
     .setStyle(ButtonStyle.Secondary);

   actionRow.addComponents(settingsButton, downloadButton, deleteButton);
   
   return await botMessage.edit({
     components: [actionRow]
   });
 } catch (error) {
   console.error('Error adding action buttons:', error.message);
   return botMessage;
 }
}

async function addSettingsButton(botMessage, userId) {
 try {
   const actionRow = new ActionRowBuilder().addComponents(
     new ButtonBuilder().setCustomId('settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary)
   );
   // Remove other buttons if they exist, but keep the one row
   return await botMessage.edit({
     components: [actionRow]
   });
 } catch (error) {
   console.log('Error adding settings button (non-critical):', error.message);
   return botMessage;
 }
}

async function downloadMessage(interaction) {
 await interaction.deferReply({ flags: MessageFlags.Ephemeral });
 try {
   const message = interaction.message;
   let textContent = message.content;
   
   // Check for the user's embed content
   if (!textContent && message.embeds.length > 0) {
     textContent = message.embeds[0].description || message.embeds[0].fields?.map(f => `${f.name}:\n${f.value}`).join('\n\n') || 'No readable content in embed.';
   }

   if (!textContent || textContent.trim() === 'No readable content in embed.') {
     const emptyEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Empty Message').setDescription('The message content is empty or unreadable.');
     return interaction.editReply({ embeds: [emptyEmbed] });
   }

   // Upload text for a shareable link
   const msgUrl = await uploadText(textContent);

   const filePath = path.join(TEMP_DIR, `message_content_${interaction.id}.txt`);
   await fs.writeFile(filePath, textContent, 'utf8');

   const attachment = new AttachmentBuilder(filePath, { name: 'message_content.txt' });

   const initialEmbed = new EmbedBuilder()
     .setColor(getUserEmbedColor(interaction.user.id).replace('#', '0x'))
     .setTitle('Message Content Downloaded')
     .setDescription(`Here is the content of the message. ${msgUrl}`);

   try {
       await interaction.user.send({ embeds: [initialEmbed], files: [attachment] });
       const dmSentEmbed = new EmbedBuilder().setColor(0x00FF00).setTitle('Content Sent').setDescription('The message content has been sent to your DMs.');
       await interaction.editReply({ embeds: [dmSentEmbed], files: [] });
   } catch (error) {
       console.error(`Failed to send DM: ${error}`);
       const failDMEmbed = new EmbedBuilder().setColor(0xFF0000).setTitle('Delivery Failed').setDescription(`Failed to send the content to your DMs. Here is the file directly. ${msgUrl}`);
       await interaction.editReply({ embeds: [failDMEmbed], files: [attachment] });
   } finally {
     await fs.unlink(filePath).catch(() => {});
   }
 } catch (error) {
   console.log('Failed to process download: ', error);
   interaction.editReply({ content: 'An unexpected error occurred during the download process.', embeds: [] }).catch(() => {});
 }
}

// <==========>


client.login(token);
