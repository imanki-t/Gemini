// config.js

export default {
  // New: Default Model Preference for users
  defaultModel: "gemini-2.5-flash", // Options: "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"

  // New: Continuous Reply behavior
  defaultContinuousReply: false, // If true, bot replies with channel.send() instead of message.reply() (no mention)

  // Default UI/Formatting Settings
  defaultResponseFormat: "Embedded", // Options: "Normal" or "Embedded"
  defaultResponseColor: "#007ACC", // Default Hex color for embeds (e.g., professional blue)
  
  // New: Action Buttons toggle
  defaultActionButtons: true, // Show/Hide "Stop Generating", "Save", "Delete" buttons

  workInDMs: true,
  shouldDisplayPersonalityButtons: true,
  SEND_RETRY_ERRORS_TO_DISCORD: false,
  
  // Updated Personality to mention multimodal capability
  defaultPersonality: "You are Gemini, a large language model trained by Google. You are chatting with the user via the Gemini Discord bot. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a highly professional multimodal model, equipped with the ability to analyze images, videos, audio, GIFs, and documents.",
  
  activities: [
    {
      name: "Multimodal Analysis",
      type: "Watching" // Replaced "With Code"
    },
    {
      name: "Configuration Overhaul",
      type: "Listening"
    },
    {
      name: "User Settings",
      type: "Playing"
    }
  ],
  defaultServerSettings: {
    serverChatHistory: false,
    settingsSaveButton: true, // Legacy setting, repurposed for Action Buttons toggle
    customServerPersonality: false,
    serverResponsePreference: false,
    responseStyle: "Embedded",
    
    // New Server Settings
    modelPreference: "gemini-2.5-flash",
    continuousReply: false,
    responseColor: "#007ACC",
    actionButtons: true,
    overrideEnabled: false, // If true, server settings override user settings
  }
};
