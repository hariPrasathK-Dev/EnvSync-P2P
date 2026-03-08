import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EncryptionService, EncryptedPayload } from './EncryptionService';
import { WormholeCodeGenerator } from './WormholeCodeGenerator';
import { SignalingService } from './SignalingService';
import { P2PConnectionManager, ConnectionState, FileMetadata } from './P2PConnectionManager';

/**
 * SessionManager — Orchestrates the full share/receive lifecycle.
 *
 * This is the central coordinator that wires together:
 *  - WormholeCodeGenerator: to produce the 3-word code
 *  - EncryptionService: to encrypt/decrypt file buffers
 *  - SignalingService: to exchange SDP/ICE via the relay
 *  - P2PConnectionManager: to transfer encrypted data over the data channel
 *
 * Share Flow:
 *  1. User selects a file → generate wormhole code → show code to user
 *  2. Hash code → room ID → connect signaling → wait for peer
 *  3. On peer join → encrypt file → send over data channel
 *
 * Join Flow:
 *  1. User enters wormhole code → validate → hash → room ID
 *  2. Connect signaling → establish P2P connection
 *  3. Receive encrypted data → decrypt → hand off to IncomingFileHandler
 */
export class SessionManager implements vscode.Disposable {
    private encryption: EncryptionService;
    private codeGenerator: WormholeCodeGenerator;
    private signaling: SignalingService | null = null;
    private p2pManager: P2PConnectionManager | null = null;
    private outputChannel: vscode.OutputChannel;
    private workspaceRoot: string;

    // Active session state
    private activePassphrase: string | null = null;
    private activeFilePath: string | null = null;
    private statusBarItem: vscode.StatusBarItem;

    // Callback for Phase 5: receives decrypted data + metadata
    private onFileReceivedCallback:
        ((data: Buffer, fileName: string) => Promise<void>) | null = null;

    // Relay URL — configurable, defaults to localhost for dev
    private static readonly DEFAULT_RELAY_URL = 'wss://envsync-p2p.onrender.com';

    constructor(
        workspaceRoot: string,
        outputChannel: vscode.OutputChannel,
    ) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.encryption = new EncryptionService();
        this.codeGenerator = new WormholeCodeGenerator();

