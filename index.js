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
 ModalSubmitInteraction,
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
 token,
 activeRequests,
 chatHistoryLock,
 state,
 TEMP_DIR,
 initialize,
 saveStateToFile,
 getHistory,
 updateChatHistory,
 getUserSettings,
 getServerSettings
} from './botManager.js';

initialize().catch(console.error);

const app = express();
const port = 3000;

app.get('/', (req, res) => {
 res.send('Bot is running!');
});

app.listen(port, () => {
 console.log(`Server is listening on port ${port}`);
});


// <=====[Configuration]=====>

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
};

const hexColour = config.hexColour;
const activities = config.activities.map(activity => ({
 name: activity.name,
 type: ActivityType[activity.type]
}));
const defaultPersonality = config.defaultPersonality;
const SEND_RETRY_ERRORS_TO_DISCORD = config.SEND_RETRY_ERRORS_TO_DISCORD;



import {
 delay
} from './others.js';

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

   const userSettings = getUserSettings(message.author.id);

   const shouldRespond =
     (message.channel.type === ChannelType.DM) ||
     (message.mentions.users.has(client.user.id)) ||
     (userSettings.continuousReply);


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

client.on('messageUpdate', async (oldMessage, newMessage) => {
   if (newMessage.author.bot) return;

   const timeDiff = (new Date() - newMessage.createdAt) / (1000 * 60);
   if (timeDiff > 10) return;

   const userHistory = state.chatHistories[newMessage.author.id];
   if (!userHistory) return;

   const repliedMessage = Object.values(userHistory).flat().find(entry => entry.userMessageId === newMessage.id);
   if (repliedMessage) {
       await handleTextMessage(newMessage, repliedMessage.botMessageId);
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
 }
});

async function handleCommandInteraction(interaction) {
 if (!interaction.isChatInputCommand()) return;

 const commandHandlers = {
   settings: showSettings,
   imagine: handleImagineCommand,
   search: handleSearchCommand,
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

 const buttonHandlers = {
   'user-settings': showUserSettings,
   'server-settings': showServerSettings,
   'clear-history': handleClearHistory,
   'continuous-reply': toggleContinuousReply,
   'response-format': toggleResponseFormat,
   'custom-embed-color': handleCustomEmbedColor,
   'action-buttons': toggleActionButtons,
   'user-custom-personality': handleUserCustomPersonality,
   'server-continuous-reply': toggleServerContinuousReply,
   'server-response-format': toggleServerResponseFormat,
   'server-action-buttons': toggleServerActionButtons,
   'server-custom-personality': handleServerCustomPersonality,
   'override-user-settings': toggleOverrideUserSettings,
   'shared-server-history': toggleSharedServerHistory,
 };

 const handler = buttonHandlers[interaction.customId];
 if (handler) {
     await handler(interaction);
     return;
 }


 if (interaction.customId.startsWith('delete_message-')) {
   const msgId = interaction.customId.replace('delete_message-', '');
   await handleDeleteMessageInteraction(interaction, msgId);
 } else if(interaction.customId.startsWith('save_message-')) {
   const msgId = interaction.customId.replace('save_message-', '');
   await handleSaveMessageInteraction(interaction, msgId);
 }
}


async function handleSelectMenuInteraction(interaction) {
   if (!interaction.isStringSelectMenu()) return;

   if (interaction.customId === 'user-model-select') {
       const userId = interaction.user.id;
       state.userSettings[userId].model = interaction.values[0];
       await showUserSettings(interaction, true);
   } else if (interaction.customId === 'server-model-select') {
       if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
           return interaction.reply({ content: 'You do not have permission to change this setting.', ephemeral: true });
       }
       const guildId = interaction.guild.id;
       state.serverSettings[guildId].model = interaction.values[0];
       await showServerSettings(interaction, true);
   }
}

async function handleDeleteMessageInteraction(interaction, msgId) {
   try {
       const message = await interaction.channel.messages.fetch(msgId);
       if (message.author.id === client.user.id) {
           await message.delete();
           await interaction.reply({ content: 'Message deleted.', ephemeral: true });
       } else {
           await interaction.reply({ content: 'I can only delete my own messages.', ephemeral: true });
       }
   } catch (error) {
       console.error('Error deleting message:', error);
       await interaction.reply({ content: 'Could not delete the message.', ephemeral: true });
   }
}

