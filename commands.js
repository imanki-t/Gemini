import { ApplicationCommandOptionType } from 'discord.js';

const commands = [
  // New Main Settings Command
  {
    name: "settings",
    description: "Opens the User and Server settings menu.",
  },
  // New Image Generation Command
  {
    name: "imagine",
    description: "Generates an image based on a text prompt.",
    options: [
      {
        name: "prompt",
        description: "The description for the image you want to generate.",
        type: ApplicationCommandOptionType.String,
        required: true,
      }
    ]
  },
  // New Multimodal Search Command
  {
    name: "search",
    description: "Performs a multimodal search using a prompt and/or an attachment.",
    options: [
      {
        name: "prompt",
        description: "The query for the search.",
        type: ApplicationCommandOptionType.String,
        required: false
      },
      {
        name: "attachment",
        description: "Upload a file (image, audio, pdf, etc.) for multimodal search context.",
        type: ApplicationCommandOptionType.Attachment,
        required: false
      }
    ]
  },
  // Remaining Admin Commands (for channel configuration)
  {
    name: "toggle_channel_chat_history",
    description: "Ensures the bot shares the same chat history with everyone in the channel (Admin only).",
    options: [
      {
        name: "enabled",
        description: "Set to true to enable channel-wide history, or false to disable it.",
        type: ApplicationCommandOptionType.Boolean,
        required: true
      },
      {
        name: "instructions",
        description: "Bot instructions for that channel.",
        type: ApplicationCommandOptionType.String,
        required: false
      }
    ]
  },
  {
    name: "respond_to_all",
    description: "Toggles bot responding to all messages in this channel (Admin only).",
    options: [
      {
        name: "enabled",
        description: "Set to true to enable, or false to disable.",
        type: ApplicationCommandOptionType.Boolean,
        required: true
      }
    ]
  },
];

export { commands };