        // Status bar item for connection state
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, 100,
        );
        this.statusBarItem.text = '$(lock) EnvSync';
        this.statusBarItem.tooltip = 'EnvSync P2P — No active session';
    }

    /**
     * Set the callback invoked when a file is received and decrypted.
     * This is wired to IncomingFileHandler in Phase 5.
     */
    public onFileReceived(
        callback: (data: Buffer, fileName: string) => Promise<void>,
    ): void {
        this.onFileReceivedCallback = callback;
    }

    /**
     * Get the relay URL from configuration or use default.
     */
    private getRelayUrl(): string {
        const config = vscode.workspace.getConfiguration('envsync');
        return config.get<string>('relayUrl', SessionManager.DEFAULT_RELAY_URL);
    }

    // ════════════════════════════════════════════
    //  SHARE FLOW
    // ════════════════════════════════════════════

    /**
     * Initiate a file sharing session.
     * @param filePath Absolute path to the file to share.
     */
    public async startSharing(filePath: string, relativePath?: string): Promise<void> {
        this.log('Starting share session...');

        // 1. Read the file
        if (!fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(`EnvSync: File not found — ${filePath}`);
            return;
        }

        const fileBuffer = fs.readFileSync(filePath);
        const fileName = relativePath ? relativePath.replace(/\\/g, '/') : path.basename(filePath);
        this.activeFilePath = filePath;

        // 2. Generate wormhole code
        const code = this.codeGenerator.generateCode();
        this.activePassphrase = code;
        this.log(`Generated wormhole code: ${code}`);

        // 3. Show code to user with Copy action
        const copyAction = 'Copy to Clipboard';
        const result = await vscode.window.showInformationMessage(
            `EnvSync P2P — Your secure code: **${code}**\n\nShare this code with your peer.`,
            { modal: false },
            copyAction,
        );
        if (result === copyAction) {
            await vscode.env.clipboard.writeText(code);
            vscode.window.showInformationMessage('EnvSync: Code copied to clipboard!');
        }

        // 4. Update status bar
        this.updateStatus('$(sync~spin) Waiting for peer...', `Sharing: ${fileName}`);

        // 5. Create room ID from hashed passphrase
        const roomId = this.encryption.hashPassphrase(code);

        // 6. Connect signaling service
        try {
            await this.initSignaling(roomId);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`EnvSync: Failed to connect to relay — ${msg}`);
            this.cleanup();
            return;
        }

        // 7. Init P2P as sender
        this.p2pManager = new P2PConnectionManager(this.signaling!, this.outputChannel);
        await this.p2pManager.initAsSender();

        let fileSent = false;
        // 8. Wire up — when peer connects and data channel opens, encrypt & send
        this.p2pManager.onStateChange(async (state) => {
            if (state === ConnectionState.Connected && !fileSent) {
                fileSent = true;
                this.updateStatus('$(cloud-upload) Encrypting & sending...', `Sharing: ${fileName}`);
                this.log('Peer connected — encrypting file...');

                try {
                    // Encrypt the file
                    const encryptedPayload = await this.encryption.encrypt(fileBuffer, code);
                    const payloadBuffer = Buffer.from(JSON.stringify(encryptedPayload));

                    // Send the encrypted payload
                    this.log(`Sending encrypted file: ${fileName} (${payloadBuffer.length} bytes)`);
                    await this.p2pManager!.sendFile(payloadBuffer, fileName);

                    vscode.window.showInformationMessage(
                        `EnvSync: "${fileName}" sent successfully! ✅`,
                    );
                    this.updateStatus('$(check) Transfer complete', `Sent: ${fileName}`);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`EnvSync: Transfer failed — ${msg}`);
                    this.updateStatus('$(error) Transfer failed', msg);
                }
            }
        });

        this.p2pManager.onTransferProgress((percent) => {
            this.updateStatus(
                `$(cloud-upload) Sending... ${percent}%`,
                `Sharing: ${fileName}`,
            );
        });

        this.p2pManager.onError((error) => {
            vscode.window.showErrorMessage(`EnvSync P2P Error: ${error}`);
            this.updateStatus('$(error) Error', error);
        });
    }

    // ════════════════════════════════════════════
    //  JOIN / RECEIVE FLOW
    // ════════════════════════════════════════════

    /**
     * Join an existing session to receive a file.
     * @param code The 3-word wormhole code.
     */
    public async joinSession(code: string): Promise<void> {
        this.log(`Joining session with code: ${code}`);
        this.activePassphrase = code;

        // 1. Validate code format
        const validation = this.codeGenerator.validateCode(code);
        if (!validation.valid) {
            vscode.window.showErrorMessage(`EnvSync: Invalid code — ${validation.error}`);
            return;
        }

        const normalizedCode = this.codeGenerator.normalizeCode(code);
        this.activePassphrase = normalizedCode;

        // 2. Update status
        this.updateStatus('$(sync~spin) Connecting...', 'Joining session');

        // 3. Create room ID
        const roomId = this.encryption.hashPassphrase(normalizedCode);

        // 4. Connect signaling
        try {
            await this.initSignaling(roomId);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`EnvSync: Failed to connect to relay — ${msg}`);
            this.cleanup();
            return;
        }

        // 5. Init P2P as receiver
        this.p2pManager = new P2PConnectionManager(this.signaling!, this.outputChannel);
        await this.p2pManager.initAsReceiver();

        // 6. Wire up file reception
        this.p2pManager.onFileReceived(async (encryptedBuffer, metadata) => {
            this.log(`Received encrypted file: ${metadata.fileName} (${encryptedBuffer.length} bytes)`);
            this.updateStatus('$(key) Decrypting...', `Received: ${metadata.fileName}`);

            try {
                // Parse the encrypted payload
                const encryptedPayload: EncryptedPayload = JSON.parse(encryptedBuffer.toString());

                // Decrypt with the wormhole code
                const decryptedData = await this.encryption.decrypt(
                    encryptedPayload,
                    normalizedCode,
                );

                this.log(`Decrypted successfully: ${metadata.fileName} (${decryptedData.length} bytes)`);
                this.updateStatus('$(check) Decrypted', `Review: ${metadata.fileName}`);

                // Hand off to IncomingFileHandler (Phase 5)
                if (this.onFileReceivedCallback) {
                    await this.onFileReceivedCallback(decryptedData, metadata.fileName);
                } else {
                    // Fallback: write directly (Phase 4 temporary behavior)
                    const targetPath = path.join(this.workspaceRoot, metadata.fileName);
                    fs.writeFileSync(targetPath, decryptedData);
                    vscode.window.showInformationMessage(
                        `EnvSync: Received and saved "${metadata.fileName}" ✅`,
                    );
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(
                    `EnvSync: Decryption failed — ${msg}\n\n` +
                    `This usually means the wormhole code was incorrect.`,
                );
                this.updateStatus('$(error) Decryption failed', msg);
            }
        });

        this.p2pManager.onTransferProgress((percent) => {
            this.updateStatus(
                `$(cloud-download) Receiving... ${percent}%`,
                'Receiving file',
            );
        });

        this.p2pManager.onError((error) => {
            vscode.window.showErrorMessage(`EnvSync P2P Error: ${error}`);
            this.updateStatus('$(error) Error', error);
        });

        this.p2pManager.onStateChange((state) => {
            this.log(`Receiver state changed: ${state}`);
            if (state === ConnectionState.Connected) {
                this.updateStatus('$(sync~spin) Ready — waiting for sender...', 'Connected to peer');
            }
        });

        vscode.window.showInformationMessage(
            'EnvSync: Connected! Waiting for file transfer...',
        );
    }

    // ════════════════════════════════════════════
    //  SIGNALING SETUP
    // ════════════════════════════════════════════

    private async initSignaling(roomId: string): Promise<void> {
        this.signaling = new SignalingService(this.outputChannel);

        this.signaling.onError((error) => {
            this.log(`Signaling error: ${error}`);
        });

        this.signaling.onDisconnected(() => {
            this.log('Signaling disconnected');
        });

        const relayUrl = this.getRelayUrl();
        this.log(`Connecting to relay: ${relayUrl}`);
        await this.signaling.connect(relayUrl, roomId);
    }

    // ════════════════════════════════════════════
    //  STATUS & LIFECYCLE
    // ════════════════════════════════════════════

    private updateStatus(text: string, tooltip: string): void {
        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = `EnvSync P2P — ${tooltip}`;
        this.statusBarItem.show();
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[Session] ${message}`);
    }

    /**
     * Clean up the current session's resources.
     */
    public cleanup(): void {
        if (this.p2pManager) {
            this.p2pManager.dispose();
            this.p2pManager = null;
        }
        if (this.signaling) {
            this.signaling.dispose();
            this.signaling = null;
        }
        this.activePassphrase = null;
        this.activeFilePath = null;
        this.statusBarItem.text = '$(lock) EnvSync';
        this.statusBarItem.tooltip = 'EnvSync P2P — No active session';
    }

    public dispose(): void {
        this.cleanup();
        this.statusBarItem.dispose();
    }
}
