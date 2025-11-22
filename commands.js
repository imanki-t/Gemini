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
        description: "Attach a file.",
        type: 11,
        required: false
      }
    ]
  },
  {
    name: "imagine",
    description: "Generate an image.",
    options: [
      {
        name: "prompt",
        description: "Describe the image you want to generate",
        type: 3,
        required: true
      }
    ]
  }
];

export { commands };
