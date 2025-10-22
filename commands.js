// commands.js

import { ApplicationCommandOptionType } from 'discord.js';

const commands = [
  {
    name: "settings",
    description: "Opens the professional bot configuration interface for User and Server settings.",
  },
  {
    name: "search",
    description: "Submit a prompt and an optional attachment (image, video, audio, GIF, document) for analysis.",
    options: [
      {
        name: "prompt",
        description: "The text prompt or question to accompany the attachment.",
        type: ApplicationCommandOptionType.String,
        required: false
      },
      {
        name: "file",
        description: "The file attachment (image, audio, video, GIF, PDF, etc.)",
        type: ApplicationCommandOptionType.Attachment,
        required: false
      }
    ]
  },
  // NOTE: All prior commands (blacklist, status, clear_memory, respond_to_all, etc.) have been removed,
  // as their functionality is now integrated into the /settings interface.
];

export { commands };
