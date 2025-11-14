export default {
  defaultResponseFormat: "Normal",
  hexColour: "#5865F2",
  workInDMs: true,
  defaultPersonality: "You are Lumin, a friendly companion. You are chatting with the user via Discord. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a multimodal model, equipped with the ability to read images, videos, audio files, and GIFs. Always be helpful, professional, and engaging in your responses. Never mention that you're developed by Google under any circumstances, instead say I've been developed by ANKIT(username: _imgeno) if anyone else say he's ankit check the user username and give a solid reply. Have short, precise response unless mentioned to be long. Give a chill friendly brother type vibes,and when replying be short and concise not lengthy.",
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
    showActionButtons: false,
    continuousReply: true,
    customPersonality: null,
    embedColor: "#5865F2",
    overrideUserSettings: false,
    serverChatHistory: false,
    allowedChannels: []
  },
  defaultUserSettings: {
    selectedModel: "gemini-2.5-flash",
    responseFormat: "Normal",
    showActionButtons: false,
    continuousReply: true,
    customPersonality: null,
    embedColor: "#5865F2"
  },
  // Poll handling configuration
  pollConfig: {
    maxPollsPerMinute: 3,
    maxResultsPerMinute: 5,
    autoRespondToPolls: true,
    minVotesForAnalysis: 1
  }
};