async function handleSaveMessageInteraction(interaction, msgId) {
   try {
       const message = await interaction.channel.messages.fetch(msgId);
       const content = message.content || message.embeds[0]?.description;
       if (content) {
           await interaction.user.send(`**Saved Message from ${interaction.guild?.name || 'DMs'}:**\n>>> ${content}`);
           await interaction.reply({ content: 'Message saved to your DMs!', ephemeral: true });
       } else {
           await interaction.reply({ content: 'Could not save the message.', ephemeral: true });
       }
   } catch (error) {
       console.error('Error saving message:', error);
       await interaction.reply({ content: 'Failed to save the message.', ephemeral: true });
   }
}


// <==========>



// <=====[Messages Handling]=====>

async function handleTextMessage(message, existingBotMessageId = null) {
 const botId = client.user.id;
 const userId = message.author.id;
 const guildId = message.guild?.id;
 const messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

 if (messageContent === '' && message.attachments.size === 0) {
     if (activeRequests.has(userId)) activeRequests.delete(userId);
     return;
 }

 const typingInterval = setInterval(() => message.channel.sendTyping(), 5000);
 
 try {
   const parts = await processAttachments(message, messageContent);
   const serverSettings = guildId ? getServerSettings(guildId) : null;
   const userSettings = getUserSettings(userId);
   
   const useServerHistory = serverSettings?.sharedHistory;
   const historyId = useServerHistory ? guildId : userId;
   const history = getHistory(historyId);

   const modelSettings = (serverSettings?.overrideUserSettings) ? serverSettings : userSettings;

   const model = genAI.getGenerativeModel({ model: modelSettings.model, safetySettings, generationConfig });
   
   let instructions = defaultPersonality;
   if(serverSettings?.overrideUserSettings && serverSettings.customPersonality) {
       instructions = serverSettings.customPersonality;
   } else if (userSettings.customPersonality) {
       instructions = userSettings.customPersonality;
   }
   
   const chat = model.startChat({ 
       history,
       systemInstruction: instructions,
   });

   await handleModelResponse(chat, parts, message, typingInterval, historyId, existingBotMessageId);

 } catch (error) {
     console.error("Error in handleTextMessage:", error);
     const errorEmbed = new EmbedBuilder()
       .setColor(0xFF0000)
       .setTitle('An Error Occurred')
       .setDescription('Something went wrong while processing your request.');
     await message.reply({ embeds: [errorEmbed] });
 } finally {
     clearInterval(typingInterval);
     if (activeRequests.has(userId)) activeRequests.delete(userId);
 }
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

async function processAttachments(message, prompt) {
 let parts = [{
   text: prompt
 }];

 if (message.attachments.size > 0) {
     for (const attachment of message.attachments.values()) {
         try {
             const response = await axios.get(attachment.url, { responseType: 'arraybuffer' });
             const buffer = Buffer.from(response.data, 'binary');
             
             if (attachment.contentType?.startsWith('image/')) {
                 parts.push({
                     inlineData: {
                         mimeType: attachment.contentType,
                         data: buffer.toString('base64'),
                     },
                 });
             } else {
                const text = await extractTextFromBuffer(buffer, attachment.contentType);
                if(text) parts[0].text += `\n\n--- Attachment: ${attachment.name} ---\n${text}`;
             }
         } catch (error) {
             console.error('Error processing attachment:', error);
         }
     }
 }
 return parts;
}

async function extractTextFromBuffer(buffer, mimeType) {
   try {
       if (mimeType === 'application/pdf') {
            // Basic PDF text extraction - might need a more robust library for complex PDFs
           const { text } = await import('pdf-parse').then(pdf => pdf.default(buffer));
           return text;
       } else if (mimeType?.startsWith('text/')) {
           return buffer.toString('utf-8');
       } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { // docx
           const extractor = getTextExtractor();
           return await extractor.extractText({ input: buffer, type: 'buffer' });
       }
   } catch (e) {
       console.error("Error extracting text from buffer", e)
   }

   return null;
}

async function handleImagineCommand(interaction) {
   const prompt = interaction.options.getString('prompt');
   await interaction.deferReply();

   try {
       const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
       const response = await ai.models.generateContent({
           model: "gemini-2.5-flash-image-preview",
           contents: prompt,
       });

       const part = response.candidates[0].content.parts.find(p => p.inlineData);
       if (part) {
           const imageData = part.inlineData.data;
           const buffer = Buffer.from(imageData, "base64");
           const attachment = new AttachmentBuilder(buffer, { name: 'gemini-image.png' });
           
           const embed = new EmbedBuilder()
               .setTitle('Image Generated')
               .setImage('attachment://gemini-image.png')
               .setFooter({ text: `Prompt: ${prompt}`});

           await interaction.editReply({ embeds: [embed], files: [attachment] });
       } else {
           await interaction.editReply('Could not generate an image for that prompt.');
       }

   } catch (error) {
       console.error('Error generating image:', error);
       await interaction.editReply('An error occurred while generating the image.');
   }
}

async function handleSearchCommand(interaction) {
   const attachment = interaction.options.getAttachment('type');
   const prompt = interaction.options.getString('prompt') || "What is in this file?";
   await interaction.deferReply();

   try {
       const parts = await processAttachments({ attachments: new Map([[attachment.id, attachment]]) }, prompt);
       
       const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", safetySettings, generationConfig });
       const result = await model.generateContent({ contents: [{ role: "user", parts }] });
       const response = result.response;
       const text = response.text();

       await interaction.editReply(text.substring(0, 2000));

   } catch (error) {
       console.error('Error in search command:', error);
       await interaction.editReply('An error occurred while searching.');
   }
}


// <==========>



// <=====[Interaction Reply]=====>

async function handleModalSubmit(interaction) {
   try {
       if (interaction.customId === 'user-custom-personality-modal') {
           const personality = interaction.fields.getTextInputValue('user-custom-personality-input');
           state.userSettings[interaction.user.id].customPersonality = personality;
           await showUserSettings(interaction, true);
       } else if (interaction.customId === 'server-custom-personality-modal') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
               return interaction.reply({ content: 'You do not have permission to change this setting.', ephemeral: true });
           }
           const personality = interaction.fields.getTextInputValue('server-custom-personality-input');
           state.serverSettings[interaction.guild.id].customPersonality = personality;
           await showServerSettings(interaction, true);
       } else if (interaction.customId === 'custom-embed-color-modal') {
           const color = interaction.fields.getTextInputValue('custom-embed-color-input');
           if (/^#[0-9A-F]{6}$/i.test(color)) {
               state.userSettings[interaction.user.id].embedColor = color;
               await showUserSettings(interaction, true);
           } else {
               await interaction.reply({ content: 'Invalid hex color code.', ephemeral: true });
           }
       }
   } catch (e) {
       console.error("Error in modal submit", e);
   }
}

