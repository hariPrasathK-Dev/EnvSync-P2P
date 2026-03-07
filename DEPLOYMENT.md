# EnvSync P2P — Deployment Guide

A complete step-by-step guide to deploy and share EnvSync P2P.

---

## Overview: What Gets Deployed Where

```
┌─────────────────────────────────────────────┐
│  STEP 1: Deploy Relay Server (once)         │
│  → Free cloud platform (Render / Railway)   │
│  → Gets you a public URL like:              │
│     wss://envsync-relay.onrender.com        │
├─────────────────────────────────────────────┤
│  STEP 2: Package the VS Code Extension      │
│  → Creates a .vsix file                     │
│  → Send this file to your teammates         │
├─────────────────────────────────────────────┤
│  STEP 3: Your Friend Installs It            │
│  → Installs .vsix in their VS Code          │
│  → You both can now share files p2p!        │
└─────────────────────────────────────────────┘
```

---

## STEP 1: Deploy the Relay Server

The relay server is in `src/relay/`. It's a tiny Node.js WebSocket server
(~160 lines) that helps peers find each other. It never sees your file data.

### Option A: Deploy to Render (Recommended — Free)

1. **Create a GitHub repo** for just the relay server:
   ```bash
   # Create a new folder for the relay
   mkdir envsync-relay
   cd envsync-relay

   # Copy the relay files
   copy C:\Users\hp859\Desktop\ENVSync\src\relay\package.json .
   copy C:\Users\hp859\Desktop\ENVSync\src\relay\server.js .

   # Initialize git and push
   git init
   git add -A
   git commit -m "initial relay server"
   ```

2. **Push to GitHub**:
   - Go to https://github.com/new
   - Create a repo called `envsync-relay`
   - Follow the instructions to push your local repo

3. **Deploy on Render**:
   - Go to https://render.com and sign up (free)
   - Click **"New +"** → **"Web Service"**
   - Connect your GitHub account
   - Select the `envsync-relay` repo
   - Configure:
     | Setting | Value |
     |---|---|
     | **Name** | `envsync-relay` |
     | **Runtime** | `Node` |
     | **Build Command** | `npm install` |
     | **Start Command** | `npm start` |
     | **Plan** | `Free` |
   - Click **"Create Web Service"**
   - Wait 2-3 minutes for deployment

4. **Get your relay URL**:
   - Render will give you a URL like: `https://envsync-relay.onrender.com`
   - Your WebSocket URL is: **`wss://envsync-relay.onrender.com`**
   - Save this URL — you'll need it in Step 2

### Option B: Deploy to Railway (Alternative — Free)

1. Go to https://railway.app and sign up
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `envsync-relay` repo
4. Railway auto-detects Node.js and deploys
5. Go to **Settings** → **Networking** → **Generate Domain**
6. Your WebSocket URL will be like: `wss://envsync-relay-xxxx.up.railway.app`

### Verify Your Relay is Running

Open your browser and go to your relay URL (the `https://` version).
You'll see a connection refused or upgrade required message — that's normal!
It means the WebSocket server is running.

You can also test with:
```bash
npx wscat -c wss://envsync-relay.onrender.com
```

---

## STEP 2: Package the VS Code Extension

Now that the relay is deployed, update the extension to use your relay URL
and package it as a `.vsix` file.

### 2a. Update the Default Relay URL

Open `src/services/SessionManager.ts` and change line:
```typescript
private static readonly DEFAULT_RELAY_URL = 'ws://localhost:8787';
```
To your deployed relay URL:
```typescript
private static readonly DEFAULT_RELAY_URL = 'wss://envsync-relay.onrender.com';
```

### 2b. Rebuild the Extension

```bash
cd C:\Users\hp859\Desktop\ENVSync
npx webpack --mode production
```

### 2c. Install the Packaging Tool

```bash
npm install -g @vscode/vsce
```

### 2d. Package as .vsix

```bash
cd C:\Users\hp859\Desktop\ENVSync
vsce package
```

This creates a file like `envsync-p2p-0.1.0.vsix` in your project folder.

> **Note:** If vsce asks for a README or LICENSE, it's already there.
> If it warns about missing repository, just press Enter to continue.

---

## STEP 3: Share With Your Friend

### What to Send Your Friend

Send them **just one file**: `envsync-p2p-0.1.0.vsix`

You can send it via:
- WhatsApp / Telegram
- Email
- Google Drive
- Any file sharing method

### What Your Friend Does

1. **Install VS Code** (if they don't have it): https://code.visualstudio.com

2. **Install the extension** — either way works:

   **Option A: Command Line**
   ```bash
   code --install-extension envsync-p2p-0.1.0.vsix
   ```

   **Option B: VS Code UI**
   - Open VS Code
   - Press `Ctrl+Shift+P` → type "Install from VSIX"
   - Select the `.vsix` file
   - Restart VS Code

3. **Done!** The extension is now active.

---

## STEP 4: Using It Together

### You (the Sender):
1. Open your project in VS Code
2. Press `Ctrl+Shift+P` → **"EnvSync: Share File"**
3. Pick the `.env` file (or any git-ignored file)
4. You'll see a 3-word code like **`maple-brave-frost`**
5. Copy it and send it to your friend (via chat, call, etc.)

### Your Friend (the Receiver):
1. Open their project in VS Code
2. Press `Ctrl+Shift+P` → **"EnvSync: Join Session"**
3. Type the 3-word code: `maple-brave-frost`
4. A diff editor opens showing their local file vs your incoming file
5. Click **"Accept Incoming Configuration"** to save

### That's it! 🎉

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Failed to connect to relay" | Check your relay URL is correct and the server is running |
| "Signaling server connection timed out" | Render free tier sleeps after 15 min inactivity — visit the URL in a browser first to wake it |
| "Decryption failed" | The wormhole code was typed incorrectly — try again |
| Extension not showing in sidebar | Restart VS Code after installing the `.vsix` |
| "No git-ignored files found" | Make sure your project has a `.gitignore` that ignores `.env` files |

---

## Optional: Publish to VS Code Marketplace

If you want **anyone** to find and install your extension (not just friends you send the .vsix to):

1. Create a publisher account: https://marketplace.visualstudio.com/manage
2. Create a Personal Access Token from Azure DevOps:
   - Go to https://dev.azure.com
   - Click your profile icon → **Personal Access Tokens**
   - Create token with **Marketplace (Publish)** scope
3. Login and publish:
   ```bash
   vsce login your-publisher-name
   vsce publish
   ```

Your extension will appear in the marketplace within minutes!
