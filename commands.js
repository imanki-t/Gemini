// commands.js
import {
  ApplicationCommandOptionType
} from 'discord.js';

const commands = [{
  name: "settings",
  description: "Customise your personal and server settings.",
}, {
  name: "search",
  description: "Search and multimedia.",
  options: [{
    name: "prompt",
    description: "The text prompt to send with the file",
    type: ApplicationCommandOptionType.String,
    required: false
  }, {
    name: "attachment",
    description: "The file to upload",
    type: ApplicationCommandOptionType.Attachment,
    required: false
  }, ],
}, ];

export {
  commands
};
