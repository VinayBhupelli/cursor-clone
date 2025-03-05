import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import * as dotenv from "dotenv";
import { FileManager } from "./fileManager";

dotenv.config();

const API_KEY = "";
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

export async function askAI(prompt: string, context: string, modelName: ModelName = MODELS.FLASH): Promise<any> {
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
        
        // Parse the response to preserve code blocks
        const responseText = response.text();
        const blocks = [];
        let currentText = '';
        let lines = responseText.split('\n');
        let inCodeBlock = false;
        let currentBlock: any = {};
        let blockStartLine = '';

        for (let line of lines) {
            if (line.trim().startsWith('```')) {
                if (inCodeBlock) {
                    // End of code block
                    inCodeBlock = false;
                    if (currentBlock.code) {
                        // Clean up the code block
                        currentBlock.code = currentBlock.code.trim() + '\n';
                        // Parse language and file info from the opening line
                        const langAndFile = blockStartLine.slice(3).trim();
                        const fileMatch = langAndFile.match(/{file:\s*([^}]+)}/);
                        if (fileMatch) {
                            currentBlock.file = fileMatch[1].trim();
                            currentBlock.language = langAndFile.slice(0, langAndFile.indexOf('{')).trim();
                        } else {
                            currentBlock.language = langAndFile;
                        }
                        blocks.push(currentBlock);
                    }
                    currentBlock = {};
                    blockStartLine = '';
                } else {
                    // Start of code block
                    if (currentText.trim()) {
                        blocks.push({
                            type: 'text',
                            content: currentText.trim()
                        });
                        currentText = '';
                    }
                    inCodeBlock = true;
                    blockStartLine = line;
                    currentBlock = {
                        type: 'code',
                        code: ''
                    };
                }
            } else if (inCodeBlock) {
                // Inside code block - preserve all whitespace and line breaks
                currentBlock.code = (currentBlock.code || '') + line + '\n';
            } else {
                currentText += line + '\n';
            }
        }

        // Add any remaining text
        if (currentText.trim()) {
            blocks.push({
                type: 'text',
                content: currentText.trim()
            });
        }

        // Clean up code blocks and ensure proper line endings
        blocks.forEach(block => {
            if (block.type === 'code' && block.code) {
                // Normalize line endings and ensure trailing newline
                block.code = block.code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                if (!block.code.endsWith('\n')) {
                    block.code += '\n';
                }
            }
        });

        // Add assistant response to history
        conversationHistory.push({ role: 'assistant', content: responseText });

        return blocks;
    } catch (error) {
        console.error('Error in askAI:', error);
        
        if (error instanceof Error) {
            if (error.message.includes('API key')) {
                return [{ type: 'text', content: "Error: Invalid API key configuration. Please check your API key." }];
            }
            if (error.message.includes('not found') || error.message.includes('deprecated')) {
                return [{ type: 'text', content: "Error: The selected model is not available. Please try again later." }];
            }
            return [{ type: 'text', content: `Error: ${error.message}` }];
        }
        
        return [{ type: 'text', content: "Error: An unexpected error occurred." }];
    }
}

// Export types for use in other files
export type { Message, ModelName };
