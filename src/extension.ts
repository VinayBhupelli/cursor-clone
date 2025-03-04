import * as vscode from "vscode";
import { askAI } from "./api";
import { FileManager } from "./fileManager";
import { ContextManager } from "./contextManager";
import { Uri } from "vscode";
import * as path from 'path';

// Add type definitions at the top of the file
interface ResponseBlock {
    type: 'text' | 'code';
    content?: string;
    language?: string;
    file?: string;
    code?: string;
}

export function activate(context: vscode.ExtensionContext) {
    let chatPanel: vscode.WebviewPanel | undefined;
    const contextManager = new ContextManager();
    const fileManager = FileManager.getInstance();

    let disposable = vscode.commands.registerCommand("chatCursor.showSidebar", async () => {
        if (chatPanel) {
            chatPanel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        chatPanel = vscode.window.createWebviewPanel(
            "aiChat",
            "AI Chat",
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    Uri.file(path.join(context.extensionPath, 'frontend'))
                ]
            }
        );

        const workspaceFiles = await contextManager.loadWorkspaceFiles();
        chatPanel.webview.html = getWebviewContent(context, chatPanel);

        chatPanel.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case "ask":
                        // Handle @ commands for file operations
                        if (message.text.startsWith('@')) {
                            const response = await handleFileCommand(message.text, fileManager);
                            chatPanel?.webview.postMessage({ command: "response", text: response });
                            return;
                        }
                        
                        // Handle / commands
                        if (message.text.startsWith('/')) {
                            const response = await handleSlashCommand(message.text, fileManager);
                            chatPanel?.webview.postMessage({ command: "response", text: response });
                            return;
                        }

                        // Handle natural language commands
                        if (message.text.toLowerCase().includes('create') && message.text.toLowerCase().includes('file')) {
                            const response = await handleCreateFileCommand(message.text, fileManager);
                            chatPanel?.webview.postMessage({ command: "response", text: response });
                            return;
                        }

                        const response = await askAI(
                            message.text, 
                            JSON.stringify(workspaceFiles),
                            message.model
                        );

                        // Process each block in the response
                        for (const block of response as ResponseBlock[]) {
                            if (block.type === 'code') {
                                if (block.file && block.code) {
                                    // If code block has a file specified, create/update the file
                                    try {
                                        await fileManager.updateFile(block.file, block.code);
                                        chatPanel?.webview.postMessage({ 
                                            command: "response", 
                                            text: `Updated file: ${block.file}`
                                        });
                                    } catch (error) {
                                        try {
                                            await fileManager.createFile(block.file, block.code);
                                            chatPanel?.webview.postMessage({ 
                                                command: "response", 
                                                text: `Created file: ${block.file}`
                                            });
                                        } catch (createError) {
                                            chatPanel?.webview.postMessage({ 
                                                command: "response", 
                                                text: `Error handling file ${block.file}: ${error instanceof Error ? error.message : 'Unknown error'}`
                                            });
                                        }
                                    }
                                }
                            }
                        }

                        // Send the formatted response
                        const formattedResponse = (response as ResponseBlock[]).map(block => {
                            if (block.type === 'text' && block.content) {
                                return block.content;
                            } else if (block.type === 'code') {
                                const fileInfo = block.file ? ` {file: ${block.file}}` : '';
                                const language = block.language || '';
                                return `\`\`\`${language}${fileInfo}\n${block.code || ''}\n\`\`\``;
                            }
                            return '';
                        }).join('\n\n');

                        chatPanel?.webview.postMessage({ 
                            command: "response", 
                            text: formattedResponse 
                        });
                        break;

                    case "getFileSuggestions":
                        const suggestions = await fileManager.getFileSuggestions(message.query);
                        chatPanel?.webview.postMessage({ 
                            command: "fileSuggestions", 
                            suggestions 
                        });
                        break;

                    case "applyCode":
                        if (message.code) {
                            try {
                                // Extract code from code block if present
                                let codeToApply = message.code;
                                
                                // First try to extract code from markdown code block
                                const codeBlockMatch = message.code.match(/```(?:\w+)?\s*(?:{[^}]*})?\s*([\s\S]*?)```/);
                                if (codeBlockMatch) {
                                    codeToApply = codeBlockMatch[1];
                                }

                                // Preserve formatting
                                codeToApply = codeToApply
                                    // 1. Convert escaped newlines to real newlines
                                    .replace(/\\n/g, '\n')
                                    // 2. Normalize line endings
                                    .replace(/\r\n/g, '\n')
                                    .replace(/\r/g, '\n')
                                    // 3. Preserve indentation but remove trailing spaces
                                    .split('\n')
                                    .map((line: string) => line.replace(/\s+$/, ''))
                                    .join('\n')
                                    // 4. Ensure single newline at end
                                    .trim() + '\n';

                                // Log the processed code for debugging
                                console.log('=== Processed Code ===');
                                console.log(codeToApply);
                                console.log('=== End Processed Code ===');

                                if (!message.file) {
                                    // Create new file with the code
                                    const fileName = `generated_${Date.now()}.${getFileExtension(codeToApply)}`;
                                    await fileManager.createFile(fileName, codeToApply);
                                    chatPanel?.webview.postMessage({ 
                                        command: "response", 
                                        text: `Created new file: ${fileName}`
                                    });
                                } else {
                                    // Try to update first, if fails then create
                                    try {
                                        await fileManager.updateFile(message.file, codeToApply);
                                        chatPanel?.webview.postMessage({ 
                                            command: "response", 
                                            text: `Updated file: ${message.file}`
                                        });
                                    } catch (updateError) {
                                        await fileManager.createFile(message.file, codeToApply);
                                        chatPanel?.webview.postMessage({ 
                                            command: "response", 
                                            text: `Created file: ${message.file}`
                                        });
                                    }
                                }
                            } catch (error) {
                                chatPanel?.webview.postMessage({ 
                                    command: "response", 
                                    text: `Error handling file operation: ${error instanceof Error ? error.message : 'Unknown error'}`
                                });
                            }
                        }
                        break;
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                chatPanel?.webview.postMessage({ 
                    command: "response", 
                    text: `Error: ${errorMessage}`
                });
            }
        });

        chatPanel.onDidDispose(() => {
            chatPanel = undefined;
        });
    });

    context.subscriptions.push(disposable);
}

