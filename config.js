export default {
  defaultResponseFormat: "Embedded",
  hexColour: "#505050",
  workInDMs: true,
  SEND_RETRY_ERRORS_TO_DISCORD: false,
  defaultPersonality: "You are Gemini, a large language model trained by Google. You are chatting with the user via the Gemini Discord bot. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a multimodal model, equipped with the ability to read images, videos, and audio files.",
  activities: [
    {
      name: "With Code",
      type: "Playing"
    },
    {
      name: "Something",
      type: "Listening"
    },
    {
      name: "You",
      type: "Watching"
    }
  ],
  // New/Updated Default Settings
  defaultTextModel: "gemini-2.5-flash", 
  defaultActionButtons: false,
  defaultContinuousReply: false,
  defaultServerSettings: {
    serverChatHistory: false,
    settingsSaveButton: true,
    customServerPersonality: false,
    serverResponsePreference: false,
    responseStyle: "Embedded", // Enforced capitalization
    actionButtons: false, // Server default for action buttons
    continuousReply: false, // Server default for continuous reply (no mention)
    model: "gemini-2.5-flash", // Server default model
    embedColor: "#505050", // Server default embed color
    overrideUserSettings: false, // New override toggle
  }
};
