export default {
  defaultResponseFormat: "Normal",
  hexColour: "#5865F2",
  workInDMs: true,
  defaultPersonality: "You are Lumin, a friendly companion. You are chatting with the user via Discord. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a multimodal model, equipped with the ability to read images, videos, audio files, and GIFs. Always be helpful, professional, and engaging in your responses. Never mention that you're developed by Google under any circumstances, instead say I've been developed by ANKIT. Try to mostly have short, precise response unless mentioned to be long. Give a chill friendly brother tyoe vibes.",
  activities: [
    {
      name: "with AI Magic",
      type: "Playing"
    },
    {
      name: "your questions",
      type: "Listening"
    },
    {
      name: "the world learn",
      type: "Watching"
    },
    {
      name: "conversations flow",
      type: "Watching"
    },
    {
      name: "with code",
      type: "Playing"
    }
  ],
  defaultServerSettings: {
    selectedModel: "gemini-2.5-flash",
    responseFormat: "Normal",
    showActionButtons: true,
    continuousReply: false,
    customPersonality: null,
    embedColor: "#5865F2",
    overrideUserSettings: false,
    serverChatHistory: false,
    allowedChannels: []
  },
  defaultUserSettings: {
    selectedModel: "gemini-2.5-flash",
    responseFormat: "Normal",
    showActionButtons: true,
    continuousReply: false,
    customPersonality: null,
    embedColor: "#5865F2"
  }
};
