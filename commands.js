import { PermissionFlagsBits, ApplicationCommandOptionType } from 'discord.js';

const commands = [
  {
    name: "settings",
    description: "Open the bot settings dashboard."
  },
  {
    name: "search",
    description: "Search with AI.",
    options: [
      {
        name: "prompt",
        description: "Your search query or prompt",
        type: ApplicationCommandOptionType.String,
        required: false
      },
      {
        name: "file",
        description: "Attach a file",
        type: ApplicationCommandOptionType.Attachment,
        required: false
      }
    ]
  },
  {
    name: "birthday",
    description: "Manage your birthday reminders",
    options: [
      {
        name: "action",
        description: "What do you want to do?",
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: "Set Birthday", value: "set" },
          { name: "Remove Birthday", value: "remove" },
          { name: "List Birthdays", value: "list" }
        ]
      }
    ]
  },
  {
    name: "reminder",
    description: "Set reminders for yourself"
  },
  {
    name: "quote",
    description: "Daily inspirational quotes"
  },
  {
    name: "roulette",
    description: "Bot randomly reacts to messages in this channel",
    dm_permission: false,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString()
  },
  {
    name: "anniversary",
    description: "View bot's server anniversary info",
    dm_permission: false
  },
  {
    name: "digest",
    description: "Get a weekly digest.",
    dm_permission: false
  },
  {
    name: "starter",
    description: "Get a conversation starter"
  },
  {
    name: "compliment",
    description: "Send an anonymous compliment to someone",
    dm_permission: false,
    options: [
      {
        name: "user",
        description: "User to compliment",
        type: ApplicationCommandOptionType.User,
        required: true
      }
    ]
  },

  {
    name: "timezone",
    description: "Set your timezone for time-based features."
  },
  {
    name: "summary",
    description: "Summarize a Discord conversation OR a YouTube video",
    dm_permission: true,
    options: [
      {
        name: "link",
        description: "Message link OR YouTube URL",
        type: ApplicationCommandOptionType.String,
        required: true
      },
      {
        name: "count",
        description: "Number of messages to summarize",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
        max_value: 100
      }
    ]
  },
  {
    name: "realive",
    description: "Periodically send messages to revive dead chats",
    dm_permission: false,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: "action",
        description: "Configure realive settings",
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: "Enable", value: "enable" },
          { name: "Disable", value: "disable" },
          { name: "Set Interval", value: "interval" },
          { name: "Status", value: "status" }
        ]
      },
      {
        name: "hours",
        description: "Hours between interval messages.",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
        max_value: 168
      }
    ]
  }
];

export { commands };
