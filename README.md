✦ Lumin - Advanced Gemini AI Discord Bot
Lumin is a professional, multimodal Discord bot powered by Google's Gemini 2.5 and Imagen 3 models. It features long-term vector memory (RAG), sophisticated file handling, customizable personalities, and a robust settings dashboard.
Built with discord.js, @google/genai, and MongoDB.
✨ Key Features
🧠 AI Capabilities
State-of-the-Art Models: Supports gemini-2.5-flash, gemini-2.5-pro, and gemini-2.5-flash-lite.
Multimodal Understanding: Capable of processing:
Images: (PNG, JPG, WebP)
Audio: (MP3, WAV, OGG, etc.) - Automatically converts formats like OGG to MP3.
Video: (MP4, MOV, WebM) - Automatically converts GIFs and animated stickers to MP4.
Documents: (PDF, TXT, Code files, CSV, etc.) - Extracts text automatically.
Image Generation: Uses imagen-3.0-fast-generate-001 via the /imagine command.
Code Execution: Can generate and execute Python code internally.
💾 Memory & Context (RAG)
Vector Database: Uses MongoDB to store vector embeddings of conversations.
Context Retrieval: Automatically retrieves relevant past messages based on the current conversation topic (Retrieval-Augmented Generation).
Summarization: Automatically compresses long conversation histories to maintain context without hitting token limits.
⚙️ Customization & Control
Dual Settings System: Separate settings for Users (Global) and Servers (Guild-specific).
Server Overrides: Admins can enforce server-wide settings (e.g., enforcing a specific model or disabling embedded responses).
Personalities: Users and Servers can set custom system instructions (Personalities) for the bot.
Response Styles: Choose between "Normal" (text) or "Embedded" (rich formatting with metadata) responses.
Continuous Reply Mode: The bot can engage in conversation without being mentioned every time.
🛠️ Technical Features
Poll Analysis: Can read and analyze Discord Poll results.
Rate Limiting: Built-in protection against spam and image generation abuse.
Thread Safety: Uses Mutex locks to prevent race conditions during chat history updates.
Auto-Cleanup: Automatically manages temporary files to keep the host system clean.
📋 Prerequisites
Before running the bot, ensure you have the following installed:
Node.js (v18.0.0 or higher)
MongoDB (Local instance or Atlas URI)
FFmpeg (Required for media conversion, e.g., converting GIFs/Stickers to Video for Gemini)
🚀 Installation
