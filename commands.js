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
    description: "Bot randomly reacts to messages in this channel"
  },
  {
    name: "anniversary",
    description: "View bot's server anniversary info"
  },
  {
    name: "digest",
    description: "Get a weekly digest."
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
  }
];

export { commands };
