import * as vscode from "vscode";
import { askAI } from "./api";
import { modifyFile } from "./fileManager";
import { ContextManager } from "./contextManager";
import { Uri } from "vscode";
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    let chatPanel: vscode.WebviewPanel | undefined;
    const contextManager = new ContextManager();

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
                if (message.command === "ask") {
                    const response = await askAI(
                        message.text, 
                        JSON.stringify(workspaceFiles),
                        message.model // Pass the selected model
                    );

                    if (message.text.startsWith("@")) {
                        const [fileName, ...changes] = message.text.split(" ");
                        await modifyFile(fileName.slice(1), changes.join(" "));
                    }

                    chatPanel?.webview.postMessage({ command: "response", text: response });
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
                <input type="text" id="chat-input" placeholder="Ask AI..." />
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
