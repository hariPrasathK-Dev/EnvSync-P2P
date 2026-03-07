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
            if (this.isSender) {
                this.log('Peer joined — initiating WebRTC connection');
                this.createOffer();
            }
        });
    }

    /**
     * Initialize as the sender (creates peer connection + data channel).
     */
    public async initAsSender(): Promise<void> {
        this.isSender = true;
        this.setState(ConnectionState.Connecting);
        this.log('Initialized as sender — waiting for peer to join');
    }

    /**
     * Initialize as the receiver (waits for incoming data channel).
     */
    public async initAsReceiver(): Promise<void> {
        this.isSender = false;
        this.setState(ConnectionState.Connecting);
        this.log('Initialized as receiver — waiting for sender offer');
    }

    /**
     * Create a WebRTC peer connection.
     * Falls back to WebSocket tunnel if WebRTC is unavailable in Node.js.
     */
    private createPeerConnection(): void {
        try {
            // Try to use wrtc (node-webrtc) for real WebRTC
            let RTCPeerConnectionImpl: typeof RTCPeerConnection;
            try {
                const wrtc = require('wrtc');
                RTCPeerConnectionImpl = wrtc.RTCPeerConnection;
                this.log('Using wrtc (node-webrtc) for P2P connection');
            } catch {
                // wrtc not available — use WebSocket fallback
                this.log('wrtc not available — using encrypted WebSocket tunnel fallback');
                this.useWebSocketFallback = true;
                return;
            }

            this.peerConnection = new RTCPeerConnectionImpl(P2PConnectionManager.ICE_SERVERS);

            // Handle ICE candidates
            this.peerConnection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
                if (event.candidate) {
                    this.log('Sending ICE candidate');
                    this.signaling.sendIceCandidate(event.candidate.toJSON());
                }
            };

            // Monitor connection state
            this.peerConnection.onconnectionstatechange = () => {
                const state = this.peerConnection?.connectionState;
                this.log(`Connection state: ${state}`);

                switch (state) {
                    case 'connected':
                        this.setState(ConnectionState.Connected);
                        break;
                    case 'failed':
                        this.setState(ConnectionState.Failed);
                        this.onErrorCallback?.(
                            'P2P connection failed. This may be caused by a strict NAT/firewall. ' +
                            'Try connecting from a different network.'
                        );
                        break;
                    case 'disconnected':
                        this.setState(ConnectionState.Disconnected);
                        break;
                }
            };

            // Handle ICE connection state for NAT traversal diagnostics
            this.peerConnection.oniceconnectionstatechange = () => {
                const state = this.peerConnection?.iceConnectionState;
                this.log(`ICE connection state: ${state}`);

                if (state === 'failed') {
                    this.onErrorCallback?.(
                        'NAT traversal failed — unable to establish a direct P2P connection. ' +
                        'Both peers may be behind symmetric NATs. ' +
                        'Falling back to encrypted WebSocket relay tunnel.'
                    );
                    this.useWebSocketFallback = true;
                    this.initWebSocketTunnel();
                }
            };

            // Receiver: handle incoming data channel
            if (!this.isSender) {
                this.peerConnection.ondatachannel = (event: RTCDataChannelEvent) => {
                    this.log('Incoming data channel received');
                    this.dataChannel = event.channel;
                    this.setupDataChannel();
                };
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Failed to create peer connection: ${msg}`);
            this.useWebSocketFallback = true;
        }
    }

    /**
     * Create and send an SDP offer (sender side).
     */
    private async createOffer(): Promise<void> {
        this.createPeerConnection();

        if (this.useWebSocketFallback) {
            this.initWebSocketTunnel();
            return;
        }

        if (!this.peerConnection) { return; }

        // Create data channel (sender creates it)
        this.dataChannel = this.peerConnection.createDataChannel('envsync-transfer', {
            ordered: true,        // Guaranteed ordering for file integrity
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
        this.setState(ConnectionState.Connected);

        // In fallback mode, we'll use the signaling WebSocket for data transfer too.
        // The data is already AES-256-GCM encrypted, so the relay sees only ciphertext.
        // This is architecturally acceptable because:
        //   1. The relay cannot decrypt the data (it doesn't have the wormhole code)
        //   2. The relay still has zero knowledge of the plaintext
        //   3. The only tradeoff is that data transits the relay instead of going P2P
    }

    /**
     * Send a file over the data channel (or WebSocket fallback).
     * The data should already be encrypted by EncryptionService.
     */
    public async sendFile(encryptedData: Buffer, fileName: string): Promise<void> {
        const crypto = require('crypto');
        const totalChunks = Math.ceil(encryptedData.length / P2PConnectionManager.CHUNK_SIZE);
        const checksum = crypto.createHash('sha256').update(encryptedData).digest('hex');

        this.setState(ConnectionState.Transferring);

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

        // Send chunks sequentially with progress tracking
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

            this.sendDataMessage({
                type: DataMessageType.FileChunk,
                payload: chunk,
            });

            // Progress update
            const percent = Math.round(((i + 1) / totalChunks) * 100);
            this.onTransferProgressCallback?.(percent);

            // Small delay to prevent buffer overflow
            if (i % 10 === 9) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
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

                case DataMessageType.Error:
                    this.log(`Remote error: ${message.payload}`);
                    this.onErrorCallback?.(message.payload as string);
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
            this.onErrorCallback?.(`Data integrity error: chunk ${chunk.index} is corrupted`);
            return;
        }

        this.receivedChunks.set(chunk.index, chunk.data);

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
            this.signaling.send({
                type: 'data' as any,
                roomId: '',
                payload: json,
            });
            return;
        }

        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(json);
        } else {
            this.log('Data channel not open — cannot send message');
        }
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
