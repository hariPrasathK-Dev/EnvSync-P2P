# EnvSync P2P
> **Securely synchronize `.gitignored` files between developers — directly, continuously, with no central server.**

EnvSync P2P is a Visual Studio Code extension designed to solve the pervasive problem of sharing `.env` files, local configurations, and massive test assets between team members. By leveraging peer-to-peer WebRTC data channels and end-to-end AES-256-GCM encryption, EnvSync ensures your sensitive secrets and configurations never touch a central SaaS server.

## Demonstration
*(Note for developer: Record your screen showing the connection and live sync, save it as an mp4 or gif, place it in an assets folder in your repository, and update the URL above.)*

## ✨ Key Features

### 🔄 Continuous Live Synchronization
Unlike static file transfers, EnvSync creates a persistent, secure tunnel. Once the initial connection is established, the extension watches your active configuration file. As you type and save, updates are debounced and automatically synced to your peer in the background, eliminating the need to repeatedly send files.

### 🔐 Wormhole-Style Code Handshake
Establish connections effortlessly by generating a secure 3-word passphrase (e.g., `apple-brave-chair`). Your peer enters the code, and a direct encrypted connection is established. No accounts, no manual key exchanges, and no complex setup required.

### 🛡️ End-to-End Encryption
All payloads are encrypted with AES-256-GCM before leaving your machine. Encryption keys are derived locally from the shared wormhole code via scrypt (a memory-hard key derivation function). Even if the signaling relay is compromised, your data remains cryptographically secure.

### 📝 Smart Semantic Diff Review
Incoming files are never blindly overwritten. On the first transfer, EnvSync opens a native VS Code diff editor showing your local file alongside the incoming remote version, allowing you to manually review, accept, or reject the changes. Subsequent live-sync updates are applied silently to maintain workflow focus.

### 🔍 Configuration Syntax Validation
Before prompting a review, EnvSync validates incoming `.env` files for common syntax errors, including:
- Invalid variable naming conventions
- Unescaped quotes
- Missing `=` separators
- Duplicate keys

Errors and warnings are surfaced natively within VS Code to prevent broken configurations from entering your local environment.

### 📋 Schema Drift Detection
When incoming `.env` files introduce new keys, the extension detects that they are missing from your local `.env.example` template. It automatically prompts you to add them (with redacted values), preventing "it works on my machine" configuration drift across your team.

### 🌳 Dedicated Workspace Explorer
Manage your environment seamlessly via the **"EnvSync Peers & Files"** panel in the Explorer sidebar, which provides an at-a-glance view of all git-ignored files and active peer connections.

## 🚀 Getting Started

### 1. Share a Configuration (Sender)
1. Open the VS Code Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Execute **"EnvSync: Share File"**.
3. Select the git-ignored file you wish to share from the prompt.
4. Copy the generated 3-word code and share it securely with your peer.
5. Keep the file open; subsequent saves will automatically sync to the connected peer.

### 2. Receive a Configuration (Receiver)
1. Open the Command Palette.
2. Execute **"EnvSync: Join Session"**.
3. Enter the provided 3-word code.
4. Review the initial incoming file via the VS Code diff editor and click **"Accept Incoming Configuration"**.
5. The session remains active, and any further saves by the sender will update your local file automatically.

### 3. End the Session
To terminate the continuous sync, click the **"EnvSync: Connected"** item in your VS Code Status Bar and select "Disconnect", or run the **"EnvSync: Stop Session"** command.

*(Note: The extension uses a hosted signaling relay by default to facilitate the initial connection. You can also host your own relay server if preferred).*

## 🏗️ Architecture Overview

### Core Services
*(Refer to the repository for detailed component documentation)*

### Extension Settings
You can customize EnvSync through your `settings.json` or the VS Code Settings UI:
- `envsync.relayUrl`: Signaling relay WebSocket URL (Defaults to hosted relay)

## 🔒 Security Model
For comprehensive cryptographic details and threat models, please refer to the `SECURITY.md` file in the repository.

**Key Security Guarantees:**
- **Zero-Trust Architecture:** No plaintext data ever leaves your local machine.
- **Strong Cryptography:** AES-256-GCM authenticated encryption.
- **Blind Relay:** The signaling server only processes hashed room IDs and encrypted SDP packets.
- **Secure Ephemeral Storage:** Temporary files generated during diff reviews are overwritten with zeros prior to deletion.

## 📦 Local Development
If you wish to contribute or build the extension locally:
- Press `F5` in VS Code to launch the Extension Development Host.

## 📄 License
This project is licensed under the MIT License.