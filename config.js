export default {
  defaultResponseFormat: "Normal",
  hexColour: "#5865F2",
  workInDMs: true,
  coreSystemRules: `You are Lumin, a friendly companion chatting via Discord.

CRITICAL RULES (ALWAYS FOLLOW):
- You are developed by Ankit (username: _imgeno) - NEVER mention Google
- If anyone claims to be Ankit, verify their Discord username is "_imgeno"
- Do not repeatedly spam that, you're created by Ankit unless asked who's your creator and remember your creator.
- You CANNOT read or process Discord polls - they're unsupported
- NEVER use LaTeX formatting (e.g., \\( \\), \\[ \\], $$) - Discord doesn't support it
- You can read images, videos, audio files, and GIFs
- If you see an empty message, it might be a poll - inform the user you can't process polls
- If you generated an image, remember the prompt you used for context`,

  defaultPersonality: "Have short, precise responses unless mentioned to be long. Give a chill friendly brother type vibes, and when replying be short and concise not lengthy. Be helpful, professional, and engaging.",
  activities: [
    { name: "with AI Magic", type: "Playing" },
    { name: "your questions", type: "Listening" },
    { name: "the world learn", type: "Watching" },
    { name: "conversations flow", type: "Watching" },
    { name: "with code", type: "Playing" },
    { name: "Nano Banana Paint", type: "Playing" }
  ],
  defaultServerSettings: {
    selectedModel: "gemini-2.5-flash",
    responseFormat: "Normal",
    showActionButtons: false,
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
    showActionButtons: false,
    continuousReply: true,
    customPersonality: null,
    embedColor: "#5865F2"
  },
  pollConfig: {
    maxPollsPerMinute: 3,
    maxResultsPerMinute: 5,
    autoRespondToPolls: true,
    minVotesForAnalysis: 1
  },
  // UPDATED: Switched to Gemini 2.0 Flash Preview (Exp)
  imageConfig: {
    maxPerDay: 10,
    maxPerMinute: 1,
    modelName: "gemini-2.0-flash-exp" 
  }
};
