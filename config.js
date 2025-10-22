export default {
  hexColour: "#505050",
  workInDMs: true,
  SEND_RETRY_ERRORS_TO_DISCORD: false,
  defaultPersonality: "You are Gemini, a large language model trained by Google. You are chatting with the user via the Gemini Discord bot. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a multimodal model, equipped with the ability to read images, videos, audio files, and GIFs.",
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
  defaultGlobalUserSettings: {
    model: "gemini-2.5-flash",
    continuousReply: false,
    responseFormat: "Embedded",
    responseColor: "#505050",
    showActionButtons: true,
    customPersonality: null
  },
  defaultServerSettings: {
    model: "gemini-2.5-flash",
    continuousReply: false,
    responseFormat: "Embedded",
    responseColor: "#505050",
    showActionButtons: true,
    customPersonality: null,
    overrideUserSettings: false
  }
};
