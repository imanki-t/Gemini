const commands = [
  {
    name: "settings",
    description: "Access and manage your personal or server settings for the bot."
  },
  {
    name: "search",
    description: "Send a prompt with optional attachments (images, audio, video, GIFs, text files).",
    options: [
      {
        type: 3,
        name: "prompt",
        description: "Your text prompt.",
        required: false
      },
      {
        type: 11,
        name: "attachment1",
        description: "The first file to attach (image, audio, video, GIF, PDF, code).",
        required: false
      },
      {
        type: 11,
        name: "attachment2",
        description: "The second file to attach.",
        required: false
      },
      {
        type: 11,
        name: "attachment3",
        description: "The third file to attach.",
        required: false
      }
    ]
  }
];

export { commands };