async function handleClearHistory(interaction) {
   const serverSettings = interaction.guild ? getServerSettings(interaction.guild.id) : null;
   const historyId = serverSettings?.sharedHistory ? interaction.guild.id : interaction.user.id;
   delete state.chatHistories[historyId];
   await interaction.reply({ content: 'Your chat history has been cleared.', ephemeral: true });
}

// User Settings Toggles
async function toggleContinuousReply(interaction) {
   const userSettings = getUserSettings(interaction.user.id);
   userSettings.continuousReply = !userSettings.continuousReply;
   await showUserSettings(interaction, true);
}

async function toggleResponseFormat(interaction) {
   const userSettings = getUserSettings(interaction.user.id);
   userSettings.responseFormat = userSettings.responseFormat === 'Embed' ? 'Normal' : 'Embed';
   await showUserSettings(interaction, true);
}

async function toggleActionButtons(interaction) {
   const userSettings = getUserSettings(interaction.user.id);
   userSettings.actionButtons = !userSettings.actionButtons;
   await showUserSettings(interaction, true);
}

async function handleCustomEmbedColor(interaction) {
   const modal = new ModalBuilder()
       .setCustomId('custom-embed-color-modal')
       .setTitle('Custom Embed Color')
       .addComponents(
           new ActionRowBuilder().addComponents(
               new TextInputBuilder()
                   .setCustomId('custom-embed-color-input')
                   .setLabel('Hex Color Code')
                   .setStyle(TextInputStyle.Short)
                   .setPlaceholder('#RRGGBB')
                   .setValue(getUserSettings(interaction.user.id).embedColor)
           )
       );
   await interaction.showModal(modal);
}

