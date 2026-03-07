import * as vscode from 'vscode';
import * as path from 'path';

/**
 * AcceptIncomingCodeLensProvider — Shows "Accept" and "Reject" CodeLens
 * actions on incoming remote files in the diff editor.
 *
 * This CodeLens provider is registered for files matching the pattern
 * `.vscode/envsync-tmp/*.remote`. When the user opens a diff view with
 * an incoming file, they'll see actionable CodeLens buttons:
 *
 *  ✅ Accept Incoming Configuration  |  ❌ Reject
 *
 * This provides an inline, non-intrusive way to resolve incoming changes
 * directly from the editor, complementing the notification-based approach
 * in IncomingFileHandler.
 */
export class AcceptIncomingCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
    ): vscode.CodeLens[] {
        // Only show CodeLens for envsync temp files
        if (!this.isEnvSyncTempFile(document.uri.fsPath)) {
            return [];
        }

        const range = new vscode.Range(0, 0, 0, 0);

        const acceptLens = new vscode.CodeLens(range, {
            title: '✅ Accept Incoming Configuration',
            command: 'envsync.acceptIncoming',
            arguments: [document.uri.fsPath],
            tooltip: 'Overwrite local file with this incoming version',
        });

        const rejectLens = new vscode.CodeLens(range, {
            title: '❌ Reject',
            command: 'envsync.rejectIncoming',
            arguments: [document.uri.fsPath],
            tooltip: 'Discard incoming file and keep local version',
        });

        return [acceptLens, rejectLens];
    }

    /**
     * Check if a file path belongs to the EnvSync temp directory.
     */
    private isEnvSyncTempFile(fsPath: string): boolean {
        const normalized = fsPath.replace(/\\/g, '/');
        return normalized.includes('.vscode/envsync-tmp/') &&
            normalized.endsWith('.remote');
    }

    /**
     * Trigger a CodeLens refresh (e.g., after a file state changes).
     */
    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }
}
