import {
 MessageFlags,
 ActionRowBuilder,
 ButtonBuilder,
 ButtonStyle,
 ChannelType,
 TextInputBuilder,
 TextInputStyle,
 ModalBuilder,
 StringSelectMenuBuilder,
 PermissionsBitField,
 EmbedBuilder,
 AttachmentBuilder,
 ActivityType,
 ComponentType,
 REST,
 Routes,
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
import axios from 'axios';
import express from 'express';

import config from './config.js';
import {
 client,
 genAI,
 createPartFromUri,
 token,
 activeRequests,
 activeSettingsInteractions,
 chatHistoryLock,
 state,
 TEMP_DIR,
 initialize,
 saveStateToFile,
 getHistory,
 updateChatHistory,
 getUserSettings,
 getServerSettings,
 getEffectiveSettings
} from './botManager.js';

import {
 delay,
 retryOperation,
} from './tools/others.js';

initialize().catch(console.error);

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
 res.send('Bot is alive!');
});
app.listen(port, () => {
 console.log(`Express server listening on port ${port}`);
});

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
const defaultPersonality = config.defaultPersonality;
const workInDMs = config.workInDMs;
const SEND_RETRY_ERRORS_TO_DISCORD = config.SEND_RETRY_ERRORS_TO_DISCORD;
const supportedModels = [
   { label: "Gemini 2.5 Flash (Recommended)", value: "gemini-2.5-flash" },
   { label: "Gemini 2.0 Flash", value: "gemini-pro" },
   { label: "Gemini 2.5 Flash Lite (Vision)", value: "gemini-2.5-flash-vision" }
];

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

