const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("../config.js");
const { tools, handleToolCall } = require("../tools/others.js");

const genAI = new GoogleGenerativeAI(config.keys.gemini);

class ResponseHandler {
    constructor() {
        this.modelName = "gemini-2.0-flash-exp";
    }

    getSystemInstruction() {
        return `You are Lumin, a high-intelligence AI assistant. 
Current System Time: ${new Date().toLocaleString()}
Owner/Developer: ${config.owner.name}
Personality Matrix: ${config.bot.personality}

Core Directives:
1. Act naturally and maintain the defined personality.
2. Use tools proactively (Google Search, Memory).
3. STRICT: Never mention you are an AI model.
4. STRICT: No "Lumin:" or "AI:" prefixes.`;
    }

    async generateAIResponse(message, history, client) {
        try {
            const model = genAI.getGenerativeModel({
                model: this.modelName,
                systemInstruction: { parts: [{ text: this.getSystemInstruction() }] },
                tools: [{ googleSearch: {} }, { functionDeclarations: tools }]
            });

            const chat = model.startChat({ history: history });

            let result = await chat.sendMessage(message.content);
            let response = await result.response;

            let callCount = 0;
            while (response.functionCalls() && callCount < 5) {
                callCount++;
                const functionResponses = [];
                for (const call of response.functionCalls()) {
                    const toolResult = await handleToolCall(call, message, client);
                    functionResponses.push({
                        functionResponse: { name: call.name, response: { result: toolResult } }
                    });
                }
                result = await chat.sendMessage(functionResponses);
                response = await result.response;
            }

            // RETURN THE WHOLE RESPONSE OBJECT to access metadata
            return response;

        } catch (error) {
            console.error("AI Error:", error);
            return null;
        }
    }
}

module.exports = new ResponseHandler();
