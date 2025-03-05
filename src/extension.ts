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
                ],
                enableCommandUris: true
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
                            const response = await handleFileCommand(message.text, fileManager, storeGeneratedContent, chatPanel);
                            chatPanel?.webview.postMessage({ command: "response", text: response });
                            return;
                        }
                        
                        // Handle / commands
                        if (message.text.startsWith('/')) {
                            const response = await handleSlashCommand(message.text, fileManager, storeGeneratedContent, chatPanel);
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
                padding: 20px;
                display: flex;
                flex-direction: column;
                gap: 20px;
                font-family: var(--vscode-editor-font-family);
                line-height: 1.6;
            }
            .message {
                display: flex;
                gap: 16px;
                padding: 12px 16px;
                border-radius: 8px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-panel-border);
                animation: fadeIn 0.3s ease;
                max-width: 90%;
            }
            .message.user {
                margin-left: auto;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
            }
            .message.assistant {
                margin-right: auto;
                background: var(--vscode-editorWidget-background);
            }
            .message-avatar {
                width: 32px;
                height: 32px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 16px;
                flex-shrink: 0;
            }
            .message.user .message-avatar {
                background: var(--vscode-button-hoverBackground);
                color: var(--vscode-button-foreground);
            }
            .message.assistant .message-avatar {
                background: var(--vscode-activityBarBadge-background);
                color: var(--vscode-activityBarBadge-foreground);
            }
            .message-content {
                display: flex;
                flex-direction: column;
                gap: 8px;
                overflow-x: auto;
                max-width: 100%;
            }
            .message-header {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
            }
            .message-time {
                font-size: 11px;
                opacity: 0.7;
            }
            .message-text {
                white-space: pre-wrap;
                word-break: break-word;
            }
            .message-text p {
                margin: 0 0 12px 0;
            }
            .message-text p:last-child {
                margin-bottom: 0;
            }
            .code-block {
                position: relative;
                margin: 12px 0;
                background: var(--vscode-editor-background);
                border-radius: 6px;
                border: 1px solid var(--vscode-panel-border);
            }
            .code-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                background: var(--vscode-editorGroupHeader-tabsBackground);
                border-bottom: 1px solid var(--vscode-panel-border);
                border-radius: 6px 6px 0 0;
                font-family: var(--vscode-font-family);
                font-size: 12px;
            }
            .code-language {
                display: flex;
                align-items: center;
                gap: 6px;
                color: var(--vscode-descriptionForeground);
            }
            .code-actions {
                display: flex;
                gap: 8px;
            }
            .code-action-button {
                padding: 4px 8px;
                font-size: 11px;
                border-radius: 3px;
                border: 1px solid var(--vscode-button-background);
                background: transparent;
                color: var(--vscode-button-background);
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .code-action-button:hover {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
            }
            .code-action-button.apply {
                border-color: var(--vscode-terminal-ansiGreen);
                color: var(--vscode-terminal-ansiGreen);
            }
            .code-action-button.apply:hover {
                background: var(--vscode-terminal-ansiGreen);
                color: var(--vscode-button-foreground);
            }
            .code-content {
                padding: 12px;
                overflow-x: auto;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                line-height: 1.5;
                tab-size: 4;
            }
            .code-content pre {
                margin: 0;
                white-space: pre;
            }
            .code-content code {
                font-family: inherit;
            }
            .apply-button-container {
                margin-top: 12px;
                display: flex;
                gap: 8px;
            }
            .apply-button {
                padding: 6px 16px;
                font-size: 12px;
                border-radius: 4px;
                background: var(--vscode-terminal-ansiGreen);
                color: var(--vscode-button-foreground);
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 6px;
                transition: all 0.2s ease;
            }
            .apply-button:hover {
                filter: brightness(1.1);
                transform: translateY(-1px);
            }
            .apply-button:active {
                transform: translateY(0);
            }
            .copy-button {
                padding: 6px 16px;
                font-size: 12px;
                border-radius: 4px;
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 6px;
                transition: all 0.2s ease;
            }
            .copy-button:hover {
                filter: brightness(1.1);
                transform: translateY(-1px);
            }
            .inline-code {
                padding: 2px 6px;
                border-radius: 3px;
                background: var(--vscode-textBlockQuote-background);
                font-family: var(--vscode-editor-font-family);
                font-size: 0.9em;
            }
            .message-divider {
                display: flex;
                align-items: center;
                gap: 12px;
                margin: 20px 0;
                color: var(--vscode-descriptionForeground);
                font-size: 12px;
            }
            .message-divider::before,
            .message-divider::after {
                content: "";
                flex: 1;
                height: 1px;
                background: var(--vscode-panel-border);
            }
            @keyframes fadeIn {
                from {
                    opacity: 0;
                    transform: translateY(10px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            /* Syntax highlighting */
            .token.comment { color: var(--vscode-editor-foreground); opacity: 0.5; }
            .token.keyword { color: var(--vscode-symbolIcon-keywordForeground); }
            .token.string { color: var(--vscode-symbolIcon-stringForeground); }
            .token.number { color: var(--vscode-symbolIcon-numberForeground); }
            .token.function { color: var(--vscode-symbolIcon-functionForeground); }
            .token.class-name { color: var(--vscode-symbolIcon-classForeground); }
            .token.operator { color: var(--vscode-symbolIcon-operatorForeground); }
            /* Keep existing input container styles below */
            
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
            <div id="chat-messages">
                <!-- Messages will be dynamically added here -->
            </div>
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
            // Add message rendering function
            function formatMessage(content, isUser = false) {
                const messageDiv = document.createElement('div');
                messageDiv.className = \`message \${isUser ? 'user' : 'assistant'}\`;
                
                const avatar = document.createElement('div');
                avatar.className = 'message-avatar';
                avatar.textContent = isUser ? '👤' : '🤖';
                
                const messageContent = document.createElement('div');
                messageContent.className = 'message-content';
                
                const header = document.createElement('div');
                header.className = 'message-header';
                header.innerHTML = \`
                    <span>\${isUser ? 'You' : 'Assistant'}</span>
                    <span class="message-time">\${new Date().toLocaleTimeString()}</span>
                \`;
                
                const text = document.createElement('div');
                text.className = 'message-text';
                
                // Process code blocks
                content = content.replace(/\`\`\`([\\w]*)(\\s*{[^}]*})?(\\n|\\s)([\\s\\S]*?)\`\`\`/g, (match, lang, meta, newline, code) => {
                    const language = lang || 'plaintext';
                    const fileMatch = meta?.match(/{file:\\s*([^}]+)}/);
                    const fileName = fileMatch ? fileMatch[1].trim() : '';
                    
                    return \`
                        <div class="code-block">
                            <div class="code-header">
                                <div class="code-language">
                                    <span>\${language}</span>
                                    \${fileName ? \`<span>• \${fileName}</span>\` : ''}
                                </div>
                                <div class="code-actions">
                                    <button class="code-action-button" onclick="copyCode(this)">Copy</button>
                                    \${fileName ? \`<button class="code-action-button apply" onclick="applyChanges('\${fileName}')">Apply</button>\` : ''}
                                </div>
                            </div>
                            <div class="code-content">
                                <pre><code class="\${language}">\${code.trim()}</code></pre>
                            </div>
                        </div>
                    \`;
                });
                
                // Process inline code
                content = content.replace(/\`([^\`]+)\`/g, '<code class="inline-code">$1</code>');
                
                text.innerHTML = content;
                
                messageContent.appendChild(header);
                messageContent.appendChild(text);
                
                messageDiv.appendChild(avatar);
                messageDiv.appendChild(messageContent);
                
                return messageDiv;
            }

            // Add copy code function
            function copyCode(button) {
                const codeBlock = button.closest('.code-block');
                const code = codeBlock.querySelector('code').textContent;
                navigator.clipboard.writeText(code);
                
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.style.backgroundColor = 'var(--vscode-terminal-ansiGreen)';
                button.style.color = 'var(--vscode-button-foreground)';
                
                setTimeout(() => {
                    button.textContent = originalText;
                    button.style.backgroundColor = '';
                    button.style.color = '';
                }, 2000);
            }

            // Keep existing applyChanges function
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
