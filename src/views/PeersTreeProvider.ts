import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Tree item types for the EnvSync sidebar view.
 */
export enum TreeItemType {
    Category = 'category',
    IgnoredFile = 'ignoredFile',
    Peer = 'peer',
    Info = 'info',
}

/**
 * Custom tree item for the EnvSync tree view.
 */
export class EnvSyncTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly itemType: TreeItemType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly filePath?: string,
        public readonly description2?: string,
    ) {
        super(label, collapsibleState);

        this.contextValue = itemType;

        switch (itemType) {
            case TreeItemType.Category:
                this.iconPath = new vscode.ThemeIcon('folder');
                break;
            case TreeItemType.IgnoredFile:
                this.iconPath = new vscode.ThemeIcon('file-code');
                this.description = description2 || '';
                if (filePath) {
                    this.tooltip = filePath;
                    this.command = {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [vscode.Uri.file(filePath)],
                    };
                }
                break;
            case TreeItemType.Peer:
                this.iconPath = new vscode.ThemeIcon('person');
                break;
            case TreeItemType.Info:
                this.iconPath = new vscode.ThemeIcon('info');
                break;
        }
    }
}

/**
 * PeersTreeProvider drives the "EnvSync Peers & Files" tree view in the Explorer sidebar.
 *
 * It shows:
 *  - A "Git-Ignored Files" category listing all files discoverable by WorkspaceScanner
 *  - A "Connected Peers" category (populated once P2P sessions are active — Phase 3+)
 */
export class PeersTreeProvider implements vscode.TreeDataProvider<EnvSyncTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<EnvSyncTreeItem | undefined | null>();
    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private ignoredFiles: string[] = [];
    private peers: Array<{ name: string; status: string }> = [];
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Update the list of ignored files and refresh the tree.
     */
    public updateIgnoredFiles(files: string[]): void {
        this.ignoredFiles = files;
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Update the list of connected peers and refresh the tree.
     */
    public updatePeers(peers: Array<{ name: string; status: string }>): void {
        this.peers = peers;
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Trigger a full tree refresh.
     */
    public refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: EnvSyncTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: EnvSyncTreeItem): vscode.ProviderResult<EnvSyncTreeItem[]> {
        if (!element) {
            // Root level: show categories
            return this.getRootItems();
        }

        // Category children
        if (element.itemType === TreeItemType.Category) {
            if (element.label === 'Git-Ignored Files') {
                return this.getIgnoredFileItems();
            }
            if (element.label === 'Connected Peers') {
                return this.getPeerItems();
            }
        }

        return [];
    }

    private getRootItems(): EnvSyncTreeItem[] {
        const items: EnvSyncTreeItem[] = [];

        // Git-Ignored Files section
        const fileCount = this.ignoredFiles.length;
        const filesCategory = new EnvSyncTreeItem(
            'Git-Ignored Files',
            TreeItemType.Category,
            fileCount > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed,
        );
        filesCategory.description = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
        items.push(filesCategory);

        // Connected Peers section
        const peerCount = this.peers.length;
        const peersCategory = new EnvSyncTreeItem(
            'Connected Peers',
            TreeItemType.Category,
            peerCount > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed,
        );
        peersCategory.description = peerCount > 0
            ? `${peerCount} connected`
            : 'none';
        items.push(peersCategory);

        return items;
    }

    private getIgnoredFileItems(): EnvSyncTreeItem[] {
        if (this.ignoredFiles.length === 0) {
            return [
                new EnvSyncTreeItem(
                    'No git-ignored files found',
                    TreeItemType.Info,
                    vscode.TreeItemCollapsibleState.None,
                ),
            ];
        }

        return this.ignoredFiles.map(file => {
            const fullPath = path.join(this.workspaceRoot, file);
            const basename = path.basename(file);
            const dirname = path.dirname(file);
            const description = dirname !== '.' ? dirname : undefined;

            return new EnvSyncTreeItem(
                basename,
                TreeItemType.IgnoredFile,
                vscode.TreeItemCollapsibleState.None,
                fullPath,
                description,
            );
        });
    }

    private getPeerItems(): EnvSyncTreeItem[] {
        if (this.peers.length === 0) {
            return [
                new EnvSyncTreeItem(
                    'No peers connected',
                    TreeItemType.Info,
                    vscode.TreeItemCollapsibleState.None,
                ),
            ];
        }

        return this.peers.map(peer => {
            const item = new EnvSyncTreeItem(
                peer.name,
                TreeItemType.Peer,
                vscode.TreeItemCollapsibleState.None,
            );
            item.description = peer.status;
            return item;
        });
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
