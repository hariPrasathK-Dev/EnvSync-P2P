import * as vscode from 'vscode';
import { WorkspaceScanner } from './services/WorkspaceScanner';
import { PeersTreeProvider } from './views/PeersTreeProvider';

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

    // Share File — select a git-ignored file to share (full impl in Phase 4)
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.shareFile', async () => {
            outputChannel.appendLine('Command: envsync.shareFile triggered');

            if (!workspaceScanner) {
                vscode.window.showErrorMessage('EnvSync P2P: Workspace scanner not initialized.');
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
                outputChannel.appendLine(`Selected file for sharing: ${selected.filePath}`);
                // Full sharing logic will be implemented in Phase 4
                vscode.window.showInformationMessage(
                    `EnvSync P2P: Ready to share "${selected.filePath}". ` +
                    `(Full P2P sharing will be enabled in Phase 4)`
                );
            }
        })
    );

    // Join Session — enter a wormhole code to receive a file (full impl in Phase 4)
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.joinSession', async () => {
            outputChannel.appendLine('Command: envsync.joinSession triggered');

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
                // Full join logic will be implemented in Phase 4
                vscode.window.showInformationMessage(
                    `EnvSync P2P: Joining session "${code}". ` +
                    `(Full P2P joining will be enabled in Phase 4)`
                );
            }
        })
    );

    // Review Incoming — opens diff editor for an incoming file (Phase 5)
    context.subscriptions.push(
        vscode.commands.registerCommand('envsync.reviewIncoming', async () => {
            outputChannel.appendLine('Command: envsync.reviewIncoming triggered');
            vscode.window.showInformationMessage(
                'EnvSync P2P: No incoming files to review. (Diff review will be enabled in Phase 5)'
            );
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
 * Full teardown logic will be added in Phase 7.
 */
export function deactivate(): void {
    if (outputChannel) {
        outputChannel.appendLine('EnvSync P2P extension deactivating...');
        outputChannel.dispose();
    }
}
