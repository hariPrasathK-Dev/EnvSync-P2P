"use strict";
/**
 * EnvSync P2P — Minimal Signaling Relay Server
 *
 * This is a lightweight WebSocket relay for exchanging SDP offers/answers
 * and ICE candidates between peers. It operates as a room-based message
 * forwarder with ZERO knowledge of payloads.
 *
 * Security Guarantees:
 *  - The relay never inspects, stores, or logs message payloads
 *  - Room IDs are SHA-256 hashes — the relay never sees wormhole codes
 *  - No file data transits this server under normal operation
 *  - Even in WebSocket fallback mode, data is AES-256-GCM encrypted
 *    before reaching the relay — it only sees ciphertext
 *
 * Usage:
 *   npx ts-node src/relay/server.ts [--port 8787]
 *
 * Or after building:
 *   node dist/relay/server.js [--port 8787]
 */
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const PORT = parseInt(process.env.PORT ||
    process.argv.find((_, i, arr) => arr[i - 1] === '--port') ||
    '8787', 10);
const rooms = new Map();
// Auto-cleanup rooms older than 1 hour
const ROOM_TTL_MS = 60 * 60 * 1000;
const wss = new ws_1.WebSocketServer({ port: PORT, host: '0.0.0.0' });
console.log(`[EnvSync Relay] Signaling relay started on port ${PORT}`);
console.log(`[EnvSync Relay] This server forwards SDP/ICE messages only.`);
console.log(`[EnvSync Relay] No file data is stored or inspected.`);
console.log('─'.repeat(50));
wss.on('connection', (ws) => {
    let currentRoom = null;
    // Keepalive: ping every 25s to prevent Render/proxy timeout
    const pingInterval = setInterval(() => {
        if (ws.readyState === 1 /* OPEN */) {
            ws.ping();
        }
    }, 25000);
    ws.on('pong', () => {
        // Client is alive — nothing to do
    });
    ws.on('message', (raw) => {
        try {
            const message = JSON.parse(raw.toString());
            if (!message.type || !message.roomId) {
                ws.send(JSON.stringify({
                    type: 'error',
                    payload: 'Invalid message: missing type or roomId',
                }));
                return;
            }
            const { type, roomId, senderId } = message;
            if (type === 'join') {
                // Create room if it doesn't exist
                if (!rooms.has(roomId)) {
                    rooms.set(roomId, {
                        clients: new Set(),
                        createdAt: new Date(),
                    });
                    console.log(`[Room] Created: ${roomId.substring(0, 8)}...`);
                }
                const room = rooms.get(roomId);
                // Check if there are existing peers BEFORE adding the new one
                const existingPeerCount = room.clients.size;
                room.clients.add(ws);
                currentRoom = roomId;
                console.log(`[Room] ${roomId.substring(0, 8)}... — peer joined (${room.clients.size} total)`);
                // Notify OTHER peers in the room about the new joiner
                broadcast(roomId, ws, {
                    type: 'peer-joined',
                    roomId,
                    senderId,
                });
                // Also notify the JOINING peer about existing peers
                // This ensures the sender knows the receiver is already there
                if (existingPeerCount > 0) {
                    ws.send(JSON.stringify({
                        type: 'peer-joined',
                        roomId,
                        senderId: 'existing-peer',
                    }));
                    console.log(`[Room] ${roomId.substring(0, 8)}... — notified joiner about ${existingPeerCount} existing peer(s)`);
                }
                return;
            }
            // For all other message types, forward to peers in the same room
            if (!rooms.has(roomId)) {
                ws.send(JSON.stringify({
                    type: 'error',
                    payload: 'Room not found. Join a room first.',
                }));
                return;
            }
            // Log data forwarding for debugging
            if (type === 'data') {
                console.log(`[Data] ${roomId.substring(0, 8)}... — forwarding data message`);
            }
            // Forward the message verbatim to all other clients in the room
            broadcast(roomId, ws, message);
        }
        catch (err) {
            console.error('[Error] Failed to parse message');
        }
    });
    ws.on('close', () => {
        clearInterval(pingInterval);
        if (currentRoom && rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);
            room.clients.delete(ws);
            console.log(`[Room] ${currentRoom.substring(0, 8)}... — peer left (${room.clients.size} remaining)`);
            // Notify remaining peers
            broadcast(currentRoom, ws, {
                type: 'peer-left',
                roomId: currentRoom,
            });
            // Clean up empty rooms
            if (room.clients.size === 0) {
                rooms.delete(currentRoom);
                console.log(`[Room] ${currentRoom.substring(0, 8)}... — room closed (empty)`);
            }
        }
    });
    ws.on('error', (err) => {
        console.error(`[Error] WebSocket error: ${err.message}`);
    });
});
/**
 * Broadcast a message to all clients in a room except the sender.
 */
function broadcast(roomId, sender, message) {
    const room = rooms.get(roomId);
    if (!room) {
        return;
    }
    const json = JSON.stringify(message);
    for (const client of room.clients) {
        if (client !== sender && client.readyState === ws_1.WebSocket.OPEN) {
            client.send(json);
        }
    }
}
/**
 * Periodic cleanup of stale rooms.
 */
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if (now - room.createdAt.getTime() > ROOM_TTL_MS) {
            // Close all connections in the stale room
            for (const client of room.clients) {
                client.close();
            }
            rooms.delete(roomId);
            console.log(`[Cleanup] Room ${roomId.substring(0, 8)}... expired and removed`);
        }
    }
}, 5 * 60 * 1000); // Check every 5 minutes
