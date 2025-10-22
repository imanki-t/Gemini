// config.js
export default {
  defaultResponseFormat: "Embedded",
  hexColour: "#505050",
  workInDMs: true,
  SEND_RETRY_ERRORS_TO_DISCORD: false,
  defaultPersonality: "You are Gemini, a large language model trained by Google. You are chatting with the user via the Gemini Discord bot. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a multimodal model, equipped with the ability to read images, videos, audio, and GIFs.",
  activities: [
    { name: "With Code", type: "Playing" },
    { name: "Something", type: "Listening" },
    { name: "You", type: "Watching" }
  ],
  models: {
    "gemini-2.0-flash": "gemini-2.0-flash",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.0-flash-lite": "gemini-2.0-flash-lite",
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite"
  },
  defaultModel: "gemini-2.5-flash",
  defaultServerSettings: {
    model: null,
    continuousReply: false,
    responseFormat: null,
    responseColor: null,
    showActionButtons: true,
    customPersonality: null,
    overrideUserSettings: false,
    serverChatHistory: false,
    blacklist: []
  },
  defaultUserSettings: {
    model: "gemini-2.5-flash",
    continuousReply: false,
    responseFormat: "Embedded",
    responseColor: "#505050",
    showActionButtons: true,
    customPersonality: null
  },
  PORT: process.env.PORT || 3000
};