async function handleUserCustomPersonality(interaction) {
    const modal = new ModalBuilder()
       .setCustomId('user-custom-personality-modal')
       .setTitle('Custom Personality')
       .addComponents(
           new ActionRowBuilder().addComponents(
               new TextInputBuilder()
                   .setCustomId('user-custom-personality-input')
                   .setLabel('Personality Prompt')
                   .setStyle(TextInputStyle.Paragraph)
                   .setPlaceholder('e.g., You are a helpful assistant that speaks like a pirate.')
                   .setValue(getUserSettings(interaction.user.id).customPersonality || '')
           )
       );
   await interaction.showModal(modal);
}


// Server Settings Toggles
async function toggleServerContinuousReply(interaction) {
   if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
   const serverSettings = getServerSettings(interaction.guild.id);
   serverSettings.continuousReply = !serverSettings.continuousReply;
   await showServerSettings(interaction, true);
}

async function toggleServerResponseFormat(interaction) {
   if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
   const serverSettings = getServerSettings(interaction.guild.id);
   serverSettings.responseFormat = serverSettings.responseFormat === 'Embed' ? 'Normal' : 'Embed';
   await showServerSettings(interaction, true);
}

async function toggleServerActionButtons(interaction) {
   if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
   const serverSettings = getServerSettings(interaction.guild.id);
   serverSettings.actionButtons = !serverSettings.actionButtons;
   await showServerSettings(interaction, true);
}

async function handleServerCustomPersonality(interaction) {
   if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
   const modal = new ModalBuilder()
       .setCustomId('server-custom-personality-modal')
       .setTitle('Server Custom Personality')
       .addComponents(
           new ActionRowBuilder().addComponents(
               new TextInputBuilder()
                   .setCustomId('server-custom-personality-input')
                   .setLabel('Personality Prompt')
                   .setStyle(TextInputStyle.Paragraph)
                   .setPlaceholder('e.g., You are a helpful assistant that speaks like a pirate.')
                   .setValue(getServerSettings(interaction.guild.id).customPersonality || '')
           )
       );
   await interaction.showModal(modal);
}

async function toggleOverrideUserSettings(interaction) {
   if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
   const serverSettings = getServerSettings(interaction.guild.id);
   serverSettings.overrideUserSettings = !serverSettings.overrideUserSettings;
   
   if (serverSettings.overrideUserSettings) {
       await interaction.user.send(`You have enabled 'Override User Settings' in **${interaction.guild.name}**. All users will now use the server's settings for the bot.`);
   }

   await showServerSettings(interaction, true);
}

async function toggleSharedServerHistory(interaction) {
   if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
   const serverSettings = getServerSettings(interaction.guild.id);
   serverSettings.sharedHistory = !serverSettings.sharedHistory;
   await showServerSettings(interaction, true);
}


async function showSettings(interaction) {
 try {
   const embed = new EmbedBuilder()
     .setColor(hexColour)
     .setTitle('Gemini Bot Settings')
     .setDescription('Choose which settings you would like to configure.');

   const row = new ActionRowBuilder()
     .addComponents(
       new ButtonBuilder()
         .setCustomId('user-settings')
         .setLabel('User Settings')
         .setStyle(ButtonStyle.Primary)
         .setEmoji('👤'),
       new ButtonBuilder()
         .setCustomId('server-settings')
         .setLabel('Server Settings')
         .setStyle(ButtonStyle.Secondary)
         .setEmoji('🛠️')
         .setDisabled(!interaction.inGuild())
     );

   await interaction.reply({
     embeds: [embed],
     components: [row],
     ephemeral: true
   });
 } catch (error) {
   console.error('Error showing settings:', error);
 }
}

