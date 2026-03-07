/**
 * WebRTC type declarations for Node.js environment.
 *
 * In the browser, these types are globally available. In Node.js (VS Code extension),
 * we need to declare them ourselves. At runtime, the actual implementations come
 * from the `wrtc` package (node-webrtc) or the WebSocket fallback.
 */

// SDP types
interface RTCSessionDescriptionInit {
    type: RTCSdpType;
    sdp?: string;
}

type RTCSdpType = 'offer' | 'answer' | 'pranswer' | 'rollback';

declare class RTCSessionDescription {
    constructor(init?: RTCSessionDescriptionInit);
    readonly type: RTCSdpType;
    readonly sdp: string;
    toJSON(): RTCSessionDescriptionInit;
}

// ICE types
interface RTCIceCandidateInit {
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
}

declare class RTCIceCandidate {
    constructor(init?: RTCIceCandidateInit);
    readonly candidate: string;
    readonly sdpMid: string | null;
    readonly sdpMLineIndex: number | null;
    toJSON(): RTCIceCandidateInit;
}

// Peer Connection types
interface RTCConfiguration {
    iceServers?: RTCIceServer[];
    iceTransportPolicy?: RTCIceTransportPolicy;
    bundlePolicy?: RTCBundlePolicy;
}

interface RTCIceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

type RTCIceTransportPolicy = 'all' | 'relay';
type RTCBundlePolicy = 'balanced' | 'max-compat' | 'max-bundle';

interface RTCPeerConnectionIceEvent extends Event {
    readonly candidate: RTCIceCandidate | null;
}

interface RTCDataChannelEvent extends Event {
    readonly channel: RTCDataChannel;
}

interface RTCDataChannelInit {
    ordered?: boolean;
    maxPacketLifeTime?: number;
    maxRetransmits?: number;
    protocol?: string;
    negotiated?: boolean;
    id?: number;
}

interface RTCDataChannel extends EventTarget {
    readonly label: string;
    readonly readyState: RTCDataChannelState;
    binaryType: string;
    onopen: ((this: RTCDataChannel, ev: Event) => void) | null;
    onclose: ((this: RTCDataChannel, ev: Event) => void) | null;
    onerror: ((this: RTCDataChannel, ev: Event) => void) | null;
    onmessage: ((this: RTCDataChannel, ev: MessageEvent) => void) | null;
    send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
    close(): void;
}

type RTCDataChannelState = 'connecting' | 'open' | 'closing' | 'closed';

declare class RTCPeerConnection extends EventTarget {
    constructor(config?: RTCConfiguration);
    readonly connectionState: RTCPeerConnectionState;
    readonly iceConnectionState: RTCIceConnectionState;
    readonly signalingState: RTCSignalingState;
    onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => void) | null;
    ondatachannel: ((this: RTCPeerConnection, ev: RTCDataChannelEvent) => void) | null;
    onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => void) | null;
    oniceconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => void) | null;
    createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel;
    createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
    createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
    setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
    setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
    addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
    close(): void;
}

type RTCPeerConnectionState = 'closed' | 'connected' | 'connecting' | 'disconnected' | 'failed' | 'new';
type RTCIceConnectionState = 'checking' | 'closed' | 'completed' | 'connected' | 'disconnected' | 'failed' | 'new';
type RTCSignalingState = 'closed' | 'have-local-offer' | 'have-local-pranswer' | 'have-remote-offer' | 'have-remote-pranswer' | 'stable';

interface RTCOfferOptions {
    iceRestart?: boolean;
    offerToReceiveAudio?: boolean;
    offerToReceiveVideo?: boolean;
}

interface RTCAnswerOptions { }
