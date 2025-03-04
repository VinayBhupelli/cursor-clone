import * as vscode from "vscode";
import { askAI } from "./api";
import { FileManager } from "./fileManager";
import { ContextManager } from "./contextManager";
import { Uri } from "vscode";
import * as path from 'path';

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
                        chatPanel?.webview.postMessage({ command: "response", text: response });
                        break;

                    case "getFileSuggestions":
                        const suggestions = await fileManager.getFileSuggestions(message.query);
                        chatPanel?.webview.postMessage({ 
                            command: "fileSuggestions", 
                            suggestions 
                        });
                        break;

                    case "applyCode":
                        if (!message.file) {
                            // Create new file with the code
                            const fileName = `generated_${Date.now()}.${getFileExtension(message.code)}`;
                            await fileManager.createFile(fileName, message.code);
                            chatPanel?.webview.postMessage({ 
                                command: "response", 
                                text: `Created new file: ${fileName} with the code`
                            });
                        } else {
                            // Update existing file
                            await fileManager.updateFile(message.file, message.code);
                            chatPanel?.webview.postMessage({ 
                                command: "response", 
                                text: `Updated file: ${message.file}`
                            });
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
    // Format: @filename content
    const parts = text.slice(1).split(' '); // Remove @ and split
    const fileName = parts[0];
    const content = parts.slice(1).join(' ');

    if (!content) {
        // If no content provided, try to read the file
        try {
            const fileContent = await vscode.workspace.fs.readFile(
                vscode.Uri.file(path.join(fileManager.getWorkspaceRoot(), fileName))
            );
            return `Content of ${fileName}:\n\`\`\`\n${fileContent.toString()}\n\`\`\``;
        } catch {
            return `File ${fileName} does not exist. To create it, provide content after the filename.`;
        }
    }

    // Create or update the file
    try {
        await fileManager.createFile(fileName, content);
        return `Created/Updated file ${fileName}`;
    } catch (error) {
        try {
            await fileManager.updateFile(fileName, content);
            return `Updated file ${fileName}`;
        } catch (updateError) {
            throw new Error(`Failed to handle file operation: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}

async function handleSlashCommand(text: string, fileManager: FileManager): Promise<string> {
    const [command, ...args] = text.slice(1).split(' ');
    const fileName = args[0];
    const content = args.slice(1).join(' ');

    switch (command.toLowerCase()) {
        case 'create':
            if (!fileName) {
                return 'Please provide a filename: /create filename content';
            }
            await fileManager.createFile(fileName, content || '');
            return `Created file ${fileName}`;

        case 'update':
            if (!fileName) {
                return 'Please provide a filename: /update filename content';
            }
            await fileManager.updateFile(fileName, content || '');
            return `Updated file ${fileName}`;

        case 'delete':
            if (!fileName) {
                return 'Please provide a filename: /delete filename';
            }
            await fileManager.deleteFile(fileName);
            return `Deleted file ${fileName}`;

        default:
            return `Unknown command: ${command}. Available commands: /create, /update, /delete`;
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
            .code-block {
                position: relative;
                margin: 8px 0;
            }
            .code-block pre {
                background: var(--vscode-editor-background);
                padding: 12px;
                border-radius: 4px;
                overflow-x: auto;
            }
            .code-block .actions {
                position: absolute;
                top: 8px;
                right: 8px;
                display: flex;
                gap: 8px;
            }
            .code-block button {
                padding: 4px 8px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 2px;
                cursor: pointer;
            }
            .code-block button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            .file-suggestion {
                padding: 4px 8px;
                cursor: pointer;
                border-radius: 2px;
            }
            .file-suggestion:hover {
                background: var(--vscode-list-hoverBackground);
            }
            #file-suggestions {
                position: absolute;
                bottom: 100%;
                left: 0;
                right: 0;
                background: var(--vscode-dropdown-background);
                border: 1px solid var(--vscode-dropdown-border);
                border-radius: 2px;
                max-height: 200px;
                overflow-y: auto;
                display: none;
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
                <div id="file-suggestions"></div>
                <textarea
                    id="chat-input"
                    placeholder="Ask AI... (Use @ to reference files, / for commands like /create, /update, /delete)"
                    rows="3"
                ></textarea>
                <button id="send-btn">Send</button>
            </div>
        </div>
        <script src="${scriptUri}"></script>
    </body>
    </html>`;
}

export function deactivate() {
    console.log("Chat Cursor extension is deactivated.");
}
