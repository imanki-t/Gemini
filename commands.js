import { ApplicationCommandOptionType } from 'discord.js';

const commands = [
  // New Main Settings Command
  {
    name: "settings",
    description: "Opens the User and Server settings menu.",
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
];

export { commands };
