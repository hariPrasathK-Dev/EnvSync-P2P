import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DotEnvParser } from './DotEnvParser';

/**
 * EnvExampleSync — Detects configuration drift by comparing incoming
 * .env keys against the project's .env.example template.
 *
 * When new keys are detected in an incoming .env that aren't present
 * in .env.example, the developer is prompted to append them (with
 * redacted values) to keep the tracked template in sync.
 *
 * This prevents the common problem where one developer adds new
 * environment variables but forgets to update the shared template,
 * causing deployment failures or "it works on my machine" issues.
 */
export class EnvExampleSync {
    private parser: DotEnvParser;
    private outputChannel: vscode.OutputChannel;
    private workspaceRoot: string;

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.parser = new DotEnvParser();
        this.outputChannel = outputChannel;
    }

    /**
     * Check incoming .env content against the local .env.example.
     * If new keys are found, prompt the user to append them.
     *
     * @param localEnvPath The absolute path to the local .env file that was just accepted.
     * @param incomingContent The content of the incoming .env file (Buffer).
     */
    public async promptNewKeys(localEnvPath: string, incomingContent: Buffer): Promise<void> {
        // Only act on .env files (not .env.example, .env.local, etc.)
        const basename = path.basename(localEnvPath);
        if (basename !== '.env') {
            this.log(`Skipping env.example sync — file is "${basename}", not ".env"`);
            return;
        }

        // Find .env.example in the same directory as the .env file
        const envDir = path.dirname(localEnvPath);
        const examplePath = path.join(envDir, '.env.example');

        if (!fs.existsSync(examplePath)) {
            this.log(`No .env.example found at ${examplePath} — skipping key drift check`);
            return;
        }

        // Parse incoming .env keys
        const incomingKeys = this.parser.extractKeys(incomingContent.toString('utf-8'));

        // Parse .env.example keys
        const exampleContent = fs.readFileSync(examplePath, 'utf-8');
        const exampleKeys = this.parser.extractKeys(exampleContent);

        // Find keys in incoming that aren't in .env.example
        const { added } = this.parser.compareKeys(incomingKeys, exampleKeys);

        if (added.length === 0) {
            this.log('No new keys to add to .env.example');
            return;
        }

        this.log(`Found ${added.length} new key(s) not in .env.example: ${added.join(', ')}`);

        // Prompt the user
        const addKeys = `Add ${added.length} Key${added.length > 1 ? 's' : ''}`;
        const skip = 'Skip';

        const result = await vscode.window.showInformationMessage(
            `EnvSync: The incoming .env introduces ${added.length} new key${added.length > 1 ? 's' : ''} ` +
            `not present in .env.example:\n\n${added.map(k => `  • ${k}`).join('\n')}\n\n` +
            `Add them to .env.example (with redacted values) to prevent configuration drift?`,
            addKeys,
            skip,
        );

        if (result === addKeys) {
            await this.appendKeysToExample(examplePath, added);
        }
    }

    /**
     * Append new keys to .env.example with redacted placeholder values.
     */
    private async appendKeysToExample(examplePath: string, keys: string[]): Promise<void> {
        try {
            const existingContent = fs.readFileSync(examplePath, 'utf-8');

            // Build the new entries with redacted values
            const newEntries = keys
                .map(key => `${key}=<your_value_here>`)
                .join('\n');

            // Ensure we start on a new line
            const separator = existingContent.endsWith('\n') ? '' : '\n';
            const header = `\n# Added by EnvSync P2P — new keys from peer\n`;

            const updatedContent = existingContent + separator + header + newEntries + '\n';
            fs.writeFileSync(examplePath, updatedContent);

            this.log(`Appended ${keys.length} key(s) to ${examplePath}`);
            vscode.window.showInformationMessage(
                `EnvSync: Added ${keys.length} key${keys.length > 1 ? 's' : ''} to .env.example ✅`,
            );

            // Open the file for review
            const doc = await vscode.workspace.openTextDocument(examplePath);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`EnvSync: Failed to update .env.example — ${msg}`);
        }
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[EnvExampleSync] ${message}`);
    }
}
