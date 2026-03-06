import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import ignore, { Ignore } from 'ignore';

/**
 * WorkspaceScanner discovers files in the workspace that are
 * ignored by Git (via .gitignore and .git/info/exclude).
 *
 * These are the files eligible for secure P2P sharing — they
 * are the ones that never make it into version control.
 */
export class WorkspaceScanner implements vscode.Disposable {
    private _onDidChangeIgnoredFiles = new vscode.EventEmitter<void>();
    public readonly onDidChangeIgnoredFiles = this._onDidChangeIgnoredFiles.event;

    private readonly watchers: vscode.FileSystemWatcher[] = [];
    private cachedIgnoredFiles: string[] = [];
    private ignoreFilter: Ignore | null = null;

    constructor(private readonly workspaceRoot: string) {
        // Watch for .gitignore changes so our list stays fresh
        const gitignoreWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '**/.gitignore')
        );
        gitignoreWatcher.onDidChange(() => this.refresh());
        gitignoreWatcher.onDidCreate(() => this.refresh());
        gitignoreWatcher.onDidDelete(() => this.refresh());
        this.watchers.push(gitignoreWatcher);

        // Watch for .env* file changes
        const envWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '**/.env*')
        );
        envWatcher.onDidChange(() => this.refresh());
        envWatcher.onDidCreate(() => this.refresh());
        envWatcher.onDidDelete(() => this.refresh());
        this.watchers.push(envWatcher);
    }

    /**
     * Build the ignore filter by reading .gitignore and .git/info/exclude
     */
    private loadIgnoreRules(): Ignore {
        const ig = ignore();

        // Read root .gitignore
        const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, 'utf-8');
                ig.add(content);
            } catch {
                // Silently continue if we can't read .gitignore
            }
        }

        // Read .git/info/exclude (Git's per-repo exclude file)
        const excludePath = path.join(this.workspaceRoot, '.git', 'info', 'exclude');
        if (fs.existsSync(excludePath)) {
            try {
                const content = fs.readFileSync(excludePath, 'utf-8');
                ig.add(content);
            } catch {
                // Silently continue if we can't read exclude
            }
        }

        // Also look for nested .gitignore files in subdirectories
        this.findNestedGitignores(this.workspaceRoot, ig);

        return ig;
    }

    /**
     * Recursively discover nested .gitignore files
     */
    private findNestedGitignores(dir: string, ig: Ignore, depth: number = 0): void {
        if (depth > 5) { return; } // Prevent excessive recursion

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === 'node_modules' || entry.name === '.git') {
                    continue;
                }

                if (entry.isDirectory()) {
                    const subGitignore = path.join(dir, entry.name, '.gitignore');
                    if (fs.existsSync(subGitignore)) {
                        try {
                            const content = fs.readFileSync(subGitignore, 'utf-8');
                            // Prefix patterns with the relative directory path
                            const relDir = path.relative(this.workspaceRoot, path.join(dir, entry.name));
                            const prefixedRules = content
                                .split('\n')
                                .filter(line => line.trim() && !line.startsWith('#'))
                                .map(line => `${relDir}/${line}`);
                            ig.add(prefixedRules);
                        } catch {
                            // Skip unreadable files
                        }
                    }
                    this.findNestedGitignores(path.join(dir, entry.name), ig, depth + 1);
                }
            }
        } catch {
            // Skip unreadable directories
        }
    }

    /**
     * Walk the workspace directory tree and collect all file paths
     * (relative to workspace root), excluding .git and node_modules.
     */
    private walkDirectory(dir: string, relativeTo: string): string[] {
        const results: string[] = [];

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                // Skip version control and dependency dirs
                if (entry.name === '.git' || entry.name === 'node_modules') {
                    continue;
                }

                const fullPath = path.join(dir, entry.name);
                const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/');

                if (entry.isDirectory()) {
                    results.push(...this.walkDirectory(fullPath, relativeTo));
                } else {
                    results.push(relPath);
                }
            }
        } catch {
            // Skip unreadable directories
        }

        return results;
    }

    /**
     * Returns all workspace files that are currently ignored by Git.
     * These are the files eligible for P2P sharing.
     */
    public async getIgnoredFiles(): Promise<string[]> {
        this.ignoreFilter = this.loadIgnoreRules();

        const allFiles = this.walkDirectory(this.workspaceRoot, this.workspaceRoot);

        // Filter to only files that ARE ignored by git
        this.cachedIgnoredFiles = allFiles.filter(file => {
            try {
                return this.ignoreFilter!.ignores(file);
            } catch {
                return false;
            }
        });

        return this.cachedIgnoredFiles;
    }

    /**
     * Check if a specific file path is ignored by Git.
     */
    public isIgnored(relativePath: string): boolean {
        if (!this.ignoreFilter) {
            this.ignoreFilter = this.loadIgnoreRules();
        }
        try {
            return this.ignoreFilter.ignores(relativePath.replace(/\\/g, '/'));
        } catch {
            return false;
        }
    }

    /**
     * Get the cached list of ignored files (call getIgnoredFiles first).
     */
    public getCachedIgnoredFiles(): string[] {
        return this.cachedIgnoredFiles;
    }

    /**
     * Trigger a refresh of the ignored files list and notify listeners.
     */
    public async refresh(): Promise<void> {
        await this.getIgnoredFiles();
        this._onDidChangeIgnoredFiles.fire();
    }

    public dispose(): void {
        for (const watcher of this.watchers) {
            watcher.dispose();
        }
        this._onDidChangeIgnoredFiles.dispose();
    }
}
