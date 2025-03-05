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
    
    // Store last generated content for each file
    const lastGeneratedContent = new Map<string, string>();

    // Register command to get last generated content
    let getLastContentCommand = vscode.commands.registerCommand('chatCursor.getLastGeneratedContent', (fileName: string) => {
        return lastGeneratedContent.get(fileName);
    });

    // Store generated content when it's created
    const storeGeneratedContent = (fileName: string, content: string) => {
        lastGeneratedContent.set(fileName, content);
    };

    // Create and manage the webview panel
    function createChatPanel(viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            "aiChat",
            "AI Chat",
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    Uri.file(path.join(context.extensionPath, 'frontend')),
                    Uri.file(path.join(context.extensionPath, 'asset'))
                ],
                enableCommandUris: true
            }
        );

        const workspaceFiles = contextManager.loadWorkspaceFiles();
        panel.webview.html = getWebviewContent(context, panel);

        panel.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case "ask":
                        // Handle @ commands for file operations
                        if (message.text.startsWith('@')) {
                            const response = await handleFileCommand(message.text, fileManager, storeGeneratedContent, panel);
                            panel?.webview.postMessage({ command: "response", text: response });
                            return;
                        }
                        
                        // Handle / commands
                        if (message.text.startsWith('/')) {
                            const response = await handleSlashCommand(message.text, fileManager, storeGeneratedContent, panel);
                            panel?.webview.postMessage({ command: "response", text: response });
                            return;
                        }

                        // Handle natural language commands
                        if (message.text.toLowerCase().includes('create') && message.text.toLowerCase().includes('file')) {
                            const response = await handleCreateFileCommand(message.text, fileManager);
                            panel?.webview.postMessage({ command: "response", text: response });
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
                                        panel?.webview.postMessage({ 
                                            command: "response", 
                                            text: `Updated file: ${block.file}`
                                        });
                                    } catch (error) {
                                        try {
                                            await fileManager.createFile(block.file, block.code);
                                            panel?.webview.postMessage({ 
                                                command: "response", 
                                                text: `Created file: ${block.file}`
                                            });
                                        } catch (createError) {
                                            panel?.webview.postMessage({ 
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

                        panel?.webview.postMessage({ 
                            command: "response", 
                            text: formattedResponse 
                        });
                        break;

                    case "getFileSuggestions":
                        const suggestions = await fileManager.getFileSuggestions(message.query);
                        panel?.webview.postMessage({ 
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
                                    panel?.webview.postMessage({ 
                                        command: "response", 
                                        text: `Created new file: ${fileName}`
                                    });
                                } else {
                                    // Try to update first, if fails then create
                                    try {
                                        await fileManager.updateFile(message.file, codeToApply);
                                        panel?.webview.postMessage({ 
                                            command: "response", 
                                            text: `Updated file: ${message.file}`
                                        });
                                    } catch (updateError) {
                                        await fileManager.createFile(message.file, codeToApply);
                                        panel?.webview.postMessage({ 
                                            command: "response", 
                                            text: `Created file: ${message.file}`
                                        });
                                    }
                                }
                            } catch (error) {
                                panel?.webview.postMessage({ 
                                    command: "response", 
                                    text: `Error handling file operation: ${error instanceof Error ? error.message : 'Unknown error'}`
                                });
                            }
                        }
                        break;
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                panel?.webview.postMessage({ 
                    command: "response", 
                    text: `Error: ${errorMessage}`
                });
            }
        });

        return panel;
    }

    // Register view provider
    const provider = vscode.window.registerWebviewViewProvider('aiChatView', {
        resolveWebviewView(webviewView) {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [
                    Uri.file(path.join(context.extensionPath, 'frontend')),
                    Uri.file(path.join(context.extensionPath, 'asset'))
                ]
            };
            webviewView.webview.html = getWebviewContent(context, webviewView as any);

            // Reuse the same message handler
            webviewView.webview.onDidReceiveMessage(async (message) => {
                try {
                    switch (message.command) {
                        case "ask":
                            // Handle @ commands for file operations
                            if (message.text.startsWith('@')) {
                                const response = await handleFileCommand(message.text, fileManager, storeGeneratedContent, webviewView as any);
                                webviewView.webview.postMessage({ command: "response", text: response });
                                return;
                            }
                            
                            // Handle / commands
                            if (message.text.startsWith('/')) {
                                const response = await handleSlashCommand(message.text, fileManager, storeGeneratedContent, webviewView as any);
                                webviewView.webview.postMessage({ command: "response", text: response });
                                return;
                            }

                            // Handle natural language commands
                            if (message.text.toLowerCase().includes('create') && message.text.toLowerCase().includes('file')) {
                                const response = await handleCreateFileCommand(message.text, fileManager);
                                webviewView.webview.postMessage({ command: "response", text: response });
                                return;
                            }

                            const response = await askAI(
                                message.text, 
                                JSON.stringify(contextManager.loadWorkspaceFiles()),
                                message.model
                            );

                            // Process each block in the response
                            for (const block of response as ResponseBlock[]) {
                                if (block.type === 'code') {
                                    if (block.file && block.code) {
                                        // If code block has a file specified, create/update the file
                                        try {
                                            await fileManager.updateFile(block.file, block.code);
                                            webviewView.webview.postMessage({ 
                                                command: "response", 
                                                text: `Updated file: ${block.file}`
                                            });
                                        } catch (error) {
                                            try {
                                                await fileManager.createFile(block.file, block.code);
                                                webviewView.webview.postMessage({ 
                                                    command: "response", 
                                                    text: `Created file: ${block.file}`
                                                });
                                            } catch (createError) {
                                                webviewView.webview.postMessage({ 
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

                            webviewView.webview.postMessage({ 
                                command: "response", 
                                text: formattedResponse 
                            });
                            break;

                        case "getFileSuggestions":
                            const suggestions = await fileManager.getFileSuggestions(message.query);
                            webviewView.webview.postMessage({ 
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
                                        webviewView.webview.postMessage({ 
                                            command: "response", 
                                            text: `Created new file: ${fileName}`
                                        });
                                    } else {
                                        // Try to update first, if fails then create
                                        try {
                                            await fileManager.updateFile(message.file, codeToApply);
                                            webviewView.webview.postMessage({ 
                                                command: "response", 
                                                text: `Updated file: ${message.file}`
                                            });
                                        } catch (updateError) {
                                            await fileManager.createFile(message.file, codeToApply);
                                            webviewView.webview.postMessage({ 
                                                command: "response", 
                                                text: `Created file: ${message.file}`
                                            });
                                        }
                                    }
                                } catch (error) {
                                    webviewView.webview.postMessage({ 
                                        command: "response", 
                                        text: `Error handling file operation: ${error instanceof Error ? error.message : 'Unknown error'}`
                                    });
                                }
                            }
                            break;
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
                    webviewView.webview.postMessage({ 
                        command: "response", 
                        text: `Error: ${errorMessage}`
                    });
                }
            });
        }
    });

    // Register the sidebar command (preserves existing functionality)
    let disposable = vscode.commands.registerCommand("chatCursor.showSidebar", async () => {
        if (chatPanel) {
            chatPanel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        chatPanel = createChatPanel();
        chatPanel.onDidDispose(() => {
            chatPanel = undefined;
        });
    });

    context.subscriptions.push(provider, disposable, getLastContentCommand);
}

async function handleFileCommand(text: string, fileManager: FileManager, storeContent: (fileName: string, content: string) => void, panel?: vscode.WebviewPanel): Promise<string> {
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
        let existingContent = '';
        try {
            const fileUri = vscode.Uri.file(path.join(fileManager.getWorkspaceRoot(), fileName));
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            existingContent = fileContent.toString();
        } catch (error) {
            // File doesn't exist, will create new
        }

        // If no new prompt provided, show the current content
        if (!prompt) {
            const fileExt = path.extname(fileName).slice(1) || 'txt';
            return existingContent ? 
                `Content of ${fileName}:\n\`\`\`${fileExt}\n${existingContent}\n\`\`\`` :
                `File ${fileName} does not exist. Provide a prompt to create it.`;
        }

        // Send the prompt to Gemini
        const response = await askAI(
            prompt,
            existingContent ? `Current file content:\n${existingContent}\n\nGenerate additional code to append.` : '',
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

        // Store the content for later use
        const finalContent = existingContent ? 
            `${existingContent}\n\n/* New code */\n${content}` : 
            content;
        storeContent(fileName, finalContent);

        // Show preview with both existing and new content
        const fileExt = path.extname(fileName).slice(1) || 'txt';
        return `${existingContent ? 'Current content:\n```' + fileExt + '\n' + existingContent + '\n```\n\n' : ''}Generated code to ${existingContent ? 'append' : 'create'}:\n\`\`\`${fileExt}\n${content}\n\`\`\`\n\n<div class="apply-button-container"><button class="apply-button" onclick="applyChanges('${fileName}')">Apply Changes</button></div>`;

    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}

async function handleSlashCommand(text: string, fileManager: FileManager, storeContent: (fileName: string, content: string) => void, panel?: vscode.WebviewPanel): Promise<string> {
    const [command, ...args] = text.slice(1).split(' ');
    let fileName = args[0];
    let prompt = args.slice(1).join(' ');

    switch (command.toLowerCase()) {
        case 'apply':
            if (!fileName) {
                return 'Please provide a filename: /apply filename';
            }
            try {
                // Get the last generated content from memory
                const lastContent = await vscode.commands.executeCommand<string>('chatCursor.getLastGeneratedContent', fileName);
                if (!lastContent) {
                    return 'No generated content found for this file. Generate content first using @ or /create or /update commands.';
                }

                // Check if file exists and handle accordingly
                try {
                    const fileUri = vscode.Uri.file(path.join(fileManager.getWorkspaceRoot(), fileName));
                    let fileExists = false;
                    try {
                        await vscode.workspace.fs.stat(fileUri);
                        fileExists = true;
                    } catch {
                        fileExists = false;
                    }

                    if (fileExists) {
                        // File exists, check if this is an append operation
                        const isAppendOperation = lastContent.includes('/* New code */');
                        if (isAppendOperation) {
                            // Get only the new code part
                            const newCodeParts = lastContent.split('/* New code */');
                            if (newCodeParts.length > 1) {
                                // Update with only the new code appended
                                const existingContent = (await vscode.workspace.fs.readFile(fileUri)).toString();
                                const newContent = existingContent + '\n\n/* New code */\n' + newCodeParts[1].trim();
                                await fileManager.updateFile(fileName, newContent);
                                return `Updated file ${fileName} with the new code appended`;
                            }
                        }
                        // Not an append operation, just update the file
                        await fileManager.updateFile(fileName, lastContent);
                        return `Updated file ${fileName} with the generated content`;
                    } else {
                        // File doesn't exist, create it
                        await fileManager.createFile(fileName, lastContent);
                        return `Created file ${fileName} with the generated content`;
                    }
                } catch (error) {
                    throw new Error(`Failed to handle file operation: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            } catch (error) {
                throw new Error(`Failed to apply changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }

        case 'create':
        case 'update':
            if (!fileName) {
                return `Please provide a filename: /${command} filename content`;
            }

            // If filename starts with @, remove it
            fileName = fileName.startsWith('@') ? fileName.slice(1) : fileName;

            // Try to read existing content first
            let existingContent = '';
            try {
                const fileUri = vscode.Uri.file(path.join(fileManager.getWorkspaceRoot(), fileName));
                const fileContent = await vscode.workspace.fs.readFile(fileUri);
                existingContent = fileContent.toString();
            } catch (error) {
                if (command === 'update') {
                    return `File ${fileName} does not exist. Use /create to create a new file.`;
                }
            }

            // If no new prompt provided, show existing content
            if (!prompt) {
                const fileExt = path.extname(fileName).slice(1) || 'txt';
                return existingContent ? 
                    `Current content of ${fileName}:\n\`\`\`${fileExt}\n${existingContent}\n\`\`\`\nProvide a prompt to update the content.` :
                    'Please provide content to create the file.';
            }

            // Send the prompt to Gemini
            const response = await askAI(
                prompt,
                existingContent ? `Current file content:\n${existingContent}\n\nGenerate additional code to append.` : '',
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

            // Store the content for later use
            const finalContent = existingContent && command === 'update' ? 
                `${existingContent}\n\n/* New code */\n${content}` : 
                content;
            storeContent(fileName, finalContent);

            // Show preview with both existing and new content
            const fileExt = path.extname(fileName).slice(1) || 'txt';
            return `${existingContent ? 'Current content:\n```' + fileExt + '\n' + existingContent + '\n```\n\n' : ''}Generated code to ${existingContent ? 'append' : 'create'}:\n\`\`\`${fileExt}\n${content}\n\`\`\`\n\n<div class="apply-button-container"><button class="apply-button" onclick="applyChanges('${fileName}')">Apply Changes</button></div>`;

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

    // Add logo URI
    const logoUri = panel.webview.asWebviewUri(
        Uri.file(path.join(context.extensionPath, 'asset', 'ai.png'))
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
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .input-wrapper {
                position: relative;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .input-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 4px 8px;
                background: var(--vscode-editorHoverWidget-background);
                border-radius: 4px 4px 0 0;
                border: 1px solid var(--vscode-input-border);
                border-bottom: none;
            }

            .input-header-left {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
            }

            .input-header-right {
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .input-status {
                font-size: 11px;
                padding: 2px 6px;
                border-radius: 3px;
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
            }

            #chat-input {
                width: 100%;
                min-height: 100px;
                max-height: 300px;
                padding: 12px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 0 0 4px 4px;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                line-height: 1.5;
                resize: vertical;
                transition: all 0.2s ease;
            }

            #chat-input:focus {
                border-color: var(--vscode-focusBorder);
                outline: none;
                box-shadow: 0 0 0 1px var(--vscode-focusBorder);
            }

            #chat-input.command-mode {
                border-color: var(--vscode-terminal-ansiGreen);
            }

            #chat-input.file-mode {
                border-color: var(--vscode-terminal-ansiBlue);
            }

            .input-footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 4px 8px;
                background: var(--vscode-editorHoverWidget-background);
                border-radius: 0 0 4px 4px;
                border: 1px solid var(--vscode-input-border);
                border-top: none;
            }

            .input-actions {
                display: flex;
                gap: 8px;
                align-items: center;
            }

            #send-btn {
                padding: 6px 16px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                display: flex;
                align-items: center;
                gap: 6px;
                transition: all 0.2s ease;
            }

            #send-btn:hover {
                background: var(--vscode-button-hoverBackground);
                transform: translateY(-1px);
            }

            #send-btn:active {
                transform: translateY(0);
            }

            .input-hint {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .input-shortcuts {
                display: flex;
                gap: 8px;
            }

            .shortcut-item {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 2px 6px;
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                border-radius: 3px;
                font-size: 11px;
            }

            .shortcut-key {
                font-family: monospace;
                font-size: 10px;
                padding: 1px 4px;
                background: var(--vscode-editor-background);
                border-radius: 2px;
            }

            #file-suggestions {
                position: absolute;
                bottom: 100%;
                left: 16px;
                right: 16px;
                background: var(--vscode-dropdown-background);
                border: 1px solid var(--vscode-dropdown-border);
                border-radius: 4px;
                max-height: 200px;
                overflow-y: auto;
                display: none;
                z-index: 1000;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            }

            .file-suggestion {
                padding: 8px 12px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: background-color 0.2s;
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

            #command-hint {
                position: absolute;
                top: -30px;
                left: 16px;
                right: 16px;
                padding: 6px 12px;
                background: var(--vscode-editorHoverWidget-background);
                border: 1px solid var(--vscode-editorHoverWidget-border);
                border-radius: 4px;
                font-size: 12px;
                color: var(--vscode-editorHoverWidget-foreground);
                display: none;
                z-index: 1000;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            }

            .header-container {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 16px;
                background: var(--vscode-editor-background);
                border-bottom: 1px solid var(--vscode-panel-border);
                position: sticky;
                top: 0;
                z-index: 100;
            }

            .header-logo {
                width: 24px;
                height: 24px;
                object-fit: contain;
            }

            .header-title {
                font-size: 14px;
                font-weight: 500;
                color: var(--vscode-foreground);
                flex: 1;
            }

            #model-selector-container {
                flex: 1;
                padding: 0;
                background: transparent;
                border: none;
            }

            #model-selector {
                width: 100%;
                padding: 4px 8px;
                background: var(--vscode-dropdown-background);
                color: var(--vscode-dropdown-foreground);
                border: 1px solid var(--vscode-dropdown-border);
                border-radius: 4px;
                outline: none;
                cursor: pointer;
                font-size: 12px;
            }

            /* Update chat container to account for new header */
            #chat-container {
                display: flex;
                flex-direction: column;
                height: 100vh;
                background: var(--vscode-editor-background);
            }
        </style>
    </head>
    <body>
        <div id="chat-container">
            <div class="header-container">
                <img src="${logoUri}" alt="AI Chat" class="header-logo">
                <div class="header-title">AI Chat Assistant</div>
                <div id="model-selector-container">
                    <select id="model-selector">
                        <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                        <option value="gemini-2.0-flash-lite">Gemini 2.0 Flash Lite</option>
                        <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                    </select>
                </div>
            </div>
            <div id="chat-messages"></div>
            <div class="input-container">
                <div id="command-hint"></div>
                <div id="file-suggestions"></div>
                <div class="input-wrapper">
                    <div class="input-header">
                        <div class="input-header-left">
                            <span>AI Chat Input</span>
                            <span class="input-status">Ready</span>
                        </div>
                        <div class="input-header-right">
                            <span class="shortcut-item">
                                <span class="shortcut-key">Ctrl</span> + <span class="shortcut-key">Enter</span>
                                <span>Send</span>
                            </span>
                        </div>
                    </div>
                    <textarea
                        id="chat-input"
                        placeholder="Ask AI... (Use @ to reference files, / for commands)"
                        rows="4"
                    ></textarea>
                    <div class="input-footer">
                        <div class="input-actions">
                            <button id="send-btn">
                                <span>Send</span>
                            </button>
                        </div>
                        <div class="input-hint">
                            <div class="input-shortcuts">
                                <span class="shortcut-item">
                                    <span class="shortcut-key">@</span>
                                    <span>Files</span>
                                </span>
                                <span class="shortcut-item">
                                    <span class="shortcut-key">/</span>
                                    <span>Commands</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <script>
            function applyChanges(fileName) {
                vscode.postMessage({
                    command: 'ask',
                    text: '/apply ' + fileName
                });
            }
        </script>
        <script src="${scriptUri}"></script>
    </body>
    </html>`;
}

export function deactivate() {
    console.log("Chat Cursor extension is deactivated.");
}
