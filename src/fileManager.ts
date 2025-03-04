import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export function modifyFile(fileName: string, newContent: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {return;}

    for (const folder of workspaceFolders) {
        const filePath = path.join(folder.uri.fsPath, fileName);
        if (fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, newContent, "utf8");
            vscode.window.showInformationMessage(`Updated: ${fileName}`);
        }
    }
}
