const commands = [
  {
    name: "settings",
    description: "Open the bot settings dashboard to configure preferences."
  },
  {
    name: "search",
    description: "Search with AI using text and/or file attachments.",
    options: [
      {
        name: "prompt",
        description: "Your search query or prompt",
        type: 3,
        required: false
      },
      {
        name: "file",
        description: "Attach a file (image, audio, video, PDF, GIF, etc.)",
        type: 11,
        required: false
      }
    ]
  }
];

export { commands };
