import * as vscode from 'vscode';
import WebSocket from 'ws';

/**
 * Message types used in the signaling protocol.
 * The relay server forwards these blindly — it never inspects content.
 */
export enum SignalType {
    Join = 'join',
    Offer = 'offer',
    Answer = 'answer',
    IceCandidate = 'ice-candidate',
    PeerJoined = 'peer-joined',
    PeerLeft = 'peer-left',
    Data = 'data',
    Error = 'error',
}

export interface SignalMessage {
    type: SignalType;
    roomId: string;
    payload?: unknown;
    senderId?: string;
}

/**
 * SignalingService — WebSocket client for exchanging SDP offers/answers
 * and ICE candidates through a lightweight relay server.
 *
 * Architecture:
 *  - The relay is a room-based message forwarder. It has ZERO knowledge of payloads.
 *  - Room IDs are SHA-256 hashes of the wormhole code, so the relay never
 *    sees the raw passphrase either.
 *  - No file data ever passes through the relay. Only SDP and ICE messages traverse it.
 *  - Auto-reconnect with exponential backoff for resilience.
 */
export class SignalingService implements vscode.Disposable {
    private ws: WebSocket | null = null;
    private peerId: string;
    private roomId: string = '';
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private isDisposed = false;

    // Event callbacks
    private onPeerJoinedCallback: (() => void) | null = null;
    private onOfferCallback: ((offer: RTCSessionDescriptionInit) => void) | null = null;
    private onAnswerCallback: ((answer: RTCSessionDescriptionInit) => void) | null = null;
    private onIceCandidateCallback: ((candidate: RTCIceCandidateInit) => void) | null = null;
    private onDataCallback: ((data: string) => void) | null = null;
    private onErrorCallback: ((error: string) => void) | null = null;
    private onConnectedCallback: (() => void) | null = null;
    private onDisconnectedCallback: (() => void) | null = null;

    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        // Generate a unique peer ID for this session
        const crypto = require('crypto');
        this.peerId = crypto.randomBytes(8).toString('hex');
    }

    /**
     * Connect to the signaling relay and join a room.
     */
    public async connect(relayUrl: string, roomId: string): Promise<void> {
        this.roomId = roomId;
        this.log(`Connecting to relay: ${relayUrl}, room: ${roomId.substring(0, 8)}...`);

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(relayUrl);

                const connectionTimeout = setTimeout(() => {
                    reject(new Error('Signaling server connection timed out (10s)'));
                    this.ws?.close();
                }, 10000);

                this.ws!.on('open', () => {
                    clearTimeout(connectionTimeout);
                    this.reconnectAttempts = 0;
                    this.log('Connected to signaling relay');

                    // Join the room
                    this.send({
                        type: SignalType.Join,
                        roomId: this.roomId,
                        senderId: this.peerId,
                    });

                    this.onConnectedCallback?.();
                    resolve();
                });

                this.ws!.on('message', (data: Buffer | string) => {
                    this.handleMessage(data.toString());
                });

                this.ws!.on('close', () => {
                    this.log('Disconnected from signaling relay');
                    this.onDisconnectedCallback?.();
                    if (!this.isDisposed) {
                        this.attemptReconnect(relayUrl);
                    }
                });

                this.ws!.on('error', (err: Error) => {
                    clearTimeout(connectionTimeout);
                    this.log(`WebSocket error: ${err.message}`);
                    this.onErrorCallback?.(err.message);
                    reject(err);
                });
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                reject(new Error(`Failed to connect to signaling relay: ${msg}`));
            }
        });
    }

    /**
     * Handle incoming signaling messages from the relay.
     */
    private handleMessage(raw: string): void {
        try {
            const message: SignalMessage = JSON.parse(raw);

            // Ignore our own messages
            if (message.senderId === this.peerId) {
                return;
            }

            switch (message.type) {
                case SignalType.PeerJoined:
                    this.log('Peer joined the room');
                    this.onPeerJoinedCallback?.();
                    break;

                case SignalType.Offer:
                    this.log('Received SDP offer');
                    this.onOfferCallback?.(message.payload as RTCSessionDescriptionInit);
                    break;

                case SignalType.Answer:
                    this.log('Received SDP answer');
                    this.onAnswerCallback?.(message.payload as RTCSessionDescriptionInit);
                    break;

                case SignalType.IceCandidate:
                    this.log('Received ICE candidate');
                    this.onIceCandidateCallback?.(message.payload as RTCIceCandidateInit);
                    break;

                case SignalType.Error:
                    this.log(`Signaling error: ${message.payload}`);
                    this.onErrorCallback?.(message.payload as string);
                    break;

                case SignalType.Data:
                    this.onDataCallback?.(message.payload as string);
                    break;

                default:
                    this.log(`Unknown signal type: ${message.type}`);
            }
        } catch (err) {
            this.log(`Failed to parse signaling message: ${raw}`);
        }
    }

    /**
     * Send a signaling message through the relay.
     */
    public send(message: SignalMessage): void {
        if (!this.ws || this.ws.readyState !== 1 /* WebSocket.OPEN */) {
            this.log('Cannot send: WebSocket not connected');
            return;
        }

        message.senderId = this.peerId;
        this.ws.send(JSON.stringify(message));
    }

    /**
     * Send an SDP offer to the room.
     */
    public sendOffer(offer: RTCSessionDescriptionInit): void {
        this.send({
            type: SignalType.Offer,
            roomId: this.roomId,
            payload: offer,
        });
    }

    /**
     * Send an SDP answer to the room.
     */
    public sendAnswer(answer: RTCSessionDescriptionInit): void {
        this.send({
            type: SignalType.Answer,
            roomId: this.roomId,
            payload: answer,
        });
    }

    /**
     * Send an ICE candidate to the room.
     */
    public sendIceCandidate(candidate: RTCIceCandidateInit): void {
        this.send({
            type: SignalType.IceCandidate,
            roomId: this.roomId,
            payload: candidate,
        });
    }

    /**
     * Send a data message through the relay (WebSocket tunnel fallback).
     */
    public sendData(data: string): void {
        this.send({
            type: SignalType.Data,
            roomId: this.roomId,
            payload: data,
        });
    }

    /**
     * Attempt to reconnect with exponential backoff.
     */
    private attemptReconnect(relayUrl: string): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.log('Max reconnection attempts reached');
            this.onErrorCallback?.('Lost connection to signaling server. Max retries exceeded.');
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connect(relayUrl, this.roomId);
            } catch {
                // Will trigger another reconnect via the close handler
            }
        }, delay);
    }

    // ─── Event Registration ───

    public onPeerJoined(callback: () => void): void {
        this.onPeerJoinedCallback = callback;
    }

    public onOffer(callback: (offer: RTCSessionDescriptionInit) => void): void {
        this.onOfferCallback = callback;
    }

    public onAnswer(callback: (answer: RTCSessionDescriptionInit) => void): void {
        this.onAnswerCallback = callback;
    }

    public onIceCandidate(callback: (candidate: RTCIceCandidateInit) => void): void {
        this.onIceCandidateCallback = callback;
    }

    public onData(callback: (data: string) => void): void {
        this.onDataCallback = callback;
    }

    public onError(callback: (error: string) => void): void {
        this.onErrorCallback = callback;
    }

    public onConnected(callback: () => void): void {
        this.onConnectedCallback = callback;
    }

    public onDisconnected(callback: () => void): void {
        this.onDisconnectedCallback = callback;
    }

    public getPeerId(): string {
        return this.peerId;
    }

    public isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === 1;
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[Signaling] ${message}`);
    }

    public dispose(): void {
        this.isDisposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
