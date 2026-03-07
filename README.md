# EnvSync P2P

> **Securely synchronize `.gitignored` files between developers — directly, no central server.**

EnvSync P2P is a Visual Studio Code extension that solves the pervasive problem of sharing `.env` files, local configurations, and massive test assets between team members. It uses **peer-to-peer WebRTC data channels** with **end-to-end AES-256-GCM encryption** — your secrets never touch a central server.

---

## ✨ Features

### 🔐 Wormhole-Style Code Sharing
Share files by generating a secure 3-word code (e.g., `apple-brave-chair`). Your peer enters the code, and a direct encrypted connection is established. No accounts, no setup, no SaaS.

### 🚀 Direct P2P Transfer
Files travel directly between machines via WebRTC data channels. The signaling relay only facilitates the initial handshake (SDP/ICE exchange) and never sees your data.

### 🛡️ End-to-End Encryption
All data is encrypted with **AES-256-GCM** before leaving your machine. Keys are derived from the shared wormhole code via **scrypt** (memory-hard KDF). Even if the signaling relay is compromised, your data remains encrypted.

### 📝 Semantic Diff Review
Incoming files are **never blindly overwritten**. EnvSync opens a native VS Code diff editor showing your local file alongside the incoming version. You choose to accept or reject.

### 🔍 .env Syntax Validation
Before showing the diff, EnvSync validates incoming `.env` files for:
- Invalid variable names
- Unescaped quotes
- Missing `=` separators
- Duplicate keys

Syntax errors are surfaced as VS Code warnings before you even see the diff.

### 📋 .env.example Drift Detection
When incoming `.env` files introduce new keys, EnvSync detects they're missing from `.env.example` and prompts you to add them (with redacted values) — preventing "it works on my machine" configuration drift.

### 🌳 Explorer Tree View
A dedicated **"EnvSync Peers & Files"** panel in the Explorer sidebar shows all git-ignored files and connected peers at a glance.

---

## 🚀 Quick Start

### 1. Start the Signaling Relay
The relay only forwards handshake messages — no file data ever passes through it.

```bash
cd src/relay
npx ts-node server.ts --port 8787
```

### 2. Share a File (Sender)
1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **"EnvSync: Share File"**
3. Pick the git-ignored file you want to share
4. Copy the generated 3-word code and share it with your peer

### 3. Receive a File (Receiver)
1. Open the Command Palette (`Ctrl+Shift+P`)
2. Run **"EnvSync: Join Session"**
3. Enter the 3-word code
4. Review the incoming file in the diff editor
5. Click **"Accept Incoming Configuration"** or **"Reject"**

---

## 🏗️ Architecture

```
┌─────────────────┐         ┌─────────────────┐
│   Sender IDE    │         │  Receiver IDE   │
│                 │         │                 │
│  Read File      │         │  Receive Chunks │
│       ↓         │         │       ↓         │
│  AES-256-GCM    │  WebRTC │  AES-256-GCM    │
│  Encrypt        │◄───────►│  Decrypt        │
│       ↓         │  Data   │       ↓         │
│  Chunk + Send   │  Chan.  │  Write Temp     │
│                 │         │       ↓         │
│                 │         │  Open Diff      │
│                 │         │       ↓         │
│                 │         │  Accept/Reject  │
└────────┬────────┘         └────────┬────────┘
         │  SDP/ICE only             │
         └──────────┬────────────────┘
                    │
           ┌────────▼────────┐
           │  Signaling      │
           │  Relay Server   │
           │  (zero-knowledge│
           │   of payloads)  │
           └─────────────────┘
```

### Key Components

| Component | Purpose |
|---|---|
| `EncryptionService` | AES-256-GCM encryption with scrypt key derivation |
| `WormholeCodeGenerator` | Cryptographically secure 3-word code generation |
| `SignalingService` | WebSocket client for SDP/ICE exchange |
| `P2PConnectionManager` | WebRTC data channel with chunked transfer |
| `SessionManager` | Orchestrates the full share/receive lifecycle |
| `IncomingFileHandler` | Temp file management and diff editor integration |
| `DotEnvParser` | Structured .env parsing with syntax validation |
| `EnvExampleSync` | Drift detection against .env.example |
| `WorkspaceScanner` | Git-ignored file discovery |
| `PeersTreeProvider` | Explorer sidebar tree view |

---

## ⚙️ Configuration

| Setting | Default | Description |
|---|---|---|
| `envsync.relayUrl` | `ws://localhost:8787` | Signaling relay WebSocket URL |

---

## 🔒 Security Model

See [SECURITY.md](SECURITY.md) for the full threat model and cryptographic details.

**TL;DR:**
- **Zero-trust**: No plaintext ever leaves your machine
- **E2E encrypted**: AES-256-GCM with scrypt-derived keys
- **Relay is blind**: Only sees hashed room IDs and encrypted SDP
- **No accounts**: Wormhole codes are ephemeral session identifiers
- **Secure cleanup**: Temp files are overwritten with zeros before deletion

---

## 📦 Development

```bash
# Install dependencies
npm install

# Watch mode (auto-rebuild)
npm run watch

# Production build
npm run compile

# Press F5 in VS Code to launch Extension Development Host
```

---

## 📄 License

MIT
