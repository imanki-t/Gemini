// commands.js

import { ApplicationCommandOptionType } from 'discord.js';

const commands = [
  {
    name: "settings",
    description: "Opens the professional configuration dashboard for user and server settings.",
  },
  {
    name: "search",
    description: "Submit a prompt and/or attach a file (image, audio, video, PDF, etc.) for processing.",
    options: [
      {
        name: "prompt",
        description: "The text prompt to accompany your file upload.",
        type: ApplicationCommandOptionType.String,
        required: false
      }
      // Note: File uploads are handled via Discord's native attachment feature alongside the command submission.
    ]
  },
  // Future command placeholder: /imagine
  /*
  {
    name: "imagine",
    description: "Generate an image based on a prompt (using Gemini 2.5 Flash Image API).",
    options: [
      {
        name: "prompt",
        description: "The prompt to generate the image from.",
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  }
  */
];

export { commands };