async function handleFileCommand(text: string, fileManager: FileManager): Promise<string> {
    // Format: @filename [prompt]
    const parts = text.slice(1).split(' '); // Remove @ and split
    const fileName = parts[0];
    const prompt = parts.slice(1).join(' ');
    
    // If no filename provided after @
    if (!fileName) {
        const suggestions = await fileManager.getFileSuggestions('');
        if (suggestions.length === 0) {
            return 'No files found in workspace';
        }
        return `Available files:\n${suggestions.join('\n')}`;
    }

    try {
        // Try to read the file first
        const fileUri = vscode.Uri.file(path.join(fileManager.getWorkspaceRoot(), fileName));
        const fileContent = await vscode.workspace.fs.readFile(fileUri);
        const existingContent = fileContent.toString();

        // If no new prompt provided, show the current content
        if (!prompt) {
            const fileExt = path.extname(fileName).slice(1) || 'txt';
            return `Content of ${fileName}:\n\`\`\`${fileExt}\n${existingContent}\n\`\`\``;
        }

        // Send the prompt to Gemini with existing content as context
        const response = await askAI(
            prompt,
            existingContent,
            'gemini-2.0-flash'
        );

        // Extract code from the response
        let content = '';
        if (Array.isArray(response)) {
            for (const block of response as ResponseBlock[]) {
                if (block.type === 'code' && block.code) {
                    content = block.code;
                    break;
                }
            }
        }

        if (!content) {
            return 'Failed to generate code from the prompt';
        }

        // Update file with generated content
        await fileManager.updateFile(fileName, content);
        return `Updated file ${fileName} with generated content`;
    } catch (error) {
        // If file doesn't exist and prompt is provided
        if (prompt) {
            // Send the prompt to Gemini to generate content
            const response = await askAI(
                prompt,
                '', // No context needed for new file
                'gemini-2.0-flash'
            );

            // Extract code from the response
            let content = '';
            if (Array.isArray(response)) {
                for (const block of response as ResponseBlock[]) {
                    if (block.type === 'code' && block.code) {
                        content = block.code;
                        break;
                    }
                }
            }

            if (!content) {
                return 'Failed to generate code from the prompt';
            }

            // Create new file with generated content
            await fileManager.createFile(fileName, content);
            return `Created new file ${fileName} with generated content`;
        }
        return `File ${fileName} does not exist. Provide a prompt after the filename to create it.`;
    }
}

