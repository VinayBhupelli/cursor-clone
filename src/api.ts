import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import * as dotenv from "dotenv";

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

export async function askAI(prompt: string, context: string, modelName: ModelName = MODELS.FLASH): Promise<string> {
    try {
        // Initialize the model
        const model = genAI.getGenerativeModel({
            model: modelName,
            generationConfig: DEFAULT_CONFIG,
        });

        // Prepare prompt with context
        const fullPrompt = `${context}\n\nUser: ${prompt}`;

        // Generate content
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        
        return response.text();
    } catch (error) {
        console.error('Error in askAI:', error);
        
        if (error instanceof Error) {
            // Handle API key errors
            if (error.message.includes('API key')) {
                return "Error: Invalid API key configuration. Please check your API key.";
            }
            
            // Handle model availability errors
            if (error.message.includes('not found') || error.message.includes('deprecated')) {
                return "Error: The selected model is not available. Please try again later.";
            }
            
            // Return the actual error message
            return `Error: ${error.message}`;
        }
        
        return "Error: An unexpected error occurred.";
    }
}
