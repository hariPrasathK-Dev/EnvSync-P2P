import * as vscode from 'vscode';
import { WorkspaceScanner } from './services/WorkspaceScanner';
import { PeersTreeProvider } from './views/PeersTreeProvider';
import { SessionManager } from './services/SessionManager';
import { IncomingFileHandler } from './services/IncomingFileHandler';
import { AcceptIncomingCodeLensProvider } from './views/AcceptIncomingCodeLens';
import { DotEnvParser } from './services/DotEnvParser';
import { EnvExampleSync } from './services/EnvExampleSync';

/**
 * EnvSync P2P — Extension Entry Point
 *
 * This extension provides secure, peer-to-peer synchronization of
 * git-ignored files (.env, local configs, test assets) between
 * developers using WebRTC data channels and E2E encryption.
 *
 * Architecture:
 *  - WorkspaceScanner: discovers files ignored by .gitignore
 *  - PeersTreeProvider: drives the sidebar tree view
 *  - EncryptionService: AES-256-GCM encryption (Phase 2)
 *  - SignalingService: WebSocket-based SDP/ICE exchange (Phase 3)
 *  - P2PConnectionManager: WebRTC data channel management (Phase 3)
 */

let workspaceScanner: WorkspaceScanner | undefined;
let treeProvider: PeersTreeProvider | undefined;
let sessionManager: SessionManager | undefined;
let incomingHandler: IncomingFileHandler | undefined;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('EnvSync P2P');
    outputChannel.appendLine('EnvSync P2P extension activating...');

    // Determine workspace root
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        outputChannel.appendLine('No workspace folder open. EnvSync P2P requires an open workspace.');
        vscode.window.showWarningMessage(
            'EnvSync P2P: Please open a workspace folder to use this extension.'
        );
        return;
    }

    outputChannel.appendLine(`Workspace root: ${workspaceRoot}`);

    // ─── Initialize Core Services ───

    // 1. WorkspaceScanner — discovers git-ignored files
    workspaceScanner = new WorkspaceScanner(workspaceRoot);
    context.subscriptions.push(workspaceScanner);

    // 2. Tree View — sidebar UI
    treeProvider = new PeersTreeProvider(workspaceRoot);
    const treeView = vscode.window.createTreeView('envsync-peers', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Wire up scanner → tree view updates
    workspaceScanner.onDidChangeIgnoredFiles(async () => {
        const files = workspaceScanner!.getCachedIgnoredFiles();
        treeProvider!.updateIgnoredFiles(files);
        outputChannel.appendLine(`Refreshed: found ${files.length} git-ignored file(s)`);
    });

    // 3. SessionManager — orchestrates share/join sessions
    sessionManager = new SessionManager(workspaceRoot, outputChannel);
    context.subscriptions.push(sessionManager);

    // 4. IncomingFileHandler — temp file + diff editor + accept/reject
    incomingHandler = new IncomingFileHandler(workspaceRoot, outputChannel);
    context.subscriptions.push(incomingHandler);

    // Wire SessionManager → IncomingFileHandler for received files
    sessionManager.onFileReceived(async (data, fileName) => {
        await incomingHandler!.handleIncomingFile(data, fileName);
    });

    // 5. CodeLens provider for accept/reject on .remote temp files
    const codeLensProvider = new AcceptIncomingCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { pattern: '**/.vscode/envsync-tmp/*.remote' },
            codeLensProvider,
        ),
    );

    // 6. Semantic validation — DotEnvParser + EnvExampleSync
    const dotEnvParser = new DotEnvParser();
    const envExampleSync = new EnvExampleSync(workspaceRoot, outputChannel);

    // Pre-diff validation: check .env syntax before showing diff editor
    incomingHandler.onBeforeDiff(async (content, fileName) => {
        if (!fileName.startsWith('.env') || fileName === '.env.example') {
            return true; // Not a .env file — skip validation
        }

        const validation = dotEnvParser.validate(content.toString('utf-8'));

        if (!validation.valid) {
            const errorSummary = validation.errors
                .map(e => e.message)
                .join('\n');

            const proceed = 'Show Diff Anyway';
            const cancel = 'Cancel';
            const result = await vscode.window.showWarningMessage(
                `EnvSync: Incoming "${fileName}" has ${validation.errors.length} syntax error(s):\n\n${errorSummary}`,
                { modal: true },
                proceed,
                cancel,
            );
            return result === proceed;
        }

        if (validation.warnings.length > 0) {
            outputChannel.appendLine(
                `[Validation] Warnings for ${fileName}: ${validation.warnings.join('; ')}`,
            );
        }

        return true;
    });

    // Post-accept hook: check for new keys to add to .env.example
    incomingHandler.onAfterAccept(async (localPath, content) => {
        await envExampleSync.promptNewKeys(localPath, content);
    });

    // ─── Register Commands ───

    // Start Session — orchestrates a new sharing session
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.startSession', async () => {
            outputChannel.appendLine('Command: envsync.startSession triggered');
            const choice = await vscode.window.showQuickPick(
                ['Share a File', 'Join a Session'],
                {
                    placeHolder: 'What would you like to do?',
                    title: 'EnvSync P2P — Start Session',
                }
            );

            if (choice === 'Share a File') {
                await vscode.commands.executeCommand('envsync.shareFile');
            } else if (choice === 'Join a Session') {
                await vscode.commands.executeCommand('envsync.joinSession');
            }
        })
    );

    // Share File — select a git-ignored file and initiate P2P sharing
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.shareFile', async () => {
            outputChannel.appendLine('Command: envsync.shareFile triggered');

            if (!workspaceScanner || !sessionManager) {
                vscode.window.showErrorMessage('EnvSync P2P: Extension not fully initialized.');
                return;
            }

            const ignoredFiles = await workspaceScanner.getIgnoredFiles();

            if (ignoredFiles.length === 0) {
                vscode.window.showInformationMessage(
                    'EnvSync P2P: No git-ignored files found in this workspace.'
                );
                return;
            }

            const items = ignoredFiles.map(file => ({
                label: `$(file-code) ${file}`,
                description: 'Git-ignored',
                filePath: file,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a file to share securely...',
                title: 'EnvSync P2P — Share File',
                matchOnDescription: true,
            });

            if (selected) {
                const absolutePath = require('path').join(workspaceRoot, selected.filePath);
                outputChannel.appendLine(`Sharing file: ${absolutePath}`);
                await sessionManager.startSharing(absolutePath, selected.filePath);
            }
        })
    );

    // Stop Session — explicit manual disconnect
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.stopSession', () => {
            outputChannel.appendLine('Command: envsync.stopSession triggered');
            if (sessionManager) {
                sessionManager.cleanup();
                vscode.window.showInformationMessage('EnvSync: Session disconnected.');
            }
        })
    );

    // Join Session — enter a wormhole code and connect to receive a file
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.joinSession', async () => {
            outputChannel.appendLine('Command: envsync.joinSession triggered');

            if (!sessionManager) {
                vscode.window.showErrorMessage('EnvSync P2P: Extension not fully initialized.');
                return;
            }

            const code = await vscode.window.showInputBox({
                prompt: 'Enter the 3-word wormhole code from your peer',
                placeHolder: 'apple-brave-chair',
                title: 'EnvSync P2P — Join Session',
                validateInput: (value: string) => {
                    const parts = value.trim().split('-');
                    if (parts.length !== 3) {
                        return 'Code must be exactly 3 words separated by hyphens (e.g., apple-brave-chair)';
                    }
                    if (parts.some(p => p.length === 0)) {
                        return 'Each word in the code must be non-empty';
                    }
                    if (parts.some(p => !/^[a-z]+$/.test(p))) {
                        return 'Each word must contain only lowercase letters';
                    }
                    return null;
                },
            });

            if (code) {
                outputChannel.appendLine(`Joining session with code: ${code}`);
                await sessionManager.joinSession(code.trim().toLowerCase());
            }
        })
    );

    // Review Incoming — opens diff editor for an incoming file
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.reviewIncoming', async () => {
            outputChannel.appendLine('Command: envsync.reviewIncoming triggered');
            vscode.window.showInformationMessage(
                'EnvSync P2P: No incoming files to review at this time.'
            );
        })
    );

    // Accept Incoming — triggered by CodeLens or notification
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.acceptIncoming', async (tempPath?: string) => {
            outputChannel.appendLine(`Command: envsync.acceptIncoming — ${tempPath}`);
            if (tempPath && incomingHandler) {
                await incomingHandler.acceptFile(tempPath);
            } else {
                vscode.window.showWarningMessage('EnvSync: No incoming file to accept.');
            }
        })
    );

    // Reject Incoming — triggered by CodeLens or notification
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.rejectIncoming', async (tempPath?: string) => {
            outputChannel.appendLine(`Command: envsync.rejectIncoming — ${tempPath}`);
            if (tempPath && incomingHandler) {
                await incomingHandler.rejectFile(tempPath);
            } else {
                vscode.window.showWarningMessage('EnvSync: No incoming file to reject.');
            }
        })
    );

    // Refresh Files — manually refresh the ignored files list
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.refreshFiles', async () => {
            outputChannel.appendLine('Command: envsync.refreshFiles triggered');
            await workspaceScanner!.refresh();
            vscode.window.showInformationMessage('EnvSync P2P: File list refreshed.');
        })
    );

    // ─── Initial Scan ───

    // Perform an initial scan of the workspace
    workspaceScanner.getIgnoredFiles().then(files => {
        treeProvider!.updateIgnoredFiles(files);
        outputChannel.appendLine(`Initial scan complete: found ${files.length} git-ignored file(s)`);
        if (files.length > 0) {
            outputChannel.appendLine('Ignored files:');
            files.forEach(f => outputChannel.appendLine(`  • ${f}`));
        }
    });

    // ─── File System Watcher for .env* ───

    const envWatcher = vscode.workspace.createFileSystemWatcher('**/.env*');
    envWatcher.onDidCreate(uri => {
        outputChannel.appendLine(`New .env file detected: ${uri.fsPath}`);
        workspaceScanner!.refresh();
    });
    envWatcher.onDidChange(uri => {
        outputChannel.appendLine(`Modified .env file: ${uri.fsPath}`);
    });
    envWatcher.onDidDelete(uri => {
        outputChannel.appendLine(`Deleted .env file: ${uri.fsPath}`);
        workspaceScanner!.refresh();
    });
    context.subscriptions.push(envWatcher);

    // ─── Activation Complete ───

    outputChannel.appendLine('EnvSync P2P extension activated successfully.');
    outputChannel.appendLine('─'.repeat(50));
}

/**
 * Get the root path of the first workspace folder.
 */
function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return folders[0].uri.fsPath;
    }
    return undefined;
}

/**
 * Extension deactivation — cleanup all resources.
 */
export function deactivate(): void {
    if (outputChannel) {
        outputChannel.appendLine('EnvSync P2P extension deactivating...');
    }
    if (sessionManager) {
        sessionManager.dispose();
        sessionManager = undefined;
    }
    if (workspaceScanner) {
        workspaceScanner.dispose();
        workspaceScanner = undefined;
    }
    if (outputChannel) {
        outputChannel.dispose();
    }
}