async function showUserSettings(interaction, isUpdate = false) {
   const userId = interaction.user.id;
   const settings = getUserSettings(userId);

   const embed = new EmbedBuilder()
       .setColor(settings.embedColor)
       .setTitle('👤 User Settings')
       .setDescription('Here are your personal settings for the bot.');
   
   const rows = [
       new ActionRowBuilder().addComponents(
           new ButtonBuilder().setCustomId('continuous-reply').setLabel(`Continuous Reply: ${settings.continuousReply ? 'ON' : 'OFF'}`).setStyle(settings.continuousReply ? ButtonStyle.Success : ButtonStyle.Secondary),
           new ButtonBuilder().setCustomId('action-buttons').setLabel(`Action Buttons: ${settings.actionButtons ? 'ON' : 'OFF'}`).setStyle(settings.actionButtons ? ButtonStyle.Success : ButtonStyle.Secondary),
           new ButtonBuilder().setCustomId('clear-history').setLabel('Clear History').setStyle(ButtonStyle.Danger)
       ),
       new ActionRowBuilder().addComponents(
           new ButtonBuilder().setCustomId('response-format').setLabel(`Response Format: ${settings.responseFormat}`).setStyle(ButtonStyle.Primary),
           new ButtonBuilder().setCustomId('custom-embed-color').setLabel('Embed Color').setStyle(ButtonStyle.Secondary).setDisabled(settings.responseFormat !== 'Embed'),
           new ButtonBuilder().setCustomId('user-custom-personality').setLabel('Custom Personality').setStyle(ButtonStyle.Primary)
       ),
       new ActionRowBuilder().addComponents(
           new StringSelectMenuBuilder()
               .setCustomId('user-model-select')
               .setPlaceholder('Select a Model')
               .addOptions(
                   new StringSelectMenuOptionBuilder().setLabel('Gemini 2.0 Flash').setValue('gemini-2.0-flash').setDefault(settings.model === 'gemini-2.0-flash'),
                   new StringSelectMenuOptionBuilder().setLabel('Gemini 2.5 Flash').setValue('gemini-2.5-flash').setDefault(settings.model === 'gemini-2.5-flash'),
                   new StringSelectMenuOptionBuilder().setLabel('Gemini 2.5 Flash Lite').setValue('gemini-2.5-flash-lite').setDefault(settings.model === 'gemini-2.5-flash-lite'),
               )
       )
   ];

   const payload = { embeds: [embed], components: rows, ephemeral: true };
   if (isUpdate) await interaction.update(payload);
   else await interaction.reply(payload);
}

async function showServerSettings(interaction, isUpdate = false) {
   if (!interaction.inGuild() || !interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
       return interaction.reply({ content: 'You must have the "Manage Server" permission to use these settings.', ephemeral: true });
   }

   const guildId = interaction.guild.id;
   const settings = getServerSettings(guildId);

   const embed = new EmbedBuilder()
       .setColor(hexColour)
       .setTitle('🛠️ Server Settings')
       .setDescription('These settings apply to the entire server.');

   const rows = [
       new ActionRowBuilder().addComponents(
           new ButtonBuilder().setCustomId('server-continuous-reply').setLabel(`Continuous Reply: ${settings.continuousReply ? 'ON' : 'OFF'}`).setStyle(settings.continuousReply ? ButtonStyle.Success : ButtonStyle.Secondary),
           new ButtonBuilder().setCustomId('server-action-buttons').setLabel(`Action Buttons: ${settings.actionButtons ? 'ON' : 'OFF'}`).setStyle(settings.actionButtons ? ButtonStyle.Success : ButtonStyle.Secondary),
           new ButtonBuilder().setCustomId('shared-server-history').setLabel(`Shared History: ${settings.sharedHistory ? 'ON' : 'OFF'}`).setStyle(settings.sharedHistory ? ButtonStyle.Success : ButtonStyle.Secondary),
       ),
       new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('server-response-format').setLabel(`Response Format: ${settings.responseFormat}`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('server-custom-personality').setLabel('Custom Personality').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('override-user-settings').setLabel(`Override User Settings: ${settings.overrideUserSettings ? 'ON' : 'OFF'}`).setStyle(settings.overrideUserSettings ? ButtonStyle.Danger : ButtonStyle.Secondary)
       ),
       new ActionRowBuilder().addComponents(
           new StringSelectMenuBuilder()
               .setCustomId('server-model-select')
               .setPlaceholder('Select a Model')
               .addOptions(
                   new StringSelectMenuOptionBuilder().setLabel('Gemini 2.0 Flash').setValue('gemini-2.0-flash').setDefault(settings.model === 'gemini-2.0-flash'),
                   new StringSelectMenuOptionBuilder().setLabel('Gemini 2.5 Flash').setValue('gemini-2.5-flash').setDefault(settings.model === 'gemini-2.5-flash'),
                   new StringSelectMenuOptionBuilder().setLabel('Gemini 2.5 Flash Lite').setValue('gemini-2.5-flash-lite').setDefault(settings.model === 'gemini-2.5-flash-lite'),
               )
       )
   ];
   
   const payload = { embeds: [embed], components: rows, ephemeral: true };
   if (isUpdate) await interaction.update(payload);
   else await interaction.reply(payload);
}


