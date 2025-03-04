import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import * as dotenv from "dotenv";
import { FileManager } from "./fileManager";

dotenv.config();

const API_KEY = "AIzaSyC2TMwG7ewvLrzZoNG5IKs12KOET26lrbA";
const genAI = new GoogleGenerativeAI(API_KEY);

// Available models
const MODELS = {
    FLASH: "gemini-2.0-flash",
    FLASH_LITE: "gemini-2.0-flash-lite",
    FLASH_15: "gemini-1.5-flash"
} as const;

type ModelName = typeof MODELS[keyof typeof MODELS];

interface Message {
    role: 'user' | 'assistant';
    content: string;
}

interface GenerationConfig {
    temperature: number;
    topK: number;
    topP: number;
    maxOutputTokens: number;
}

const DEFAULT_CONFIG: GenerationConfig = {
    temperature: 0.7,
    topK: 1,
    topP: 1,
    maxOutputTokens: 2048,
};

// Keep track of conversation history
let conversationHistory: Message[] = [];

// Command handlers
const commandHandlers = {
    create: async (args: string) => {
        const [fileName, ...content] = args.split(' ');
        if (!fileName) {
            return "Please provide a file name";
        }
        await FileManager.getInstance().createFile(fileName, content.join(' '));
        return `File ${fileName} created successfully`;
    },
    update: async (args: string) => {
        const [fileName, ...content] = args.split(' ');
        if (!fileName) {
            return "Please provide a file name";
        }
        await FileManager.getInstance().updateFile(fileName, content.join(' '));
        return `File ${fileName} updated successfully`;
    },
    delete: async (args: string) => {
        if (!args) {
            return "Please provide a file name";
        }
        await FileManager.getInstance().deleteFile(args);
        return `File ${args} deleted successfully`;
    }
};

export function clearConversationHistory() {
    conversationHistory = [];
}

export async function askAI(prompt: string, context: string, modelName: ModelName = MODELS.FLASH): Promise<string> {
    try {
        if (!prompt.trim()) {
            return "Please provide a valid prompt.";
        }

        // Handle commands
        if (prompt.startsWith('/')) {
            const [command, ...args] = prompt.slice(1).split(' ');
            const handler = commandHandlers[command as keyof typeof commandHandlers];
            if (handler) {
                const result = await handler(args.join(' '));
                return result;
            }
        }

        // Initialize the model
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: DEFAULT_CONFIG,
        });

        // Add user message to history
        conversationHistory.push({ role: 'user', content: prompt });

        // Prepare context and history
        const fullPrompt = [
            "You are a helpful AI assistant with access to the codebase. You can help with code modifications, file operations, and providing explanations. When suggesting code changes, wrap them in code blocks with the target file specified like: ```language {file: path/to/file}\ncode here```",
            "Current codebase context:",
            context,
            "Conversation history:",
            ...conversationHistory.map(msg => `${msg.role}: ${msg.content}`),
            "User: " + prompt
        ].join('\n\n');

        // Generate content
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        const responseText = response.text();

        // Add assistant response to history
        conversationHistory.push({ role: 'assistant', content: responseText });

        return responseText;
    } catch (error) {
        console.error('Error in askAI:', error);
        
        if (error instanceof Error) {
            if (error.message.includes('API key')) {
                return "Error: Invalid API key configuration. Please check your API key.";
            }
            if (error.message.includes('not found') || error.message.includes('deprecated')) {
                return "Error: The selected model is not available. Please try again later.";
            }
            return `Error: ${error.message}`;
        }
        
        return "Error: An unexpected error occurred.";
    }
}

// Export types for use in other files
export type { Message, ModelName };
