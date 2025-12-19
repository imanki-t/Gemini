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
        type: 3,
        required: false
      },
      {
        name: "file",
        description: "Attach a file",
        type: 11,
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
        type: 3,
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
    dm_permission: false // Hidden in DMs
  },
  {
    name: "anniversary",
    description: "View bot's server anniversary info",
    dm_permission: false // Hidden in DMs
  },
  {
    name: "digest",
    description: "Get a weekly digest.",
    dm_permission: false // Hidden in DMs
  },
  {
    name: "starter",
    description: "Get a conversation starter"
  },
  {
    name: "compliment",
    description: "Send an anonymous compliment to someone",
    options: [
      {
        name: "user",
        description: "User to compliment",
        type: 6,
        required: true
      }
    ]
  },
  {
    name: "game",
    description: "Play interactive games with AI"
  },
  {
    name: "timezone",
    description: "Set your timezone for time-based features."
  },
  {
    name: "summary",
    description: "Summarize a conversation based on a message link",
    dm_permission: false, // Hidden in DMs
    options: [
      {
        name: "link",
        description: "The message link to start the summary around",
        type: 3,
        required: true
      },
      {
        name: "count",
        description: "Number of messages to summarize",
        type: 4,
        required: false,
        min_value: 1,
        max_value: 100
      }
    ]
  },
  {
    name: "realive",
    description: "Periodically send messages to revive dead chats",
    dm_permission: false, // Hidden in DMs
    options: [
      {
        name: "action",
        description: "Configure realive settings",
        type: 3,
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
        type: 4,
        required: false,
        min_value: 1,
        max_value: 168
      }
    ]
  }
];

export { commands };