// <==========>

// <=====[Model Response Handling]=====>

async function handleModelResponse(chat, parts, originalMessage, typingInterval, historyId, existingBotMessageId) {
   const userId = originalMessage.author.id;
   const guildId = originalMessage.guild?.id;

   const serverSettings = guildId ? getServerSettings(guildId) : {};
   const userSettings = getUserSettings(userId);
   const finalSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;

   let botMessage;

   try {
       if(existingBotMessageId) {
           botMessage = await originalMessage.channel.messages.fetch(existingBotMessageId);
       }
   } catch (e) { /* Probably deleted */ }
   
   try {
       clearInterval(typingInterval);
       const result = await chat.sendMessage(parts);
       const response = result.response;
       const text = response.text();

       const chunks = text.match(/[\s\S]{1,2000}/g) || [];

       for (let i = 0; i < chunks.length; i++) {
           const chunk = chunks[i];
           const isFirstChunk = i === 0;

           let messagePayload;

           if (finalSettings.responseFormat === 'Embed') {
               const embed = new EmbedBuilder()
                   .setColor(finalSettings.embedColor || hexColour)
                   .setDescription(chunk);
               messagePayload = { embeds: [embed] };
           } else {
               messagePayload = { content: chunk };
           }

           if (!finalSettings.continuousReply && isFirstChunk) {
                if (messagePayload.content) messagePayload.content = `<@${userId}> ${messagePayload.content}`;
                else messagePayload.content = `<@${userId}>`;
           }

           if (isFirstChunk && botMessage) {
               botMessage = await botMessage.edit(messagePayload);
           } else if (isFirstChunk) {
               botMessage = await originalMessage.reply(messagePayload);
           } else {
               await originalMessage.channel.send(messagePayload);
           }
       }
       
       if (finalSettings.actionButtons && botMessage) {
           const actionRow = new ActionRowBuilder()
               .addComponents(
                   new ButtonBuilder().setCustomId(`save_message-${botMessage.id}`).setLabel('Save').setStyle(ButtonStyle.Success).setEmoji('💾'),
                   new ButtonBuilder().setCustomId(`delete_message-${botMessage.id}`).setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
               );
           await botMessage.edit({ components: [actionRow] });
       }
       
       await chatHistoryLock.runExclusive(async () => {
           updateChatHistory(historyId, [
               { role: 'user', parts, userMessageId: originalMessage.id }, 
               { role: 'model', parts: [{text}], botMessageId: botMessage.id }
           ]);
           await saveStateToFile();
       });


   } catch (error) {
       console.error('Error handling model response:', error);
       const errorEmbed = new EmbedBuilder()
           .setColor(0xFF0000)
           .setTitle('Error')
           .setDescription(`An error occurred while getting a response from the model. \n\n\`${error.message}\``);
       
       if (botMessage) await botMessage.edit({ embeds: [errorEmbed], content: '' });
       else await originalMessage.reply({ embeds: [errorEmbed] });

   } finally {
       if (activeRequests.has(userId)) {
           activeRequests.delete(userId);
       }
   }
}
// <==========>


client.login(token);
