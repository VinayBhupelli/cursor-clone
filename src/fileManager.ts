import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export class FileManager {
    private static instance: FileManager;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private workspaceRoot: string | undefined;
    private readonly maxFileSize = 50 * 1024 * 1024; // 50MB limit
    private readonly forbiddenChars = /[<>:"|?*]/g;

    private constructor() {
        this.setupWorkspace();
    }

    static getInstance(): FileManager {
        if (!FileManager.instance) {
            FileManager.instance = new FileManager();
        }
        return FileManager.instance;
    }

    getWorkspaceRoot(): string {
        if (!this.workspaceRoot) {
            throw new Error('No workspace folder is open');
        }
        return this.workspaceRoot;
    }

    private setupWorkspace() {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            this.setupFileWatcher();
        }
    }

    private setupFileWatcher() {
        this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
        
        this.fileWatcher.onDidCreate((uri) => {
            vscode.window.showInformationMessage(`File created: ${path.basename(uri.fsPath)}`);
        });

        this.fileWatcher.onDidChange((uri) => {
            vscode.window.showInformationMessage(`File changed: ${path.basename(uri.fsPath)}`);
        });

        this.fileWatcher.onDidDelete((uri) => {
            vscode.window.showInformationMessage(`File deleted: ${path.basename(uri.fsPath)}`);
        });
    }

    private validatePath(filePath: string): string {
        if (!filePath) {
            throw new Error('File path cannot be empty');
        }

        // Remove any forbidden characters
        const sanitizedPath = filePath.replace(this.forbiddenChars, '_');
        
        // Ensure the path doesn't try to escape workspace
        const normalizedPath = path.normalize(sanitizedPath).replace(/^(\.\.(\/|\\|$))+/, '');
        
        return normalizedPath;
    }

    private async validateFileOperation(fullPath: string, content?: string): Promise<void> {
        if (!this.workspaceRoot) {
            throw new Error('No workspace folder is open');
        }

        // Check if path is within workspace
        const relativePath = path.relative(this.workspaceRoot, fullPath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            throw new Error('File operation not allowed outside workspace');
        }

        // Check content size if provided
        if (content && Buffer.byteLength(content, 'utf8') > this.maxFileSize) {
            throw new Error('File content exceeds maximum size limit');
        }

        // Check for system files
        const isSystemFile = /^(\.git|\.vscode|node_modules)/.test(relativePath);
        if (isSystemFile) {
            throw new Error('Operation not allowed on system files');
        }
    }

    private normalizeLineEndings(content: string): string {
        // First split by semicolons and braces to identify statement boundaries
        let normalized = content;
        
        // Replace semicolons with semicolon + newline if not already followed by newline
        normalized = normalized.replace(/;(?!\n)/g, ';\n');
        
        // Add newlines after opening braces if not already present
        normalized = normalized.replace(/{(?!\n)/g, '{\n');
        
        // Add newlines before closing braces if not already present
        normalized = normalized.replace(/(?!\n)}/g, '\n}');
        
        // Add newlines after closing braces if not followed by else, catch, etc
        normalized = normalized.replace(/}(?!\n)(?!else|catch|finally|while)/g, '}\n');
        
        // Handle function declarations
        normalized = normalized.replace(/\)\s*{/g, ') {\n');
        
        // Handle if conditions
        normalized = normalized.replace(/if\s*\([^)]+\)\s*(?={)/g, match => `${match}\n`);
        
        // Handle for loops
        normalized = normalized.replace(/for\s*\([^)]+\)\s*(?={)/g, match => `${match}\n`);
        
        // Handle includes and defines (for C/C++)
        normalized = normalized.replace(/(#include\s*<[^>]+>|#define\s+[^\n]+)/g, '$1\n');
        
        // Convert all remaining line endings to \n
        normalized = normalized.replace(/\r\n|\r/g, '\n');
        
        // Fix multiple consecutive line breaks
        normalized = normalized.replace(/\n\s*\n\s*\n/g, '\n\n');
        
        // Apply indentation
        normalized = this.formatCode(normalized);
        
        // Ensure content ends with a newline
        if (!normalized.endsWith('\n')) {
            normalized += '\n';
        }
        
        // If on Windows, convert to CRLF
        if (process.platform === 'win32') {
            normalized = normalized.replace(/\n/g, '\r\n');
        }
        
        return normalized;
    }

    private formatCode(content: string): string {
        const lines = content.split('\n');
        let indentLevel = 0;
        const indentSize = 4;
        
        return lines.map(line => {
            const trimmedLine = line.trim();
            
            // Decrease indent for lines starting with closing brackets
            if (trimmedLine.startsWith('}') || trimmedLine.startsWith(']') || trimmedLine.startsWith(')')) {
                indentLevel = Math.max(0, indentLevel - 1);
            }
            
            // Special handling for else statements
            if (trimmedLine.startsWith('else')) {
                indentLevel = Math.max(0, indentLevel - 1);
            }
            
            // Add indentation
            const indentedLine = ' '.repeat(indentLevel * indentSize) + trimmedLine;
            
            // Increase indent for lines ending with opening brackets
            if (trimmedLine.endsWith('{') || trimmedLine.endsWith('[') || 
                (trimmedLine.includes('{') && !trimmedLine.includes('}'))) {
                indentLevel++;
            }
            
            return indentedLine;
        }).join('\n');
    }

    async createFile(filePath: string, content: string): Promise<void> {
        try {
            const sanitizedPath = this.validatePath(filePath);
            const fullPath = path.join(this.workspaceRoot!, sanitizedPath);
            
            await this.validateFileOperation(fullPath, content);

            const directory = path.dirname(fullPath);

            // Create directory if it doesn't exist
            await fs.promises.mkdir(directory, { recursive: true });

            // Process and write file with proper formatting
            const processedContent = this.normalizeLineEndings(content);
            await vscode.workspace.fs.writeFile(
                vscode.Uri.file(fullPath),
                Buffer.from(processedContent, 'utf8')
            );

            // Open the file in editor
            const document = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(document);

            return;
        } catch (error) {
            throw new Error(`Failed to create file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async updateFile(filePath: string, content: string): Promise<void> {
        try {
            const sanitizedPath = this.validatePath(filePath);
            const fullPath = path.join(this.workspaceRoot!, sanitizedPath);
            
            await this.validateFileOperation(fullPath, content);

            // Create file if it doesn't exist
            if (!fs.existsSync(fullPath)) {
                await this.createFile(filePath, content);
                return;
            }

            // Check if file is writable
            try {
                await fs.promises.access(fullPath, fs.constants.W_OK);
            } catch {
                throw new Error('File is not writable');
            }

            // Create backup
            const backupPath = `${fullPath}.bak`;
            await fs.promises.copyFile(fullPath, backupPath);

            try {
                // Process and write file with proper formatting
                const processedContent = this.normalizeLineEndings(content);
                await vscode.workspace.fs.writeFile(
                    vscode.Uri.file(fullPath),
                    Buffer.from(processedContent, 'utf8')
                );
                // Remove backup on success
                await fs.promises.unlink(backupPath);
            } catch (error) {
                // Restore from backup if update fails
                await fs.promises.copyFile(backupPath, fullPath);
                await fs.promises.unlink(backupPath);
                throw error;
            }

            // Show the updated file
            const document = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(document);

            return;
        } catch (error) {
            throw new Error(`Failed to update file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async deleteFile(filePath: string): Promise<void> {
        try {
            const sanitizedPath = this.validatePath(filePath);
            const fullPath = path.join(this.workspaceRoot!, sanitizedPath);
            
            await this.validateFileOperation(fullPath);

            // Check if file exists
            if (!fs.existsSync(fullPath)) {
                throw new Error('File does not exist');
            }

            // Check if file is writable
            try {
                await fs.promises.access(fullPath, fs.constants.W_OK);
            } catch {
                throw new Error('File is not writable');
            }

            // Create backup before deletion
            const backupPath = `${fullPath}.bak`;
            await fs.promises.copyFile(fullPath, backupPath);

            try {
                // Delete file
                await fs.promises.unlink(fullPath);
            } catch (error) {
                // Restore from backup if deletion fails
                await fs.promises.copyFile(backupPath, fullPath);
                throw error;
            }

            // Remove backup on successful deletion
            await fs.promises.unlink(backupPath);
            return;
        } catch (error) {
            throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async getFileSuggestions(query: string): Promise<string[]> {
        try {
            if (!this.workspaceRoot || !query.trim()) {
                return [];
            }

            const files = await this.getAllFiles(this.workspaceRoot);
            return files
                .filter(file => file.toLowerCase().includes(query.toLowerCase()))
                .sort((a, b) => {
                    // Prioritize exact matches and matches at start of filename
                    const aLower = a.toLowerCase();
                    const bLower = b.toLowerCase();
                    const queryLower = query.toLowerCase();
                    
                    if (aLower === queryLower) return -1;
                    if (bLower === queryLower) return 1;
                    if (aLower.startsWith(queryLower)) return -1;
                    if (bLower.startsWith(queryLower)) return 1;
                    
                    return a.localeCompare(b);
                })
                .slice(0, 10); // Limit to 10 suggestions
        } catch (error) {
            console.error('Error getting file suggestions:', error);
            return [];
        }
    }

    private async getAllFiles(dir: string): Promise<string[]> {
        const files: string[] = [];
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(this.workspaceRoot!, fullPath);

            // Skip hidden files and specified directories
            if (entry.name.startsWith('.') || 
                entry.name === 'node_modules' || 
                entry.name === 'dist' || 
                entry.name === 'build') {
                continue;
            }

            if (entry.isDirectory()) {
                files.push(...await this.getAllFiles(fullPath));
            } else {
                files.push(relativePath);
            }
        }

        return files;
    }

    async applyCodeBlock(code: string, filePath?: string): Promise<void> {
        try {
            if (!code.trim()) {
                throw new Error('Code content cannot be empty');
            }

            if (!filePath) {
                // Create a new file if no file is specified
                const extension = this.detectFileExtension(code);
                const fileName = `generated_${Date.now()}${extension}`;
                await this.createFile(fileName, code);
                return;
            }

            // Update existing file
            await this.updateFile(filePath, code);
        } catch (error) {
            throw new Error(`Failed to apply code: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private detectFileExtension(code: string): string {
        // Simple language detection based on code content
        if (code.includes('function') || code.includes('const') || code.includes('let')) {
            return '.js';
        }
        if (code.includes('interface') || code.includes('type ') || code.includes('namespace')) {
            return '.ts';
        }
        if (code.includes('class') && code.includes('public')) {
            return '.java';
        }
        if (code.includes('#include')) {
            return '.cpp';
        }
        return '.txt';
    }
}