client.on('messageCreate', async (message) => {
 try {
   if (message.author.bot) return;
   if (message.content.startsWith('!')) return;

   const isDM = message.channel.type === ChannelType.DM;

   const shouldRespond =
     (workInDMs && isDM) ||
     (message.mentions.users.has(client.user.id) && !isDM);

   if (shouldRespond) {
     if (activeRequests.has(message.author.id)) {
       const embed = new EmbedBuilder()
         .setColor(0xFFFF00)
         .setTitle('Request In Progress')
         .setDescription('Please wait until your previous action is complete.');
       await message.reply({
         embeds: [embed]
       });
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
   } else if (interaction.isStringSelectMenu()) {
     await handleSelectMenuInteraction(interaction);
   } else if (interaction.isModalSubmit()) {
     await handleModalSubmit(interaction);
   }
 } catch (error) {
   console.error('Error handling interaction:', error.message);
   if (interaction.deferred || interaction.replied) {
       await interaction.followUp({ content: 'An error occurred while processing your interaction.', ephemeral: true });
   } else {
       await interaction.reply({ content: 'An error occurred while processing your interaction.', ephemeral: true });
   }
 }
});

async function handleCommandInteraction(interaction) {
 if (!interaction.isChatInputCommand()) return;

 const commandHandlers = {
   settings: handleSettingsCommand,
   search: handleSearchCommand,
 };

 const handler = commandHandlers[interaction.commandName];
 if (handler) {
   if (activeRequests.has(interaction.user.id)) {
     const embed = new EmbedBuilder()
       .setColor(0xFFFF00)
       .setTitle('Request In Progress')
       .setDescription('Please wait until your previous action is complete before using commands.');
     return interaction.reply({
       embeds: [embed],
       ephemeral: true
     });
   }
   
   if (interaction.commandName === 'search') {
       activeRequests.add(interaction.user.id);
   }
   
   await handler(interaction);
 } else {
   console.log(`Unknown command: ${interaction.commandName}`);
 }
}

async function handleSearchCommand(interaction) {
   let messageContent = interaction.options.getString('prompt') || '';
   const attachments = [
       interaction.options.getAttachment('attachment1'),
       interaction.options.getAttachment('attachment2'),
       interaction.options.getAttachment('attachment3')
   ].filter(Boolean);

   if (messageContent === '' && attachments.length === 0) {
       if (activeRequests.has(interaction.user.id)) {
           activeRequests.delete(interaction.user.id);
       }
       const embed = new EmbedBuilder()
           .setColor(0x00FFFF)
           .setTitle('Empty Prompt')
           .setDescription("Please provide a prompt or at least one attachment.");
       await interaction.reply({ embeds: [embed], ephemeral: true });
       return;
   }

   const thinkingEmbed = new EmbedBuilder()
       .setColor(0x00FFFF)
       .setTitle('Processing')
       .setDescription('Let me think...');
   
   await interaction.reply({ embeds: [thinkingEmbed] });
   const botMessage = await interaction.fetchReply();
   
   let parts;
   try {
       const updateEmbedDescription = (textAttachmentStatus, mediaAttachmentStatus, finalText) => {
           return `Let me think...\n\n- ${textAttachmentStatus}: Text Attachment Check\n- ${mediaAttachmentStatus}: Media Attachment Check\n${finalText || ''}`;
       };

       const embed = new EmbedBuilder()
           .setColor(0x00FFFF)
           .setTitle('Processing')
           .setDescription(updateEmbedDescription('[🔁]', '[🔁]'));
       await interaction.editReply({ embeds: [embed] });

       messageContent = await extractFileText(attachments, messageContent);
       embed.setDescription(updateEmbedDescription('[☑️]', '[🔁]'));
       await interaction.editReply({ embeds: [embed] });

       parts = await processPromptAndMediaAttachments(messageContent, attachments, interaction.user.id);
       embed.setDescription(updateEmbedDescription('[☑️]', '[☑️]', '### All checks done. Waiting for the response...'));
       await interaction.editReply({ embeds: [embed] });
   } catch (error) {
       console.error('Error initialising message', error);
       const errorEmbed = new EmbedBuilder()
           .setColor(0xFF0000)
           .setTitle('Error')
           .setDescription(`Failed to process attachments: ${error.message}`);
       await interaction.editReply({ embeds: [errorEmbed] });
       if (activeRequests.has(interaction.user.id)) {
           activeRequests.delete(interaction.user.id);
       }
       return;
   }

   const historyId = interaction.user.id;
   const { model, customPersonality } = getEffectiveSettings(interaction.user.id, interaction.guildId);

   let infoStr = '';
   if (interaction.guildId) {
       const userInfo = {
           username: interaction.user.username,
           displayName: interaction.member.displayName
       };
       infoStr = `\nYou are currently engaging with users in the ${interaction.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
   }

   const finalInstructions = (customPersonality || defaultPersonality) + infoStr;

   const tools = [
       { googleSearch: {} },
       { urlContext: {} },
       { codeExecution: {} }
   ];

   const chat = genAI.chats.create({
       model: model,
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

   await handleModelResponse(botMessage, chat, parts, interaction, historyId, true);
}


async function handleTextMessage(message) {
 const botId = client.user.id;
 const userId = message.author.id;
 const guildId = message.guild?.id;
 let messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

 if (messageContent === '' && !(message.attachments.size > 0 && hasSupportedAttachments(message))) {
   if (activeRequests.has(userId)) {
     activeRequests.delete(userId);
   }
   const embed = new EmbedBuilder()
     .setColor(0x00FFFF)
     .setTitle('Empty Message')
     .setDescription("It looks like you didn't say anything. What would you like to talk about?");
   await message.reply({ embeds: [embed] });
   return;
 }
 
 message.channel.sendTyping();
 const typingInterval = setInterval(() => {
   message.channel.sendTyping();
 }, 4000);
 setTimeout(() => {
   clearInterval(typingInterval);
 }, 120000);
 
 let botMessage = false;
 let parts;
 
 try {
   const thinkingEmbed = new EmbedBuilder()
       .setColor(0x00FFFF)
       .setTitle('Processing')
       .setDescription('Let me think...');
   botMessage = await message.reply({ embeds: [thinkingEmbed] });
   
   const updateEmbedDescription = (textAttachmentStatus, mediaAttachmentStatus, finalText) => {
       return `Let me think...\n\n- ${textAttachmentStatus}: Text Attachment Check\n- ${mediaAttachmentStatus}: Media Attachment Check\n${finalText || ''}`;
   };

   const embed = new EmbedBuilder()
       .setColor(0x00FFFF)
       .setTitle('Processing')
       .setDescription(updateEmbedDescription('[🔁]', '[🔁]'));
   await botMessage.edit({ embeds: [embed] });

   const messageAttachments = Array.from(message.attachments.values());
   messageContent = await extractFileText(messageAttachments, messageContent);
   embed.setDescription(updateEmbedDescription('[☑️]', '[🔁]'));
   await botMessage.edit({ embeds: [embed] });

   parts = await processPromptAndMediaAttachments(messageContent, messageAttachments, message.author.id);
   embed.setDescription(updateEmbedDescription('[☑️]', '[☑️]', '### All checks done. Waiting for the response...'));
   await botMessage.edit({ embeds: [embed] });
 } catch (error) {
   console.error('Error initialising message', error);
   clearInterval(typingInterval);
    const errorEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Error')
       .setDescription(`Failed to process attachments: ${error.message}`);
   if (botMessage) {
       await botMessage.edit({ embeds: [errorEmbed] });
   } else {
       await message.reply({ embeds: [errorEmbed] });
   }
   if (activeRequests.has(userId)) {
     activeRequests.delete(userId);
   }
   return;
 }

 const historyId = userId;
 const { model, customPersonality } = getEffectiveSettings(userId, guildId);

 let infoStr = '';
 if (guildId) {
   const userInfo = {
     username: message.author.username,
     displayName: message.author.displayName
   };
   infoStr = `\nYou are currently engaging with users in the ${message.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
 }

 const finalInstructions = (customPersonality || defaultPersonality) + infoStr;

 const tools = [
   { googleSearch: {} },
   { urlContext: {} },
   { codeExecution: {} }
 ];

 const chat = genAI.chats.create({
   model: model,
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

 await handleModelResponse(botMessage, chat, parts, message, historyId, false, typingInterval);
}

function hasSupportedAttachments(message) {
 const supportedFileExtensions = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

 return message.attachments.some((attachment) => {
   const contentType = (attachment.contentType || "").toLowerCase();
   const fileExtension = path.extname(attachment.name) || '';
   return (
     contentType.startsWith('image/') ||
     contentType.startsWith('audio/') ||
     contentType.startsWith('video/') ||
     contentType.startsWith('application/pdf') ||
     contentType.startsWith('application/x-pdf') ||
     supportedFileExtensions.includes(fileExtension)
   );
 });
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

function sanitizeFileName(fileName) {
 return fileName
   .toLowerCase()
   .replace(/[^a-z0-9-.]/g, '-')
   .replace(/^-+|-+$/g, '');
}

async function processPromptAndMediaAttachments(prompt, attachments, userId) {
 let parts = [{
   text: prompt
 }];

 if (attachments.length > 0) {
   const validAttachments = attachments.filter(attachment => {
     const contentType = (attachment.contentType || "").toLowerCase();
     return (
       contentType.startsWith('image/') ||
       contentType.startsWith('audio/') ||
       contentType.startsWith('video/') ||
       contentType.startsWith('application/pdf') ||
       contentType.startsWith('application/x-pdf')
     );
   });

   if (validAttachments.length > 0) {
     const attachmentParts = await Promise.all(
       validAttachments.map(async (attachment) => {
         const sanitizedFileName = sanitizeFileName(attachment.name);
         const uniqueTempFilename = `${userId}-${attachment.id}-${sanitizedFileName}`;
         const filePath = path.join(TEMP_DIR, uniqueTempFilename);

         try {
           await downloadFile(attachment.url, filePath);
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
             let file = await genAI.files.get({ name: name });
             while (file.state === 'PROCESSING') {
               process.stdout.write(".");
               await new Promise((resolve) => setTimeout(resolve, 10_000));
               file = await genAI.files.get({ name: name });
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


async function extractFileText(attachments, messageContent) {
 if (attachments.length > 0) {
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

async function handleSettingsCommand(interaction) {
 const previousMessage = activeSettingsInteractions.get(interaction.user.id);
 if (previousMessage) {
     try {
         await previousMessage.delete();
     } catch (error) {
         console.error('Failed to delete previous settings message:', error);
     }
 }
   
 const embed = new EmbedBuilder()
   .setColor(config.hexColour)
   .setTitle('Bot Settings')
   .setDescription('Select the settings you want to manage. \nYour settings will be applied globally (across all servers and DMs).');

 const buttons = new ActionRowBuilder()
   .addComponents(
     new ButtonBuilder()
       .setCustomId('settings_user')
       .setLabel('User Settings')
       .setStyle(ButtonStyle.Primary)
       .setEmoji('👤'),
     new ButtonBuilder()
       .setCustomId('settings_server')
       .setLabel('Server Settings')
       .setStyle(ButtonStyle.Secondary)
       .setEmoji('🔧')
       .setDisabled(!interaction.inGuild())
   );

 const reply = await interaction.reply({
   embeds: [embed],
   components: [buttons],
   ephemeral: true,
   fetchReply: true
 });

 activeSettingsInteractions.set(interaction.user.id, reply);
}

async function handleButtonInteraction(interaction) {
 const [action, ...params] = interaction.customId.split('_');

 const buttonHandlers = {
   'settings': handleSettingsSubmenu,
   'set': handleSetSetting,
   'toggle': handleToggleSetting,
   'clear': handleClearSetting,
   'download': handleDownloadHistory,
   'delete': handleDeleteMessageInteraction
 };

 const handler = buttonHandlers[action];
 if (handler) {
   await handler(interaction, params);
 }
}

async function handleSelectMenuInteraction(interaction) {
   const [action, type, setting] = interaction.customId.split('_');

   if (action === 'set' && setting === 'model') {
       const selectedModel = interaction.values[0];
       const scope = (type === 'user') ? getUserSettings(interaction.user.id) : getServerSettings(interaction.guildId);
       scope.model = selectedModel;
       await saveStateToFile();

       const embed = new EmbedBuilder()
           .setColor(0x00FF00)
           .setDescription(`✅ Model set to **${selectedModel}**.`);
       await interaction.reply({ embeds: [embed], ephemeral: true });
       
       setTimeout(async () => {
           try {
               await interaction.deleteReply();
           } catch (error) {
               console.error("Failed to delete model set confirmation:", error);
           }
       }, 3000);

       if (type === 'user') {
           await showUserSettings(interaction, true);
       } else {
           await showServerSettings(interaction, true);
       }
   }
}

async function handleModalSubmit(interaction) {
   const [action, type, setting] = interaction.customId.split('_');
   let value;

   try {
       if (setting === 'personality') {
           value = interaction.fields.getTextInputValue('custom_personality_input');
       } else if (setting === 'color') {
           value = interaction.fields.getTextInputValue('custom_color_input');
           if (!/^#[0-9A-F]{6}$/i.test(value)) {
               const errorEmbed = new EmbedBuilder()
                   .setColor(0xFF0000)
                   .setDescription('❌ Invalid HEX color. Please use a format like `#FF5733`.');
               await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
               return;
           }
       } else {
           return;
       }

       const scope = (type === 'user') ? getUserSettings(interaction.user.id) : getServerSettings(interaction.guildId);
       
       if (setting === 'personality') {
           scope.customPersonality = value.trim();
       } else if (setting === 'color') {
           scope.responseColor = value;
       }

       await saveStateToFile();

       const successEmbed = new EmbedBuilder()
           .setColor(0x00FF00)
           .setDescription(`✅ ${setting === 'personality' ? 'Custom personality' : 'Response color'} saved!`);
       await interaction.reply({ embeds: [successEmbed], ephemeral: true });

       setTimeout(async () => {
           try {
               await interaction.deleteReply();
           } catch (error) {
               console.error("Failed to delete modal success confirmation:", error);
           }
       }, 3000);

       if (type === 'user') {
           await showUserSettings(interaction, true);
       } else {
           await showServerSettings(interaction, true);
       }

   } catch (error) {
       console.error('Error handling modal submit:', error);
       const errorEmbed = new EmbedBuilder()
           .setColor(0xFF0000)
           .setDescription('❌ An error occurred while saving your settings.');
       if (!interaction.replied) {
           await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
       }
   }
}


async function handleSettingsSubmenu(interaction, params) {
 const type = params[0];
 if (type === 'user') {
   await showUserSettings(interaction, false);
 } else if (type === 'server') {
   if (!interaction.inGuild()) {
     const errorEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setDescription('Server settings can only be managed within a server.');
     return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
   }
   if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
     const errorEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setDescription('You must have the "Manage Server" permission to access these settings.');
     return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
   }
   await showServerSettings(interaction, false);
 }
}

async function createSettingsEmbed(title, description, settings, type) {
   const embed = new EmbedBuilder()
       .setColor(settings.responseColor || config.hexColour)
       .setTitle(title)
       .setDescription(description)
       .addFields(
           { name: 'Model', value: settings.model, inline: true },
           { name: 'Continuous Reply', value: settings.continuousReply ? 'On' : 'Off', inline: true },
           { name: 'Response Format', value: settings.responseFormat, inline: true },
           { name: 'Response Color', value: settings.responseColor, inline: true },
           { name: 'Show Action Buttons', value: settings.showActionButtons ? 'On' : 'Off', inline: true },
           { name: 'Custom Personality', value: settings.customPersonality ? 'Set' : 'Not Set', inline: true }
       );
   
   if (type === 'server') {
       embed.addFields({ name: 'Override User Settings', value: settings.overrideUserSettings ? 'On' : 'Off', inline: true });
   }

   return embed;
}

async function createSettingsComponents(settings, type) {
   const modelOptions = supportedModels.map(model => ({
       label: model.label,
       value: model.value,
       default: settings.model === model.value
   }));

   const modelSelector = new ActionRowBuilder()
       .addComponents(
           new StringSelectMenuBuilder()
               .setCustomId(`set_${type}_model`)
               .setPlaceholder('Select a Model')
               .setOptions(modelOptions)
       );

   const toggles = new ActionRowBuilder()
       .addComponents(
           new ButtonBuilder()
               .setCustomId(`toggle_${type}_continuousReply`)
               .setLabel('Continuous Reply')
               .setStyle(settings.continuousReply ? ButtonStyle.Success : ButtonStyle.Danger)
               .setEmoji(settings.continuousReply ? '✅' : '❌'),
           new ButtonBuilder()
               .setCustomId(`toggle_${type}_responseFormat`)
               .setLabel('Format: ' + settings.responseFormat)
               .setStyle(settings.responseFormat === 'Embedded' ? ButtonStyle.Primary : ButtonStyle.Secondary)
               .setEmoji('📝'),
           new ButtonBuilder()
               .setCustomId(`toggle_${type}_showActionButtons`)
               .setLabel('Action Buttons')
               .setStyle(settings.showActionButtons ? ButtonStyle.Success : ButtonStyle.Danger)
               .setEmoji(settings.showActionButtons ? '✅' : '❌')
       );

   const personality = new ActionRowBuilder()
       .addComponents(
           new ButtonBuilder()
               .setCustomId(`set_${type}_personality`)
               .setLabel('Set Personality')
               .setStyle(ButtonStyle.Primary)
               .setEmoji('👤'),
           new ButtonBuilder()
               .setCustomId(`clear_${type}_personality`)
               .setLabel('Clear Personality')
               .setStyle(ButtonStyle.Danger)
               .setEmoji('🗑️')
               .setDisabled(!settings.customPersonality),
           new ButtonBuilder()
               .setCustomId(`set_${type}_color`)
               .setLabel('Set Color')
               .setStyle(ButtonStyle.Secondary)
               .setEmoji('🎨')
       );

   const history = new ActionRowBuilder()
       .addComponents(
           new ButtonBuilder()
               .setCustomId(`clear_${type}_history`)
               .setLabel('Clear History')
               .setStyle(ButtonStyle.Danger)
               .setEmoji('🧹'),
           new ButtonBuilder()
               .setCustomId(`download_${type}_history`)
               .setLabel('Download History')
               .setStyle(ButtonStyle.Secondary)
               .setEmoji('🗃️')
       );

   const components = [modelSelector, toggles, personality, history];
   
   if (type === 'server') {
       const serverToggle = new ActionRowBuilder()
           .addComponents(
               new ButtonBuilder()
                   .setCustomId(`toggle_server_overrideUserSettings`)
                   .setLabel('Override User Settings')
                   .setStyle(settings.overrideUserSettings ? ButtonStyle.Success : ButtonStyle.Danger)
                   .setEmoji(settings.overrideUserSettings ? '✅' : '❌')
           );
       components.push(serverToggle);
   }

   return components;
}

async function showUserSettings(interaction, isUpdate = false) {
   const settings = getUserSettings(interaction.user.id);
   const embed = await createSettingsEmbed('👤 User Settings', 'Manage your global bot settings.', settings, 'user');
   const components = await createSettingsComponents(settings, 'user');
   
   const payload = { embeds: [embed], components: components, ephemeral: true };
   
   if (isUpdate) {
       await interaction.update(payload);
   } else {
       await interaction.reply(payload);
   }
   activeSettingsInteractions.set(interaction.user.id, await interaction.fetchReply());
}

async function showServerSettings(interaction, isUpdate = false) {
   const settings = getServerSettings(interaction.guildId);
   const embed = await createSettingsEmbed('🔧 Server Settings', 'Manage settings for this server. Requires "Manage Server" permission.', settings, 'server');
   const components = await createSettingsComponents(settings, 'server');

   const payload = { embeds: [embed], components: components, ephemeral: true };

   if (isUpdate) {
       await interaction.update(payload);
   } else {
       await interaction.reply(payload);
   }
   activeSettingsInteractions.set(interaction.user.id, await interaction.fetchReply());
}

async function handleSetSetting(interaction, params) {
   const [type, setting] = params;
   let modal;

   if (setting === 'personality') {
       const scope = (type === 'user') ? getUserSettings(interaction.user.id) : getServerSettings(interaction.guildId);
       modal = new ModalBuilder()
           .setCustomId(`set_${type}_personality`)
           .setTitle(`Set ${type === 'user' ? 'User' : 'Server'} Personality`)
           .addComponents(
               new ActionRowBuilder().addComponents(
                   new TextInputBuilder()
                       .setCustomId('custom_personality_input')
                       .setLabel('Custom Personality Instructions')
                       .setStyle(TextInputStyle.Paragraph)
                       .setPlaceholder('Enter the custom instructions here...')
                       .setValue(scope.customPersonality || '')
                       .setMaxLength(4000)
                       .setRequired(true)
               )
           );
   } else if (setting === 'color') {
       const scope = (type === 'user') ? getUserSettings(interaction.user.id) : getServerSettings(interaction.guildId);
       modal = new ModalBuilder()
           .setCustomId(`set_${type}_color`)
           .setTitle(`Set ${type === 'user' ? 'User' : 'Server'} Response Color`)
           .addComponents(
               new ActionRowBuilder().addComponents(
                   new TextInputBuilder()
                       .setCustomId('custom_color_input')
                       .setLabel('HEX Color Code')
                       .setStyle(TextInputStyle.Short)
                       .setPlaceholder('#505050')
                       .setValue(scope.responseColor || '#505050')
                       .setMaxLength(7)
                       .setMinLength(7)
                       .setRequired(true)
               )
           );
   }

   if (modal) {
       await interaction.showModal(modal);
   }
}

async function handleToggleSetting(interaction, params) {
   const [type, setting] = params;
   const scope = (type === 'user') ? getUserSettings(interaction.user.id) : getServerSettings(interaction.guildId);

   if (setting === 'responseFormat') {
       scope.responseFormat = scope.responseFormat === 'Embedded' ? 'Normal' : 'Embedded';
   } else {
       scope[setting] = !scope[setting];
   }
   
   await saveStateToFile();

   if (type === 'user') {
       await showUserSettings(interaction, true);
   } else {
       await showServerSettings(interaction, true);
       if (setting === 'overrideUserSettings' && scope.overrideUserSettings) {
            const overrideEmbed = new EmbedBuilder()
               .setColor(0xFFA500)
               .setDescription('⚠️ Server settings are now overriding your personal settings in this server.');
           await interaction.followUp({ embeds: [overrideEmbed], ephemeral: true });
       }
   }
}

async function handleClearSetting(interaction, params) {
   const [type, setting] = params;
   const scope = (type === 'user') ? getUserSettings(interaction.user.id) : getServerSettings(interaction.guildId);
   let confirmation = 'Cleared!';

   if (setting === 'personality') {
       scope.customPersonality = null;
       confirmation = '✅ Custom personality cleared.';
   } else if (setting === 'history') {
       const historyId = (type === 'user') ? interaction.user.id : interaction.guildId;
       state.chatHistories[historyId] = {};
       confirmation = '✅ Chat history cleared.';
   }

   await saveStateToFile();

   const embed = new EmbedBuilder()
       .setColor(0x00FF00)
       .setDescription(confirmation);
   await interaction.reply({ embeds: [embed], ephemeral: true });
   
   setTimeout(async () => {
       try {
           await interaction.deleteReply();
       } catch (error) {
           console.error("Failed to delete clear confirmation:", error);
       }
   }, 3000);

   if (type === 'user') {
       await showUserSettings(interaction, true);
   } else {
       await showServerSettings(interaction, true);
   }
}

async function handleDownloadHistory(interaction, params) {
   const type = params[0];
   const historyId = (type === 'user') ? interaction.user.id : interaction.guildId;
   const conversationHistory = getHistory(historyId);

   if (!conversationHistory || conversationHistory.length === 0) {
     const noHistoryEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('No History Found')
       .setDescription(`No ${type} conversation history found.`);
     await interaction.reply({
       embeds: [noHistoryEmbed],
       ephemeral: true
     });
     return;
   }

   let conversationText = conversationHistory.map(entry => {
     const role = entry.role === 'user' ? '[User]' : '[Model]';
     const content = entry.parts.map(c => c.text).join('\n');
     return `${role}:\n${content}\n\n`;
   }).join('');

   const tempFileName = path.join(TEMP_DIR, `${type}_conversation_${interaction.id}.txt`);
   await fs.writeFile(tempFileName, conversationText, 'utf8');

   const file = new AttachmentBuilder(tempFileName, {
     name: `${type}_conversation_history.txt`
   });

   try {
       await interaction.user.send({
           content: `> \`Here's your ${type} conversation history:\``,
           files: [file]
       });
       const dmSentEmbed = new EmbedBuilder()
           .setColor(0x00FF00)
           .setTitle('History Sent')
           .setDescription(`Your ${type} conversation history has been sent to your DMs.`);
       await interaction.reply({
           embeds: [dmSentEmbed],
           ephemeral: true
       });
   } catch (error) {
       console.error(`Failed to send DM: ${error}`);
       const failDMEmbed = new EmbedBuilder()
           .setColor(0xFF0000)
           .setTitle('Delivery Failed')
           .setDescription(`Failed to send the ${type} conversation history to your DMs.`);
       await interaction.reply({
           embeds: [failDMEmbed],
           files: [file],
           ephemeral: true
       });
   } finally {
       await fs.unlink(tempFileName);
   }
}

async function handleDeleteMessageInteraction(interaction, params) {
   const msgId = params[0];
   const userId = interaction.user.id;
   const userChatHistory = state.chatHistories[userId];

   if (!msgId) {
       try {
           await interaction.message.delete();
       } catch (error) {
           console.error('Failed to delete message:', error);
           await interaction.reply({ content: 'Could not delete message.', ephemeral: true });
       }
       return;
   }

   let messageToDelete;
   try {
       messageToDelete = await interaction.channel.messages.fetch(msgId);
   } catch (error) {
       console.error("Failed to fetch message for deletion:", error);
   }

   let canDelete = false;

   if (userChatHistory && userChatHistory[msgId]) {
       delete userChatHistory[msgId];
       canDelete = true;
   } else if (messageToDelete && messageToDelete.reference) {
       try {
           const repliedToMessage = await interaction.channel.messages.fetch(messageToDelete.reference.messageId);
           if (repliedToMessage.author.id === userId) {
               canDelete = true;
           }
       } catch (error) {
           console.error("Failed to fetch replied-to message:", error);
       }
   } else if (messageToDelete && messageToDelete.interaction?.user.id === userId) {
        canDelete = true;
   }

   if (canDelete) {
       try {
           await interaction.message.delete();
           if (messageToDelete) {
               await messageToDelete.delete();
           }
       } catch (error) {
           console.error('Error during message deletion:', error);
       }
   } else {
       const embed = new EmbedBuilder()
           .setColor(0xFF0000)
           .setTitle('Not For You')
           .setDescription('This button is not meant for you.');
       return interaction.reply({
           embeds: [embed],
           ephemeral: true
       });
   }
}

async function downloadMessage(interaction, msgId) {
 try {
   const message = await interaction.channel.messages.fetch(msgId);
   let textContent = message.content;
   
   if (!textContent && message.embeds.length > 0) {
     textContent = message.embeds[0].description;
   }

   if (!textContent) {
     const emptyEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Empty Message')
       .setDescription('The message content is empty.');
     await interaction.reply({
       embeds: [emptyEmbed],
       ephemeral: true
     });
     return;
   }

   const filePath = path.join(TEMP_DIR, `message_content_${interaction.id}.txt`);
   await fs.writeFile(filePath, textContent, 'utf8');

   const attachment = new AttachmentBuilder(filePath, {
     name: 'message_content.txt'
   });

   const initialEmbed = new EmbedBuilder()
     .setColor(0xFFFFFF)
     .setTitle('Message Content')
     .setDescription(`Here is the content of the message.`);

   let response;
   try {
     response = await interaction.user.send({
       embeds: [initialEmbed],
       files: [attachment]
     });
     const dmSentEmbed = new EmbedBuilder()
       .setColor(0x00FF00)
       .setTitle('Content Sent')
       .setDescription('The message content has been sent to your DMs.');
     await interaction.reply({
       embeds: [dmSentEmbed],
       ephemeral: true
     });
   } catch (error) {
     console.error(`Failed to send DM: ${error}`);
     const failDMEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Delivery Failed')
       .setDescription('Failed to send the content to your DMs.');
     response = await interaction.reply({
       embeds: [failDMEmbed],
       files: [attachment],
       ephemeral: true,
       fetchReply: true
     });
   }

   await fs.unlink(filePath);

   const msgUrl = await uploadText(textContent);
   const updatedEmbed = EmbedBuilder.from(response.embeds[0])
     .setDescription(`Here is the content of the message.\n${msgUrl}`);

   await response.edit({
       embeds: [updatedEmbed]
   });

 } catch (error) {
   console.log('Failed to process download: ', error);
    const failEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('Error')
       .setDescription('Failed to download message content.');
   if(!interaction.replied) {
       await interaction.reply({ embeds: [failEmbed], ephemeral: true });
   }
 }
}

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

async function handleModelResponse(botMessage, chat, parts, messageOrInteraction, historyId, isInteraction, typingInterval = null) {
 const isInteractionResponse = isInteraction;
 const author = isInteractionResponse ? messageOrInteraction.user : messageOrInteraction.author;
 const channel = isInteractionResponse ? messageOrInteraction.channel : messageOrInteraction.channel;
 const guildId = isInteractionResponse ? messageOrInteraction.guildId : messageOrInteraction.guild?.id;

 const { responseFormat, responseColor, continuousReply, showActionButtons } = getEffectiveSettings(author.id, guildId);
 const maxCharacterLimit = responseFormat === 'Embedded' ? 3900 : 1900;
 let attempts = 3;

 let updateTimeout;
 let tempResponse = '';
 let groundingMetadata = null;
 let urlContextMetadata = null;

 const stopGeneratingButton = new ActionRowBuilder()
   .addComponents(
     new ButtonBuilder()
     .setCustomId('stopGenerating')
     .setLabel('Stop Generating')
     .setStyle(ButtonStyle.Danger)
   );
 
 try {
     if (isInteractionResponse) {
       await messageOrInteraction.editReply({ components: [stopGeneratingButton] });
     } else {
       await botMessage.edit({ components: [stopGeneratingButton] });
     }
 } catch (error) {
     console.error("Failed to add stop button:", error);
 }

 let stopGeneration = false;
 const filter = (interaction) => interaction.customId === 'stopGenerating';
 try {
   const collector = await botMessage.createMessageComponentCollector({
     filter,
     time: 120000
   });
   collector.on('collect', (interaction) => {
     if (interaction.user.id === author.id) {
       try {
         const embed = new EmbedBuilder()
           .setColor(0xFFA500)
           .setTitle('Response Stopped')
           .setDescription('Response generation stopped by the user.');

         interaction.reply({
           embeds: [embed],
           ephemeral: true
         });
       } catch (error) {
         console.error('Error sending reply:', error);
       }
       stopGeneration = true;
     } else {
       try {
         const embed = new EmbedBuilder()
           .setColor(0xFF0000)
           .setTitle('Access Denied')
           .setDescription("It's not for you.");

         interaction.reply({
           embeds: [embed],
           ephemeral: true
         });
       } catch (error) {
         console.error('Error sending unauthorized reply:', error);
       }
     }
   });
 } catch (error) {
   console.error('Error creating or handling collector:', error);
 }

 const updateMessage = () => {
   if (stopGeneration) {
     return;
   }
   const content = continuousReply ? null : (isInteractionResponse ? `<@${author.id}>` : null);
   
   if (tempResponse.trim() === "") {
       if (isInteractionResponse) {
           messageOrInteraction.editReply({ content: '...', embeds: [] });
       } else {
           botMessage.edit({ content: '...', embeds: [] });
       }
   } else if (responseFormat === 'Embedded') {
     updateEmbed(botMessage, tempResponse, messageOrInteraction, groundingMetadata, urlContextMetadata, isInteractionResponse);
   } else {
       if (isInteractionResponse) {
           messageOrInteraction.editReply({ content: `${content || ''} ${tempResponse}`, embeds: [] });
       } else {
           botMessage.edit({ content: `${content || ''} ${tempResponse}`, embeds: [] });
       }
   }
   clearTimeout(updateTimeout);
   updateTimeout = null;
 };

 while (attempts > 0 && !stopGeneration) {
   try {
     if (typingInterval) clearInterval(typingInterval);
     let finalResponse = '';
     let isLargeResponse = false;
     const newHistory = [];
     newHistory.push({
       role: 'user',
       content: parts
     });
     
     async function getResponse(parts) {
       let newResponse = '';
       const messageResult = await chat.sendMessageStream({
         message: parts
       });
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
             const embed = new EmbedBuilder()
               .setColor(0xFFFF00)
               .setTitle('Response Overflow')
               .setDescription('The response is very long. It will be sent as a text file once generation is complete.');

             if (isInteractionResponse) {
                 await messageOrInteraction.editReply({ embeds: [embed] });
             } else {
                 await botMessage.edit({ embeds: [embed] });
             }
           }
         } else if (!updateTimeout) {
           updateTimeout = setTimeout(updateMessage, 500);
         }
       }
       newHistory.push({
         role: 'assistant',
         content: [{
           text: newResponse
         }]
       });
     }
     await getResponse(parts);

     clearTimeout(updateTimeout);
     updateTimeout = null;
     
     if (!isLargeResponse) {
         if (responseFormat === 'Embedded') {
             updateEmbed(botMessage, finalResponse, messageOrInteraction, groundingMetadata, urlContextMetadata, isInteractionResponse);
         } else {
             const content = continuousReply ? null : (isInteractionResponse ? `<@${author.id}>` : null);
             if (isInteractionResponse) {
                 await messageOrInteraction.editReply({ content: `${content || ''} ${finalResponse}`, embeds: [] });
             } else {
                 await botMessage.edit({ content: `${content || ''} ${finalResponse}`, embeds: [] });
             }
         }
     }

     if (isLargeResponse) {
       await sendAsTextFile(finalResponse, messageOrInteraction, botMessage.id, isInteractionResponse);
     } else if (showActionButtons) {
       await addActionButtons(botMessage, botMessage.id, isInteractionResponse, messageOrInteraction);
     } else {
         if (isInteractionResponse) {
             await messageOrInteraction.editReply({ components: [] });
         } else {
             await botMessage.edit({ components: [] });
         }
     }

     await chatHistoryLock.runExclusive(async () => {
       updateChatHistory(historyId, newHistory, botMessage.id);
       await saveStateToFile();
     });
     break;
   } catch (error) {
     if (activeRequests.has(author.id)) {
       activeRequests.delete(author.id);
     }
     if (typingInterval) clearInterval(typingInterval);
     console.error('Generation Attempt Failed: ', error);
     attempts--;

     if (attempts === 0 || stopGeneration) {
       if (!stopGeneration) {
         const errorEmbed = new EmbedBuilder()
             .setColor(0xFF0000)
             .setTitle('Generation Failure')
             .setDescription(`All generation attempts failed :(\n\`\`\`${error.message}\`\`\``);
         if (SEND_RETRY_ERRORS_TO_DISCORD) {
             await channel.send({
                 content: `<@${author.id}>`,
                 embeds: [errorEmbed]
             });
         } else {
             if (isInteractionResponse) {
                 await messageOrInteraction.editReply({ content: ' ', embeds: [errorEmbed], components: [] });
             } else {
                 await botMessage.edit({ content: ' ', embeds: [errorEmbed], components: [] });
             }
         }
       }
       break;
     } else if (SEND_RETRY_ERRORS_TO_DISCORD) {
       const errorMsg = await channel.send({
         content: `<@${author.id}>`,
         embeds: [new EmbedBuilder()
           .setColor(0xFFFF00)
           .setTitle('Retry in Progress')
           .setDescription(`Generation attempt(s) failed, retrying...\n\`\`\`${error.message}\`\`\``)
         ]
       });
       setTimeout(() => errorMsg.delete().catch(console.error), 5000);
       await delay(500);
     }
   }
 }
 if (activeRequests.has(author.id)) {
   activeRequests.delete(author.id);
 }
}

function updateEmbed(botMessage, finalResponse, messageOrInteraction, groundingMetadata = null, urlContextMetadata = null, isInteraction) {
 try {
   const author = isInteraction ? messageOrInteraction.user : messageOrInteraction.author;
   const member = isInteraction ? messageOrInteraction.member : messageOrInteraction.member;
   const guild = isInteraction ? messageOrInteraction.guild : messageOrInteraction.guild;
   
   const { responseColor, continuousReply } = getEffectiveSettings(author.id, guild?.id);

   const embed = new EmbedBuilder()
     .setColor(responseColor)
     .setDescription(finalResponse)
     .setAuthor({
       name: `To ${member?.displayName || author.displayName}`,
       iconURL: author.displayAvatarURL()
     })
     .setTimestamp();

   if (shouldShowGroundingMetadata(author.id, guild?.id)) {
       if (groundingMetadata) {
           addGroundingMetadataToEmbed(embed, groundingMetadata);
       }
       if (urlContextMetadata) {
           addUrlContextMetadataToEmbed(embed, urlContextMetadata);
       }
   }

   if (guild) {
     embed.setFooter({
       text: guild.name,
       iconURL: guild.iconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
     });
   }
   
   const content = continuousReply ? ' ' : (isInteraction ? `<@${author.id}>` : null);

   if (isInteraction) {
       messageOrInteraction.editReply({ content: content, embeds: [embed] });
   } else {
       botMessage.edit({ content: content, embeds: [embed] });
   }
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

function shouldShowGroundingMetadata(userId, guildId) {
 const { responseFormat } = getEffectiveSettings(userId, guildId);
 return responseFormat === 'Embedded';
}

async function sendAsTextFile(text, messageOrInteraction, orgId, isInteraction) {
 const author = isInteraction ? messageOrInteraction.user : messageOrInteraction.author;
 const channel = isInteraction ? messageOrInteraction.channel : messageOrInteraction.channel;
 
 try {
   const filename = `response-${Date.now()}.txt`;
   const tempFilePath = path.join(TEMP_DIR, filename);
   await fs.writeFile(tempFilePath, text);

   const botMessage = await channel.send({
     content: `<@${author.id}>, Here is the response:`,
     files: [tempFilePath]
   });
   
   const { showActionButtons } = getEffectiveSettings(author.id, isInteraction ? messageOrInteraction.guildId : messageOrInteraction.guild?.id);
   
   if (showActionButtons) {
       await addActionButtons(botMessage, orgId, false, null);
   }

   await fs.unlink(tempFilePath);
 } catch (error) {
   console.error('An error occurred:', error);
 }
}

async function addActionButtons(botMessage, msgId, isInteraction, interaction) {
 try {
   const actionRow = new ActionRowBuilder()
       .addComponents(
           new ButtonBuilder()
               .setCustomId(`download_message_${msgId}`)
               .setLabel('Save')
               .setEmoji('⬇️')
               .setStyle(ButtonStyle.Secondary),
           new ButtonBuilder()
               .setCustomId(`delete_message_${msgId}`)
               .setLabel('Delete')
               .setEmoji('🗑️')
               .setStyle(ButtonStyle.Danger)
       );
       
   if (isInteraction) {
       await interaction.editReply({ components: [actionRow] });
   } else {
       await botMessage.edit({ components: [actionRow] });
   }
 } catch (error) {
   console.error('Error adding action buttons:', error.message);
 }
}


client.login(token);
