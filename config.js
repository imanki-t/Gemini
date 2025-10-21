export default {
  // --- Core Settings ---
  // Default response style for users who haven't set a preference
  defaultResponseFormat: "Embedded",
  // Default model for users who haven't set a preference (must be one of the three allowed models)
  defaultTextModel: "gemini-2.5-flash",
  // Default color for embeds (for users/servers who haven't set a preference)
  hexColour: "#505050",
  // Whether the bot works in Direct Messages
  workInDMs: true,
  // Whether to send advanced retry errors to Discord (for debugging)
  SEND_RETRY_ERRORS_TO_DISCORD: false,
  
  // --- User-Level Interaction Defaults ---
  // Default state for Continuous Reply (true = no @mention, false = always @mention)
  defaultContinuousReply: true,
  // Default state for Action Buttons (Save/Delete/Settings)
  defaultActionButtons: false,
  
  // --- Personality ---
  defaultPersonality: "You are Gemini, a large language model trained by Google. You are chatting with the user via the Gemini Discord bot. You are a multimodal model, equipped with the ability to read images, videos, and audio files.",
  
  // --- Activities ---
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
  
  // --- Server Settings Defaults ---
  defaultServerSettings: {
    // Shared chat history for the entire server
    serverChatHistory: false,
    // Whether server settings override individual user settings
    overrideUserSettings: false, 
    // Server default model
    model: "gemini-2.5-flash",
    // Server default response style ("Embedded" or "Normal")
    responseStyle: "Embedded",
    // Server default continuous reply state (true = no @mention)
    continuousReply: true,
    // Server default action buttons state (true = show Save/Delete/Settings buttons)
    actionButtons: false,
    // Server default embed color
    embedColor: "#505050"
  }
};
