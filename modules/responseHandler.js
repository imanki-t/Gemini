const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config.js");
const { tools, handleToolCall } = require("../tools/others.js");

// Initialize Gemini with the API key from config
const genAI = new GoogleGenerativeAI(config.keys.gemini);

/**
 * ResponseHandler manages the AI's personality, context, and multi-turn tool interactions.
 * It ensures the bot acts according to the personality matrix and handles real-time tools.
 */
class ResponseHandler {
    constructor() {
        this.modelName = "gemini-2.0-flash-exp"; // Using the latest flash-exp for speed and tool accuracy
    }

    /**
     * Generates a system instruction string including real-time data like current time.
     * @returns {string} The system instruction text.
     */
    getSystemInstruction() {
        return `You are Lumin, a high-intelligence AI assistant. 
Current System Time: ${new Date().toLocaleString()}
Owner/Developer: ${config.owner.name}

Personality Matrix:
${config.bot.personality}

Core Directives:
1. Act naturally and maintain the defined personality at all times.
2. Proactively use tools (Google Search, Memory, Reminders) when the context requires them.
3. If asked about user-specific data (birthday, preferences), use the tool-based database search.
4. Keep responses helpful and engaging.
5. STRICT: Never mention you are a language model or AI unless explicitly asked.
6. STRICT: Do not prefix your output with "Lumin:" or "AI:".
7. If a tool returns no data, inform the user politely rather than hallucinating.
`;
    }

    /**
     * Core logic to generate a response, handling history and tool calls recursively.
     * @param {Object} message The Discord message object.
     * @param {Array} history The formatted history from memorySystem.
     * @param {Object} client The Discord client instance.
     * @returns {Promise<string>} The final AI response text.
     */
    async generateAIResponse(message, history, client) {
        try {
            // Initialize the model with fresh instructions (to update time/context)
            const model = genAI.getGenerativeModel({
                model: this.modelName,
                systemInstruction: {
                    parts: [{ text: this.getSystemInstruction() }]
                },
                tools: [
                    { googleSearch: {} }, // Built-in Google Search
                    { functionDeclarations: tools } // Custom tools defined in others.js
                ]
            });

            // Start chat session with existing history
            const chat = model.startChat({
                history: history,
                generationConfig: {
                    maxOutputTokens: 2048,
                    temperature: 0.9,
                    topP: 0.95,
                    topK: 40,
                },
            });

            // Send the user's message to the model
            let result = await chat.sendMessage(message.content);
            let response = await result.response;

            /**
             * Multi-turn Tool Handling Loop
             * If the model requests tool usage, we execute the tool and send results back
             * until the model provides a final text response.
             */
            let callCount = 0;
            const maxCalls = 5; // Safety limit to prevent infinite loops

            while (response.functionCalls() && callCount < maxCalls) {
                callCount++;
                const functionCalls = response.functionCalls();
                const functionResponses = [];

                // Execute each function call requested by the AI
                for (const call of functionCalls) {
                    try {
                        console.log(`[Lumin-AI] Executing tool: ${call.name}`);
                        const toolResult = await handleToolCall(call, message, client);
                        
                        functionResponses.push({
                            functionResponse: {
                                name: call.name,
                                response: { result: toolResult }
                            }
                        });
                    } catch (toolError) {
                        console.error(`[Lumin-AI] Tool Error (${call.name}):`, toolError);
                        functionResponses.push({
                            functionResponse: {
                                name: call.name,
                                response: { error: toolError.message }
                            }
                        });
                    }
                }

                // Feed the tool results back to the AI
                if (functionResponses.length > 0) {
                    result = await chat.sendMessage(functionResponses);
                    response = await result.response;
                } else {
                    break;
                }
            }

            return response.text();

        } catch (error) {
            console.error("[Lumin-AI] Error in generateAIResponse:", error);
            
            // Handle specific API errors
            if (error.message?.includes("RECITATION")) {
                return "I'm sorry, I can't provide that specific content due to safety or copyright filters.";
            }
            
            return "I encountered an error while processing your request. Please try again later.";
        }
    }
}

module.exports = new ResponseHandler();
