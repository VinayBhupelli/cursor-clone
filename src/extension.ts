import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from "dotenv";

dotenv.config(); // Load environment variables

const GEMINI_API_KEY = "AIzaSyC2TMwG7ewvLrzZoNG5IKs12KOET26lrbA";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage("Chat Cursor Extension Activated! 🚀");

  // ✅ AI Code Generation Command
  let generateCodeCommand = vscode.commands.registerCommand("chatCursor.generateCode", async () => {
    const userQuery = await vscode.window.showInputBox({ prompt: "Describe the code you need" });
    if (!userQuery) return;

    vscode.window.showInformationMessage("Generating AI-powered code...");

    try {
      const prompt = `${userQuery}\n\nReturn the code first, followed by a line of ******, then explain the code below it. in simple format`;
      const result = await model.generateContent(prompt);
      let response = result.response.text();

      if (!response) throw new Error("No response from Gemini API");

      // Split response into code and details
      let parts = response.split("******");
      if (parts.length < 2) throw new Error("AI response format incorrect");

      let code = parts[0].trim().split("\n").slice(1, -1).join("\n"); // Remove first & last line
      let details = parts[1].trim().split("\n").map((line) => `// ${line}`).join("\n"); // Convert details to comments

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No file open to insert code.");
        return;
      }

      const edit = new vscode.WorkspaceEdit();
      edit.insert(editor.document.uri, editor.selection.active, `\n${code}\n${details}\n`);
      await vscode.workspace.applyEdit(edit);

      vscode.window.showInformationMessage("AI-generated code inserted successfully!");
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to generate code: ${error.message}`);
      console.error(error);
    }
  });
  

  // ✅ AI Code Update Command
  let updateCodeCommand = vscode.commands.registerCommand("chatCursor.updateCode", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No file open.");
      return;
    }

    const selectedText = editor.document.getText(editor.selection);
    if (!selectedText) {
      vscode.window.showErrorMessage("Select some code to update.");
      return;
    }

    vscode.window.showInformationMessage("Updating selected code using AI...");

    try {
      const prompt = `Improve the following code and provide a better version:\n\n${selectedText}`;
      const result = await model.generateContent(prompt);
      const updatedCode = result.response.text();

      if (!updatedCode) throw new Error("No response from Gemini API");

      const edit = new vscode.WorkspaceEdit();
      edit.replace(editor.document.uri, editor.selection, updatedCode);
      await vscode.workspace.applyEdit(edit);

      vscode.window.showInformationMessage("Code updated successfully!");
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to update code: ${error.message}`);
      console.error(error);
    }
  });

  // ✅ Create File Command
  let createFileCommand = vscode.commands.registerCommand("chatCursor.createFile", async () => {
    const fileName = await vscode.window.showInputBox({ prompt: "Enter the new file name (with extension)" });
    if (!fileName) return;

    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folderPath) {
      vscode.window.showErrorMessage("No folder is open.");
      return;
    }

    const filePath = path.join(folderPath, fileName);
    if (fs.existsSync(filePath)) {
      vscode.window.showErrorMessage("File already exists.");
      return;
    }

    fs.writeFileSync(filePath, "// New file created by Chat Cursor\n");
    vscode.window.showInformationMessage(`File created: ${fileName}`);

    vscode.workspace.openTextDocument(filePath).then((doc) => vscode.window.showTextDocument(doc));
  });

  // ✅ Delete File Command
  let deleteFileCommand = vscode.commands.registerCommand("chatCursor.deleteFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("No file open.");
      return;
    }

    const filePath = editor.document.uri.fsPath;
    try {
      fs.unlinkSync(filePath);
      vscode.window.showInformationMessage("File deleted successfully!");

      vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } catch (error: any) {
      vscode.window.showErrorMessage(`Failed to delete file: ${error.message}`);
    }
  });

  // ✅ Register Commands
  context.subscriptions.push(generateCodeCommand);
  context.subscriptions.push(updateCodeCommand);
  context.subscriptions.push(createFileCommand);
  context.subscriptions.push(deleteFileCommand);
}

export function deactivate() {
  vscode.window.showInformationMessage("Chat Cursor Extension Deactivated.");
}
