import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * IncomingFileHandler — Manages the safe reception of incoming files.
 *
 * Core safety constraint: NEVER overwrite a local file immediately.
 * Instead:
 *  1. Write decrypted payload to an ephemeral temp file in .vscode/envsync-tmp/
 *  2. Open a VS Code diff editor (local ↔ remote) for visual review
 *  3. Wait for user to explicitly accept or reject via CodeLens actions
 *
 * If the local file doesn't exist yet, skip the diff and prompt to create directly.
 */
export class IncomingFileHandler implements vscode.Disposable {
    private static readonly TEMP_DIR = '.vscode/envsync-tmp';
    private readonly workspaceRoot: string;
    private readonly outputChannel: vscode.OutputChannel;

    // Tracks pending incoming files: tempPath → { localPath, fileName }
    private pendingFiles: Map<string, { localPath: string; fileName: string }> = new Map();

    // Callback for Phase 6 validation (set externally)
    private onBeforeDiffCallback:
        ((content: Buffer, fileName: string) => Promise<boolean>) | null = null;

    // Callback invoked after a file is accepted
    private onAfterAcceptCallback:
        ((localPath: string, content: Buffer) => Promise<void>) | null = null;

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
    }

    /**
     * Set a validation callback that runs before the diff is shown.
     * Return false to block the diff (e.g., for syntax errors).
     */
    public onBeforeDiff(
        callback: (content: Buffer, fileName: string) => Promise<boolean>,
    ): void {
        this.onBeforeDiffCallback = callback;
    }

    /**
     * Set a callback that runs after a file is accepted (e.g., .env.example sync).
     */
    public onAfterAccept(
        callback: (localPath: string, content: Buffer) => Promise<void>,
    ): void {
        this.onAfterAcceptCallback = callback;
    }

    /**
     * Handle an incoming decrypted file.
     * Writes to temp, opens diff editor, and waits for user action.
     */
    public async handleIncomingFile(data: Buffer, fileName: string): Promise<void> {
        this.log(`Handling incoming file: ${fileName} (${data.length} bytes)`);

        // 1. Run pre-diff validation (Phase 6 hook)
        if (this.onBeforeDiffCallback) {
            const shouldProceed = await this.onBeforeDiffCallback(data, fileName);
            if (!shouldProceed) {
                this.log(`Pre-diff validation blocked file: ${fileName}`);
                return;
            }
        }

        // 2. Determine temp path
        const tempFileName = `${fileName}-${Date.now()}.remote`;
        const tempPath = path.join(this.workspaceRoot, IncomingFileHandler.TEMP_DIR, tempFileName);

        // 3. Write decrypted payload to temp file, ensuring deep directory exists
        fs.mkdirSync(path.dirname(tempPath), { recursive: true });
        fs.writeFileSync(tempPath, data);
        this.log(`Wrote temp file: ${tempPath}`);

        // 4. Determine the expected local path
        const localPath = path.join(this.workspaceRoot, fileName);

        // 5. Track this pending file
        this.pendingFiles.set(tempPath, { localPath, fileName });

        // 6. Check if local file exists
        if (fs.existsSync(localPath)) {
            // Open diff editor: local (left) vs remote/incoming (right)
            const localUri = vscode.Uri.file(localPath);
            const remoteUri = vscode.Uri.file(tempPath);
            const title = `EnvSync: ${fileName} (Local ↔ Incoming)`;

            this.log(`Opening diff editor: ${localPath} ↔ ${tempPath}`);
            await vscode.commands.executeCommand('vscode.diff', localUri, remoteUri, title);

            // Show notification with accept/reject actions
            const accept = 'Accept Incoming';
            const reject = 'Reject';
            const result = await vscode.window.showInformationMessage(
                `EnvSync: Incoming "${fileName}" — review the diff and choose an action.`,
                accept,
                reject,
            );

            if (result === accept) {
                await this.acceptFile(tempPath);
            } else {
                await this.rejectFile(tempPath);
            }
        } else {
            // No local file — prompt to create directly
            const create = 'Create File';
            const cancel = 'Cancel';
            const result = await vscode.window.showInformationMessage(
                `EnvSync: "${fileName}" doesn't exist locally. Create it?`,
                create,
                cancel,
            );

            if (result === create) {
                await this.acceptFile(tempPath);
            } else {
                await this.rejectFile(tempPath);
            }
        }
    }

    /**
     * Accept an incoming file: overwrite local with temp, cleanup.
     */
    public async acceptFile(tempPath: string): Promise<void> {
        const pending = this.pendingFiles.get(tempPath);
        if (!pending) {
            this.log(`No pending file found for: ${tempPath}`);
            return;
        }

        const { localPath, fileName } = pending;

        try {
            // Ensure target directory exists
            const targetDir = path.dirname(localPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // Read temp content and write to local path
            const content = fs.readFileSync(tempPath);
            fs.writeFileSync(localPath, content);
            this.log(`Accepted: ${fileName} → ${localPath}`);

            // Run post-accept callback (Phase 6 hook)
            if (this.onAfterAcceptCallback) {
                await this.onAfterAcceptCallback(localPath, content);
            }

            vscode.window.showInformationMessage(
                `EnvSync: "${fileName}" accepted and saved! ✅`,
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`EnvSync: Failed to save file — ${msg}`);
        } finally {
            // Cleanup temp file
            this.cleanupTempFile(tempPath);
            this.pendingFiles.delete(tempPath);
        }
    }

    /**
     * Reject an incoming file: delete temp, notify user.
     */
    public async rejectFile(tempPath: string): Promise<void> {
        const pending = this.pendingFiles.get(tempPath);
        if (!pending) { return; }

        this.log(`Rejected: ${pending.fileName}`);
        this.cleanupTempFile(tempPath);
        this.pendingFiles.delete(tempPath);

        vscode.window.showInformationMessage(
            `EnvSync: "${pending.fileName}" rejected. Temp file deleted.`,
        );
    }

    /**
     * Securely delete a temp file.
     */
    private cleanupTempFile(tempPath: string): void {
        try {
            if (fs.existsSync(tempPath)) {
                // Overwrite with zeros before deleting (best-effort secure delete)
                const stat = fs.statSync(tempPath);
                fs.writeFileSync(tempPath, Buffer.alloc(stat.size, 0));
                fs.unlinkSync(tempPath);
                this.log(`Cleaned up temp file: ${tempPath}`);
            }
        } catch {
            // Best-effort cleanup
        }
    }

    /**
     * Clean up all pending temp files (used during teardown).
     */
    public cleanupAllTempFiles(): void {
        for (const [tempPath] of this.pendingFiles) {
            this.cleanupTempFile(tempPath);
        }
        this.pendingFiles.clear();

        // Remove the temp directory if it exists and is empty
        const tempDir = path.join(this.workspaceRoot, IncomingFileHandler.TEMP_DIR);
        try {
            if (fs.existsSync(tempDir)) {
                const entries = fs.readdirSync(tempDir);
                if (entries.length === 0) {
                    fs.rmdirSync(tempDir);
                }
            }
        } catch {
            // Best-effort
        }
    }

    /**
     * Get the temp path for a pending file (used by CodeLens provider).
     */
    public getPendingFiles(): Map<string, { localPath: string; fileName: string }> {
        return this.pendingFiles;
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[Incoming] ${message}`);
    }

    public dispose(): void {
        this.cleanupAllTempFiles();
    }
}