async function handleSlashCommand(text: string, fileManager: FileManager): Promise<string> {
    const [command, ...args] = text.slice(1).split(' ');
    let fileName = args[0];
    let prompt = args.slice(1).join(' ');

    switch (command.toLowerCase()) {
        case 'create':
            if (!fileName) {
                return 'Please provide a filename: /create filename content';
            }
            try {
                // Send the prompt to Gemini to generate content
                const response = await askAI(
                    prompt,
                    '', // No context needed for new file
                    'gemini-2.0-flash'
                );

                // Extract code from the response
                let content = '';
                if (Array.isArray(response)) {
                    for (const block of response as ResponseBlock[]) {
                        if (block.type === 'code' && block.code) {
                            content = block.code;
                            break;
                        }
                    }
                }

                if (!content) {
                    return 'Failed to generate code from the prompt';
                }

                await fileManager.createFile(fileName, content);
                return `Created file ${fileName} with generated content`;
            } catch (error) {
                throw new Error(`Failed to create file: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }

        case 'update':
            if (!fileName) {
                return 'Please provide a filename: /update filename content';
            }
            try {
                // If filename starts with @, remove it
                fileName = fileName.startsWith('@') ? fileName.slice(1) : fileName;
                
                // Try to read existing content first
                let existingContent = '';
                try {
                    const fileUri = vscode.Uri.file(path.join(fileManager.getWorkspaceRoot(), fileName));
                    const fileContent = await vscode.workspace.fs.readFile(fileUri);
                    existingContent = fileContent.toString();
                } catch (error) {
                    return `File ${fileName} does not exist. Use /create to create a new file.`;
                }

                // If no new prompt provided, show existing content
                if (!prompt) {
                    const fileExt = path.extname(fileName).slice(1) || 'txt';
                    return `Current content of ${fileName}:\n\`\`\`${fileExt}\n${existingContent}\n\`\`\`\nProvide a prompt to update the content.`;
                }

                // Send the prompt to Gemini with existing content as context
                const response = await askAI(
                    prompt,
                    existingContent,
                    'gemini-2.0-flash'
                );

                // Extract code from the response
                let content = '';
                if (Array.isArray(response)) {
                    for (const block of response as ResponseBlock[]) {
                        if (block.type === 'code' && block.code) {
                            content = block.code;
                            break;
                        }
                    }
                }

                if (!content) {
                    return 'Failed to generate code from the prompt';
                }

                // Update file with generated content
                await fileManager.updateFile(fileName, content);
                return `Updated file ${fileName} with generated content`;
            } catch (error) {
                throw new Error(`Failed to update file: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }

        case 'delete':
            if (!fileName) {
                return 'Please provide a filename: /delete filename';
            }
            try {
                await fileManager.deleteFile(fileName);
                return `Deleted file ${fileName}`;
            } catch (error) {
                throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }

        default:
            return `Unknown command: ${command}. Available commands:\n` +
                   `/create filename prompt - Create a new file with AI-generated content\n` +
                   `/update @filename prompt - Update file with AI-generated content\n` +
                   `/update @filename - Show current content\n` +
                   `/delete filename - Delete a file`;
    }
}

function getFileExtension(code: string): string {
    if (code.includes('<!DOCTYPE html>') || code.includes('<html>')) return 'html';
    if (code.includes('function') || code.includes('const') || code.includes('let')) return 'js';
    if (code.includes('interface') || code.includes('type ') || code.includes('namespace')) return 'ts';
    if (code.includes('class') && code.includes('public')) return 'java';
    if (code.includes('#include')) return 'cpp';
    return 'txt';
}

async function handleCreateFileCommand(text: string, fileManager: FileManager): Promise<string> {
    // Simple natural language parsing for file creation
    const words = text.split(' ');
    const createIndex = words.findIndex(w => w.toLowerCase() === 'create');
    const fileIndex = words.findIndex(w => w.toLowerCase() === 'file');
    
    if (createIndex === -1 || fileIndex === -1) {
        return "Could not understand the file creation command. Please use format: 'create file filename with content'";
    }

    const fileName = words[Math.max(createIndex, fileIndex) + 1];
    if (!fileName) {
        return "Please specify a filename";
    }

    const contentIndex = words.findIndex(w => w.toLowerCase() === 'with');
    let content = '';
    if (contentIndex !== -1) {
        content = words.slice(contentIndex + 1).join(' ');
    }

    await fileManager.createFile(fileName, content);
    return `Created file ${fileName} successfully${content ? ' with the specified content' : ''}`;
}

function getWebviewContent(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): string {
    const scriptUri = panel.webview.asWebviewUri(
        Uri.file(path.join(context.extensionPath, 'frontend', 'sidebar.js'))
    );

    const styleUri = panel.webview.asWebviewUri(
        Uri.file(path.join(context.extensionPath, 'frontend', 'styles.css'))
    );

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>AI Chat</title>
        <link rel="stylesheet" href="${styleUri}">
        <style>
            #model-selector-container {
                padding: 8px;
                background: var(--vscode-editor-background);
                border-bottom: 1px solid var(--vscode-panel-border);
                position: sticky;
                top: 0;
                z-index: 100;
            }
            #model-selector {
                width: 100%;
                padding: 4px 8px;
                background: var(--vscode-dropdown-background);
                color: var(--vscode-dropdown-foreground);
                border: 1px solid var(--vscode-dropdown-border);
                border-radius: 2px;
                outline: none;
                cursor: pointer;
            }
            #model-selector:focus {
                border-color: var(--vscode-focusBorder);
            }
            #chat-container {
                display: flex;
                flex-direction: column;
                height: 100vh;
            }
            #chat-messages {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
            }
            .input-container {
                padding: 16px;
                background: var(--vscode-editor-background);
                border-top: 1px solid var(--vscode-panel-border);
                position: relative;
            }
            #command-hint {
                position: absolute;
                top: -30px;
                left: 16px;
                right: 16px;
                padding: 4px 8px;
                background: var(--vscode-editorHoverWidget-background);
                border: 1px solid var(--vscode-editorHoverWidget-border);
                border-radius: 2px;
                font-size: 12px;
                color: var(--vscode-editorHoverWidget-foreground);
                display: none;
                z-index: 1000;
            }
            #chat-input {
                width: 100%;
                min-height: 60px;
                max-height: 200px;
                resize: vertical;
                padding: 8px;
                margin-bottom: 8px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 2px;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
            }
            #chat-input:focus {
                border-color: var(--vscode-focusBorder);
                outline: none;
            }
            #chat-input.command-mode {
                border-color: var(--vscode-terminal-ansiGreen);
            }
            #chat-input.file-mode {
                border-color: var(--vscode-terminal-ansiBlue);
            }
            #file-suggestions {
                position: absolute;
                bottom: 100%;
                left: 16px;
                right: 16px;
                background: var(--vscode-dropdown-background);
                border: 1px solid var(--vscode-dropdown-border);
                border-radius: 2px;
                max-height: 200px;
                overflow-y: auto;
                display: none;
                z-index: 1000;
            }
            .file-suggestion {
                padding: 8px 12px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .file-suggestion:hover {
                background: var(--vscode-list-hoverBackground);
            }
            .file-suggestion.selected {
                background: var(--vscode-list-activeSelectionBackground);
                color: var(--vscode-list-activeSelectionForeground);
            }
            .file-suggestion-icon {
                font-size: 14px;
                color: var(--vscode-terminal-ansiBlue);
            }
            .input-actions {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            #send-btn {
                padding: 6px 12px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 2px;
                cursor: pointer;
                font-size: 13px;
            }
            #send-btn:hover {
                background: var(--vscode-button-hoverBackground);
            }
            .input-hint {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                margin-left: 8px;
            }
        </style>
    </head>
    <body>
        <div id="chat-container">
            <div id="model-selector-container">
                <select id="model-selector">
                    <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                    <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash Lite</option>
                    <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                </select>
            </div>
            <div id="chat-messages"></div>
            <div class="input-container">
                <div id="command-hint"></div>
                <div id="file-suggestions"></div>
                <textarea
                    id="chat-input"
                    placeholder="Ask AI... (Use @ to reference files, / for commands)"
                    rows="3"
                ></textarea>
                <div class="input-actions">
                    <button id="send-btn">Send</button>
                    <span class="input-hint">
                        Commands: /create, /update, /delete • Files: Type @ to browse
                    </span>
                </div>
            </div>
        </div>
        <script src="${scriptUri}"></script>
    </body>
    </html>`;
}

export function deactivate() {
    console.log("Chat Cursor extension is deactivated.");
}
