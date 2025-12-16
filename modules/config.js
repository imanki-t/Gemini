import { HarmBlockThreshold, HarmCategory } from '@google/genai';

export const MODELS = {
  'gemini-2.0-flash': 'gemini-2.0-flash-exp',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite': 'gemini-2.0-flash-lite'
};

export const safetySettings = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

export const generationConfig = {
  temperature: 1.0,
  topP: 0.95,
  thinkingConfig: {
    thinkingBudget: -1
  }
};
