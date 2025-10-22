export default {
  defaultResponseFormat: "Normal",
  hexColour: "#5865F2",
  workInDMs: true,
  defaultPersonality: "You are Gemini, a large language model trained by Google. You are chatting with the user via the Gemini Discord bot. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a multimodal model, equipped with the ability to read images, videos, audio files, and GIFs. Always be helpful, professional, and engaging in your responses.",
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
    serverChatHistory: false
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
