// config.js

export default {
  // Global defaults
  defaultResponseFormat: "Embedded",
  hexColour: "#3498db", // Updated to a more professional blue
  workInDMs: true,
  shouldDisplayPersonalityButtons: true,
  SEND_RETRY_ERRORS_TO_DISCORD: false,

  // Available Models
  AVAILABLE_MODELS: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast and highly capable model for general tasks." },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", description: "A previous generation of the fast model." },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", description: "A highly optimized version for very quick responses." },
  ],

  // Default Personality
  defaultPersonality: "You are Gemini, a large language model trained by Google. You are chatting with the user via the Gemini Discord bot. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a multimodal model, equipped with the ability to read images, videos, and audio files. Your tone is professional and helpful.",

  // Bot Status Activities
  activities: [
    {
      name: "With Code & AI",
      type: "Playing"
    },
    {
      name: "User Queries",
      type: "Listening"
    },
    {
      name: "The Future",
      type: "Watching"
    }
  ],

  // Default Server Settings (per guild)
  defaultServerSettings: {
    model: "gemini-2.5-flash", // Server model preference
    continuousReply: false, // If true, bot doesn't mention user in response
    responseStyle: "Embedded", // Embedded or Normal (Text)
    responseColor: "#3498db", // Customizable embed color
    actionButtonsDisplay: true, // Show/Hide Save/Delete/Stop buttons
    customServerPersonality: false, // If true, custom instructions are used
    overrideUser: false, // If true, server settings override user settings
    serverChatHistory: false, // If true, all users share chat history
    settingsSaveButton: true, // Display save button on bot responses
  },

  // Default User Settings (per user)
  defaultUserSettings: {
    model: "gemini-2.5-flash",
    continuousReply: false,
    responseStyle: "Embedded",
    responseColor: "#3498db",
    actionButtonsDisplay: true,
  }
};
