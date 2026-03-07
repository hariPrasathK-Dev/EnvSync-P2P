# Security Policy — EnvSync P2P

## Zero-Trust Architecture

EnvSync P2P is designed around a **zero-trust** principle: no component other than the sender's and receiver's local VS Code instances ever has access to plaintext file data.

---

## Cryptographic Design

### Encryption Algorithm: AES-256-GCM

| Parameter | Value | Rationale |
|---|---|---|
| Algorithm | AES-256-GCM | Authenticated encryption — provides confidentiality + integrity |
| Key Size | 256 bits (32 bytes) | Full AES-256 strength |
| IV Length | 96 bits (12 bytes) | GCM's recommended IV size |
| Auth Tag | 128 bits (16 bytes) | Maximum GCM authentication tag length |
| Salt | 256 bits (32 bytes) | Unique per encryption, prevents rainbow tables |

**Why GCM?** GCM provides authenticated encryption — both confidentiality and integrity in one pass. If an attacker modifies even a single bit of the ciphertext, decryption fails. This eliminates the need for a separate HMAC.

### Key Derivation: scrypt

| Parameter | Value | Rationale |
|---|---|---|
| KDF | scrypt | Memory-hard — resists GPU/FPGA brute-force |
| Cost (N) | 16384 (2¹⁴) | Balances security and interactive speed |
| Block Size (r) | 8 | Standard parameter |
| Parallelism (p) | 1 | Single-threaded derivation |

**Why scrypt over PBKDF2?** The wormhole code entropy is intentionally low (~24 bits for usability). scrypt's memory-hardness makes brute-force attacks orders of magnitude more expensive than PBKDF2, even with GPUs.

### Wormhole Code (PAKE Seed)

- **Format**: 3 words from a 256-word list (e.g., `apple-brave-chair`)
- **Entropy**: 24 bits (3 × log₂(256))
- **Purpose**: Serves as both signaling room identifier (hashed) and encryption key seed
- **Lifetime**: Ephemeral — valid for a single transfer session (minutes)
- **Generation**: Uses `crypto.randomInt()` backed by the OS CSPRNG

**Why is 24 bits acceptable?** The code is short-lived (single-use, single-session) and behind scrypt's computational barrier. An attacker would need both network access AND the ability to perform ~16 million scrypt evaluations within the brief session window.

---

## Network Security

### Signaling Relay

The signaling relay server is a **blind message forwarder**:

| Property | Guarantee |
|---|---|
| Payload inspection | ❌ Never — messages are forwarded verbatim |
| Payload storage | ❌ Never — messages exist only in transit |
| Payload logging | ❌ Never — only room join/leave events are logged |
| Room ID knowledge | Only SHA-256 hashes — never the raw wormhole code |
| File data transit | ❌ Never (under normal WebRTC operation) |

### WebRTC Data Channel

| Property | Value |
|---|---|
| Transport | DTLS-SRTP (WebRTC's mandatory encryption) |
| Channel mode | Reliable, ordered delivery |
| STUN servers | Google's public STUN (`stun.l.google.com:19302`) |
| TURN servers | Not included (avoids relying on 3rd-party media relays) |

**Double encryption**: Data traversing the WebRTC data channel is encrypted twice:
1. **Application layer**: AES-256-GCM encryption by EnvSync before transmission
2. **Transport layer**: DTLS-SRTP encryption by WebRTC itself

### WebSocket Fallback

When WebRTC is unavailable (strict symmetric NAT, missing `wrtc` module):
- Data transits the signaling relay WebSocket
- **All data remains AES-256-GCM encrypted** — the relay only sees ciphertext
- The relay cannot decrypt (it doesn't have the wormhole code)
- This is a tradeoff: loss of P2P directness, but zero loss of confidentiality

---

## Data Integrity

### Transfer Verification

| Level | Mechanism |
|---|---|
| Per-chunk | SHA-256 checksum verified on receipt |
| Full file | SHA-256 checksum verified after reassembly |
| Encryption | GCM auth tag verification (tamper detection) |

If any checksum fails, the transfer is aborted and the user is notified.

### Secure Temp File Handling

- Incoming files are written to `.vscode/envsync-tmp/*.remote`
- Before deletion, temp files are **overwritten with zeros** (best-effort secure delete)
- Temp directory is cleaned up when the extension deactivates

---

## Threat Model

### What this extension protects against

| Threat | Mitigation |
|---|---|
| Network eavesdropping | AES-256-GCM + DTLS-SRTP double encryption |
| Compromised relay server | Relay only sees hashed room IDs and ciphertext |
| Man-in-the-middle | Both peers derive the same key from the shared secret |
| File tampering | GCM auth tag + SHA-256 checksums |
| Brute-force on wormhole code | scrypt KDF makes each guess expensive |
| Accidental file overwrite | Diff review with explicit accept/reject |
| Configuration drift | .env.example sync detection |

### What this extension does NOT protect against

| Limitation | Explanation |
|---|---|
| Compromised endpoint | If a peer's machine is compromised, the attacker has the plaintext |
| Shoulder surfing | The wormhole code is displayed in the VS Code UI |
| Replay attacks | A captured session could theoretically be replayed (mitigated by per-session salt/IV) |
| Denial of service | The relay can be overwhelmed; room IDs can be guessed (but can't be exploited) |
| TURN unavailability | Without a TURN server, strict NAT configurations may prevent P2P |

---

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly by opening a private issue or contacting the maintainers directly. Do not disclose vulnerabilities publicly until a fix is available.
