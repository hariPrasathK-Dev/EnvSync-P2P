import * as vscode from 'vscode';
import { SignalingService, SignalType } from './SignalingService';

/**
 * Transfer protocol message types sent over the WebRTC data channel.
 */
export enum DataMessageType {
    FileMetadata = 'file-metadata',
    FileChunk = 'file-chunk',
    FileComplete = 'file-complete',
    Ack = 'ack',
    Ready = 'ready',
    Error = 'error',
}

export interface FileMetadata {
    fileName: string;
    fileSize: number;
    totalChunks: number;
    checksum: string; // SHA-256 of the full encrypted payload
}

export interface FileChunk {
    index: number;
    data: string; // base64 encoded chunk
    checksum: string; // SHA-256 of this chunk
}

export interface DataMessage {
    type: DataMessageType;
    payload?: unknown;
}

/** Connection state exposed to the UI */
export enum ConnectionState {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Transferring = 'transferring',
    Failed = 'failed',
}

/**
 * P2PConnectionManager — Manages WebRTC peer connections and data channels
 * for direct, encrypted file transfer between peers.
 *
 * Architecture:
 *  - Uses wrtc (node-webrtc) or a WebSocket-based encrypted tunnel fallback
 *  - Data channel configured for reliable, ordered delivery
 *  - Files are chunked into 16KB pieces with per-chunk checksums
 *  - Full file SHA-256 checksum verification after transfer
 *  - STUN servers for NAT traversal (Google's public STUN)
 *
 * Data Flow:
 *  1. Sender creates RTCPeerConnection + data channel
 *  2. SDP offer/answer exchanged via SignalingService
 *  3. ICE candidates exchanged for NAT traversal
 *  4. Data channel opens → chunked transfer begins
 *  5. Receiver verifies checksums → emits completion event
 */
export class P2PConnectionManager implements vscode.Disposable {
    private static readonly CHUNK_SIZE = 16 * 1024; // 16 KB chunks
    private static readonly ICE_SERVERS: RTCConfiguration = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
        ],
    };

    private peerConnection: RTCPeerConnection | null = null;
    private dataChannel: RTCDataChannel | null = null;
    private signaling: SignalingService;
    private outputChannel: vscode.OutputChannel;

    private state: ConnectionState = ConnectionState.Disconnected;
    private isSender = false;

    // Transfer state
    private receivedChunks: Map<number, string> = new Map();
    private expectedMetadata: FileMetadata | null = null;

    // Event callbacks
    private onStateChangeCallback: ((state: ConnectionState) => void) | null = null;
    private onFileReceivedCallback: ((data: Buffer, metadata: FileMetadata) => void) | null = null;
    private onTransferProgressCallback: ((percent: number) => void) | null = null;
    private onErrorCallback: ((error: string) => void) | null = null;

    // Use WebSocket tunnel as fallback when WebRTC is unavailable
    private useWebSocketFallback = false;

    // Guard: prevent duplicate startConnection calls
    private connectionStarted = false;

    // Timeout for Ready handshake fallback
    private readyTimeout: ReturnType<typeof setTimeout> | null = null;

    // Stop-and-wait ACK resolver
    private pendingChunkAck: ((index: number) => void) | null = null;

    constructor(signaling: SignalingService, outputChannel: vscode.OutputChannel) {
        this.signaling = signaling;
        this.outputChannel = outputChannel;
        this.setupSignalingHandlers();
    }

    /**
     * Wire up signaling events for SDP/ICE exchange.
     */
    private setupSignalingHandlers(): void {
        this.signaling.onOffer(async (offer) => {
            this.log('Processing incoming SDP offer');
            await this.handleOffer(offer);
        });

        this.signaling.onAnswer(async (answer) => {
            this.log('Processing incoming SDP answer');
            await this.handleAnswer(answer);
        });

        this.signaling.onIceCandidate(async (candidate) => {
            await this.handleRemoteIceCandidate(candidate);
        });

        this.signaling.onPeerJoined(() => {
            this.log('Peer joined event received');

            if (this.isSender && !this.connectionStarted) {
                this.log('Sender: peer joined — initiating connection');
                this.startConnection();
            }

            if (!this.isSender && this.useWebSocketFallback) {
                // Receiver: re-send Ready in case the first one was lost
                // (e.g. sender hadn't joined yet when first Ready was sent)
                this.log('Receiver: peer joined — re-sending Ready handshake');
                this.sendDataMessage({ type: DataMessageType.Ready });
            }
        });
    }

    /**
     * Initialize as the sender (creates peer connection + data channel).
     */
    public async initAsSender(): Promise<void> {
        this.isSender = true;
        this.setState(ConnectionState.Connecting);

        // Eagerly detect if wrtc is available
        this.createPeerConnection();

        this.log(
            this.useWebSocketFallback
                ? 'Initialized as sender (WebSocket tunnel) — waiting for peer'
                : 'Initialized as sender (WebRTC) — waiting for peer',
        );
    }

    /**
     * Initialize as the receiver (waits for incoming data channel).
     */
    public async initAsReceiver(): Promise<void> {
        this.isSender = false;
        this.setState(ConnectionState.Connecting);

        // Eagerly detect if wrtc is available
        this.createPeerConnection();

        // In fallback mode, set up the WebSocket tunnel immediately
        // (no SDP offer will arrive, so we can't wait for handleOffer)
        if (this.useWebSocketFallback) {
            this.initWebSocketTunnel();
        }

        this.log(
            this.useWebSocketFallback
                ? 'Initialized as receiver (WebSocket tunnel) — ready to receive'
                : 'Initialized as receiver (WebRTC) — waiting for sender offer',
        );
    }

    private createPeerConnection(): void {
        this.log('WebRTC (wrtc) native module disabled in VS Code extensions.');
        this.log('Defaulting to encrypted WebSocket tunnel fallback.');
        this.useWebSocketFallback = true;
    }

    /**
     * Start a connection — try WebRTC first, fall back to WebSocket tunnel.
     * Called when peer joins (sender side). createPeerConnection was already
     * called in initAsSender, so we just check the fallback flag.
     */
    private async startConnection(): Promise<void> {
        if (this.connectionStarted) {
            this.log('startConnection already called — skipping');
            return;
        }
        this.connectionStarted = true;
        if (this.useWebSocketFallback) {
            this.initWebSocketTunnel();
            return;
        }

        // WebRTC path — create offer
        await this.createOffer();
    }

    /**
     * Create and send an SDP offer (sender side).
     */
    private async createOffer(): Promise<void> {
        if (!this.peerConnection) { return; }

        // Create data channel (sender creates it)
        this.dataChannel = this.peerConnection.createDataChannel('envsync-transfer', {
            ordered: true,
        });
        this.setupDataChannel();

        try {
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
            this.signaling.sendOffer(offer);
            this.log('SDP offer sent');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Failed to create offer: ${msg}`);
            this.onErrorCallback?.(`Failed to create P2P offer: ${msg}`);
        }
    }

    /**
     * Handle an incoming SDP offer (receiver side).
     */
    private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
        this.createPeerConnection();

        if (this.useWebSocketFallback) {
            this.initWebSocketTunnel();
            return;
        }

        if (!this.peerConnection) { return; }

        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
            this.signaling.sendAnswer(answer);
            this.log('SDP answer sent');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Failed to handle offer: ${msg}`);
            this.onErrorCallback?.(`Failed to establish P2P connection: ${msg}`);
        }
    }

    /**
     * Handle an incoming SDP answer (sender side).
     */
    private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        if (!this.peerConnection) { return; }

        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            this.log('Remote description set from SDP answer');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Failed to set remote description: ${msg}`);
        }
    }

    /**
     * Handle an incoming ICE candidate.
     */
    private async handleRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        if (!this.peerConnection) { return; }

        try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            this.log('Added remote ICE candidate');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Failed to add ICE candidate: ${msg}`);
        }
    }

    /**
     * Configure the data channel event handlers.
     */
    private setupDataChannel(): void {
        if (!this.dataChannel) { return; }

        this.dataChannel.binaryType = 'arraybuffer';

        this.dataChannel.onopen = () => {
            this.log('Data channel opened — ready for transfer');
            this.setState(ConnectionState.Connected);
        };

        this.dataChannel.onmessage = (event: MessageEvent) => {
            this.handleDataMessage(event.data);
        };

        this.dataChannel.onerror = (event: Event) => {
            this.log(`Data channel error: ${event}`);
            this.onErrorCallback?.('Data channel error occurred during transfer');
        };

        this.dataChannel.onclose = () => {
            this.log('Data channel closed');
        };
    }

    /**
     * Initialize a WebSocket-based encrypted tunnel as a fallback
     * when WebRTC is unavailable (e.g., strict NAT or missing wrtc).
     *
     * IMPORTANT: Even in fallback mode, all data is E2E encrypted before
     * being sent. The relay only sees ciphertext.
     */
    private initWebSocketTunnel(): void {
        this.log('Initializing encrypted WebSocket tunnel fallback');

        // Wire up incoming data messages from the signaling relay
        this.signaling.onData((data: string) => {
            this.handleDataMessage(data);
        });

        if (this.isSender) {
            // Sender: wait for the receiver's Ready signal
            this.log('Sender tunnel ready — waiting for receiver Ready handshake...');

            // Fallback: if Ready doesn't arrive in 3 seconds, proceed anyway
            // (handles edge cases where Ready is lost)
            this.readyTimeout = setTimeout(() => {
                if (this.state !== ConnectionState.Connected &&
                    this.state !== ConnectionState.Transferring) {
                    this.log('Ready timeout — proceeding without handshake');
                    this.setState(ConnectionState.Connected);
                }
            }, 3000);
        } else {
            // Receiver: send Ready message to tell sender we're listening
            this.log('Receiver tunnel ready — sending Ready handshake to sender');
            this.sendDataMessage({ type: DataMessageType.Ready });
            this.setState(ConnectionState.Connected);
        }
    }

    /**
     * Send a file over the data channel (or WebSocket fallback).
     * The data should already be encrypted by EncryptionService.
     */
    public async sendFile(encryptedData: Buffer, fileName: string): Promise<void> {
        const crypto = require('crypto');

        // Handle empty file edge case (0-byte .env) requires at least 1 chunk
        const totalChunks = Math.max(1, Math.ceil(encryptedData.length / P2PConnectionManager.CHUNK_SIZE));
        const checksum = crypto.createHash('sha256').update(encryptedData).digest('hex');

        this.setState(ConnectionState.Transferring);

        // Small delay to ensure receiver's signaling handlers are processing
        await new Promise(resolve => setTimeout(resolve, 500));
        this.log(`Starting file transfer: ${fileName}`);

        // Send metadata first
        const metadata: FileMetadata = {
            fileName,
            fileSize: encryptedData.length,
            totalChunks,
            checksum,
        };

        this.sendDataMessage({
            type: DataMessageType.FileMetadata,
            payload: metadata,
        });

        this.log(`Sending file: ${fileName} (${encryptedData.length} bytes, ${totalChunks} chunks)`);

        // Send chunks sequentially with stop-and-wait ACK to handle backpressure and ordering
        for (let i = 0; i < totalChunks; i++) {
            const start = i * P2PConnectionManager.CHUNK_SIZE;
            const end = Math.min(start + P2PConnectionManager.CHUNK_SIZE, encryptedData.length);
            const chunkData = encryptedData.subarray(start, end);
            const chunkChecksum = crypto.createHash('sha256').update(chunkData).digest('hex');

            const chunk: FileChunk = {
                index: i,
                data: chunkData.toString('base64'),
                checksum: chunkChecksum,
            };

            let retries = 5;
            let acked = false;
            while (retries > 0 && !acked) {
                // Backpressure Check: Wait if underlying buffer exceeds high-water mark
                const HIGH_WATER_MARK = 64 * 1024; // 64KB threshold
                while (this.getBufferedAmount() > HIGH_WATER_MARK) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }

                this.sendDataMessage({
                    type: DataMessageType.FileChunk,
                    payload: chunk,
                });

                try {
                    await new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('ACK timeout')), 5000);
                        this.pendingChunkAck = (ackIndex: number) => {
                            if (ackIndex === i) {
                                clearTimeout(timeout);
                                this.pendingChunkAck = null;
                                resolve();
                            }
                        };
                    });
                    acked = true;
                } catch (err) {
                    retries--;
                    this.log(`Chunk ${i} ack timeout, retrying... (${retries} retries left)`);
                }
            }

            if (!acked) {
                this.log(`Failed to send chunk ${i} after 5 retries. Aborting transfer.`);
                this.onErrorCallback?.(`Transfer failed: could not send chunk ${i} (network timeout)`);
                this.setState(ConnectionState.Failed);
                return;
            }

            // Progress update
            const percent = Math.round(((i + 1) / totalChunks) * 100);
            this.onTransferProgressCallback?.(percent);
        }

        // Send completion message
        this.sendDataMessage({
            type: DataMessageType.FileComplete,
            payload: { checksum },
        });

        this.log('File transfer complete');
        this.setState(ConnectionState.Connected);
    }

    /**
     * Handle incoming data channel messages (receiver side).
     */
    private handleDataMessage(raw: string | ArrayBuffer): void {
        try {
            const str = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString();
            const message: DataMessage = JSON.parse(str);

            switch (message.type) {
                case DataMessageType.FileMetadata:
                    this.handleFileMetadata(message.payload as FileMetadata);
                    break;

                case DataMessageType.FileChunk:
                    this.handleFileChunk(message.payload as FileChunk);
                    break;

                case DataMessageType.FileComplete:
                    this.handleFileComplete();
                    break;

                case DataMessageType.Ack:
                    const ackIndex = message.payload as number;
                    if (this.pendingChunkAck) {
                        this.pendingChunkAck(ackIndex);
                    }
                    break;

                case DataMessageType.Error:
                    this.log(`Remote error: ${message.payload}`);
                    this.onErrorCallback?.(message.payload as string);
                    break;

                case DataMessageType.Ready:
                    this.log('Received Ready handshake from receiver');
                    if (this.isSender) {
                        // Clear the fallback timeout
                        if (this.readyTimeout) {
                            clearTimeout(this.readyTimeout);
                            this.readyTimeout = null;
                        }
                        // Receiver is ready — now set Connected to trigger file send
                        if (this.state !== ConnectionState.Connected &&
                            this.state !== ConnectionState.Transferring) {
                            this.setState(ConnectionState.Connected);
                        }
                    }
                    break;
            }
        } catch (err) {
            this.log(`Failed to parse data message`);
        }
    }

    private handleFileMetadata(metadata: FileMetadata): void {
        this.expectedMetadata = metadata;
        this.receivedChunks.clear();
        this.setState(ConnectionState.Transferring);
        this.log(`Receiving file: ${metadata.fileName} (${metadata.fileSize} bytes, ${metadata.totalChunks} chunks)`);
    }

    private handleFileChunk(chunk: FileChunk): void {
        const crypto = require('crypto');

        // Verify chunk checksum
        const chunkData = Buffer.from(chunk.data, 'base64');
        const actualChecksum = crypto.createHash('sha256').update(chunkData).digest('hex');

        if (actualChecksum !== chunk.checksum) {
            this.log(`Chunk ${chunk.index} checksum mismatch! Expected: ${chunk.checksum}, Got: ${actualChecksum}`);
            // Do NOT acknowledge corrupted/out-of-order chunk — sender will timeout and retry
            return;
        }

        this.receivedChunks.set(chunk.index, chunk.data);

        // Send ACK back to sender to prevent buffer overflow and ensure order
        this.sendDataMessage({
            type: DataMessageType.Ack,
            payload: chunk.index,
        });

        // Progress update
        if (this.expectedMetadata) {
            const percent = Math.round((this.receivedChunks.size / this.expectedMetadata.totalChunks) * 100);
            this.onTransferProgressCallback?.(percent);
        }
    }

    private handleFileComplete(): void {
        const crypto = require('crypto');

        if (!this.expectedMetadata) {
            this.log('Received file complete marker but no metadata was set');
            return;
        }

        // Reassemble the file from chunks
        const chunks: Buffer[] = [];
        for (let i = 0; i < this.expectedMetadata.totalChunks; i++) {
            const chunkData = this.receivedChunks.get(i);
            if (!chunkData) {
                this.log(`Missing chunk ${i}`);
                this.onErrorCallback?.(`File transfer incomplete: missing chunk ${i} of ${this.expectedMetadata.totalChunks}`);
                return;
            }
            chunks.push(Buffer.from(chunkData, 'base64'));
        }

        const fullData = Buffer.concat(chunks);

        // Verify full file checksum
        const actualChecksum = crypto.createHash('sha256').update(fullData).digest('hex');
        if (actualChecksum !== this.expectedMetadata.checksum) {
            this.log(`File checksum mismatch! Expected: ${this.expectedMetadata.checksum}, Got: ${actualChecksum}`);
            this.onErrorCallback?.('File integrity verification failed — the file may be corrupted');
            return;
        }

        this.log(`File received and verified: ${this.expectedMetadata.fileName} (${fullData.length} bytes)`);
        this.onFileReceivedCallback?.(fullData, this.expectedMetadata);
        this.setState(ConnectionState.Connected);

        // Cleanup
        this.receivedChunks.clear();
        this.expectedMetadata = null;
    }

    /**
     * Send a data message through the data channel or WebSocket fallback.
     */
    private sendDataMessage(message: DataMessage): void {
        const json = JSON.stringify(message);

        if (this.useWebSocketFallback) {
            // Use the signaling WebSocket as an encrypted tunnel
            this.signaling.sendData(json);
            return;
        }

        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(json);
        } else {
            this.log('Data channel not open — cannot send message');
        }
    }

    /**
     * Get the current buffered amount from the active transport.
     */
    private getBufferedAmount(): number {
        if (this.useWebSocketFallback) {
            return this.signaling.bufferedAmount;
        } else if (this.dataChannel) {
            return (this.dataChannel as any).bufferedAmount || 0;
        }
        return 0;
    }

    // ─── Event Registration ───

    public onStateChange(callback: (state: ConnectionState) => void): void {
        this.onStateChangeCallback = callback;
    }

    public onFileReceived(callback: (data: Buffer, metadata: FileMetadata) => void): void {
        this.onFileReceivedCallback = callback;
    }

    public onTransferProgress(callback: (percent: number) => void): void {
        this.onTransferProgressCallback = callback;
    }

    public onError(callback: (error: string) => void): void {
        this.onErrorCallback = callback;
    }

    public getState(): ConnectionState {
        return this.state;
    }

    private setState(newState: ConnectionState): void {
        this.state = newState;
        this.onStateChangeCallback?.(newState);
        this.log(`State: ${newState}`);
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[P2P] ${message}`);
    }

    public dispose(): void {
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        this.receivedChunks.clear();
        this.expectedMetadata = null;
    }
}
