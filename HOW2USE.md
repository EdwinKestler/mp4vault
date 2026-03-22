# HOW2USE: @h3l1os/mp4vault

**Audience:** AI agents working on the h3l1os ecosystem (h3l1os-next frontend or h3l1os-anchor Solana program).

**What it does:** Hides files inside MP4 video containers with AES-256-GCM encryption. The output MP4 remains a valid, playable video — the embedded data is invisible to media players.

**Where it runs:** Node.js only (server-side). It uses Node.js `crypto` module. It does NOT run in the browser. All frontend usage goes through Next.js API routes.

---

## TABLE OF CONTENTS

1. [Architecture Overview](#1-architecture-overview)
2. [The Two Encryption Modes](#2-the-two-encryption-modes)
3. [Using mp4vault in h3l1os-next (Frontend)](#3-using-mp4vault-in-h3l1os-next-frontend)
4. [Using mp4vault Directly (Server-Side / Scripts)](#4-using-mp4vault-directly-server-side--scripts)
5. [API Route Reference](#5-api-route-reference)
6. [Client Helper Reference](#6-client-helper-reference)
7. [How It Connects to Solana (h3l1os-anchor)](#7-how-it-connects-to-solana-h3l1os-anchor)
8. [End-to-End Flow: Creator Uploads Video](#8-end-to-end-flow-creator-uploads-video)
9. [End-to-End Flow: Buyer Watches Video](#9-end-to-end-flow-buyer-watches-video)
10. [Key Files Map](#10-key-files-map)
11. [Common Mistakes](#11-common-mistakes)
12. [Encoding Format](#12-encoding-format)

---

## 1. ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER (h3l1os-next client)                                   │
│                                                                 │
│  UserContainer.ts ──► vaultEmbed() ──► POST /api/vault/embed    │
│  UploadedContainer.ts ► vaultExtract() ► POST /api/vault/extract│
│  Viewer.ts ──► UploadedContainer.decode() ──► (same as above)   │
│                                                                 │
│  Key generation: window.crypto.getRandomValues(new Uint8Array(32))
│  Key format in transport: hex string (64 chars for 32 bytes)    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ FormData (multipart/form-data)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  SERVER (Next.js API routes, Node.js runtime)                   │
│                                                                 │
│  /api/vault/embed   ──► @h3l1os/mp4vault (MP4 + AES-256-GCM)   │
│  /api/vault/extract ──► @h3l1os/mp4vault (decrypt + extract)    │
│                                                                 │
│  Temp files: written to os.tmpdir(), cleaned up in finally {}   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  SOLANA (h3l1os-anchor program)                                 │
│                                                                 │
│  MediaAccount.token_key = NaCl box-encrypted AES key            │
│  PurchaseAccount = buyer asks for key, backend fills it         │
│  /api/fill = key relay (decrypt creator key, re-encrypt for     │
│              buyer using NaCl box)                               │
│                                                                 │
│  NOTE: The Solana program does NOT embed/extract files.          │
│  It only stores and relays the encryption KEY.                   │
└─────────────────────────────────────────────────────────────────┘
```

**Critical distinction:** mp4vault handles FILE embedding/extraction. The Solana program handles KEY management (storing, purchasing, relaying encryption keys). They are separate concerns connected by the AES key.

---

## 2. THE TWO ENCRYPTION MODES

mp4vault supports two mutually exclusive encryption modes. Pick one per operation.

### Mode A: Raw Key (Uint8Array)

```typescript
// 32 bytes = AES-256, 24 bytes = AES-192, 16 bytes = AES-128
const key = crypto.getRandomValues(new Uint8Array(32));

// Server-side
const mp4 = new MP4();
mp4.setKey(Buffer.from(key));

// Client-side (via API)
await vaultEmbed({ video, file, key });
await vaultExtract({ video, key });
```

The key is transmitted to the API as a **hex string** (e.g., `"a1b2c3..."`, 64 chars for 32 bytes). The API route converts it back with `Convert.hexStringToBuffer()`.

**This is the mode used by the h3l1os platform.** The 32-byte AES key is the "video key" that gets NaCl-encrypted and stored on Solana.

### Mode B: Password (string)

```typescript
// Server-side
const mp4 = new MP4();
mp4.setPassword("my-secret-password");

// Client-side (via API)
await vaultEmbed({ video, file, password: "my-secret-password" });
await vaultExtract({ video, password: "my-secret-password" });
```

The password is run through PBKDF2 (600,000 iterations, SHA-512) to derive a 32-byte key. A random 16-byte salt is generated per encryption and stored in the embedded data.

**Use this for standalone tools, CLI wrappers, or user-facing password prompts.** Not used in the Solana flow.

### No encryption

Omit both `key` and `password`. The file is embedded in plaintext (still hidden inside the MP4 structure, but not encrypted).

---

## 3. USING MP4VAULT IN H3L1OS-NEXT (FRONTEND)

**Rule: Never import `@h3l1os/mp4vault` in client-side code.** It only works in Node.js. All browser-side code uses the client helper functions which call the API routes.

### 3.1 Installation

```bash
npm install @h3l1os/mp4vault
```

The package is used only by the API routes (server-side). Add to `next.config.ts`:

```typescript
const nextConfig: NextConfig = {
  serverExternalPackages: ["@h3l1os/mp4vault"],
  // ... rest of config
};
```

This tells Next.js/Turbopack not to bundle it — it runs natively in Node.js.

### 3.2 Client-side: Embed a file

```typescript
import { vaultEmbed } from "@/lib/vault";

// key is a Uint8Array (32 bytes), typically from crypto.getRandomValues()
const encodedBlob: Blob = await vaultEmbed({
  video: containerVideoFile,    // File | Blob — the MP4 container
  file: privateVideoFile,       // File | Blob — the file to hide
  key: encryptionKey,           // Uint8Array — 32-byte AES key
  meta: { id: "abc123" },       // optional JSON metadata
});

// encodedBlob is the resulting MP4 with embedded data
// Save to IndexedDB, upload to IPFS, etc.
```

### 3.3 Client-side: List embedded files

```typescript
import { vaultList } from "@/lib/vault";

const files = await vaultList({
  video: mp4Blob,     // File | Blob — MP4 with embedded data
  key: decryptionKey,  // Uint8Array — same key used during embed
});

// files = [{ filename: "video.mp4", size: 12345, isEncrypted: true }, ...]
```

### 3.4 Client-side: Extract a file

```typescript
import { vaultExtract } from "@/lib/vault";

const extractedBlob: Blob = await vaultExtract({
  video: mp4Blob,      // File | Blob
  key: decryptionKey,   // Uint8Array
  index: 0,             // which file to extract (default 0)
});

// extractedBlob is the decrypted file content
const blobUrl = URL.createObjectURL(extractedBlob);
```

### 3.5 Error handling

```typescript
try {
  const blob = await vaultExtract({ video, key: wrongKey });
} catch (e) {
  if (e.message === "Wrong decryption key") {
    // HTTP 403 from API — key doesn't match
  }
  // Other errors: network, server, malformed MP4, etc.
}
```

### 3.6 Where the client helpers are used in the codebase

| Class | Method | What it does |
|-------|--------|-------------|
| `UserContainer` | `makeEncoded()` | Calls `vaultEmbed()` — hides private video inside public MP4 |
| `UploadedContainer` | `decode(key)` | Calls `vaultList()` then `vaultExtract()` — extracts hidden video |
| `Viewer` | `getDecodedVideoURL(key)` | Fetches MP4 from IPFS, creates `UploadedContainer`, calls `decode()` |

---

## 4. USING MP4VAULT DIRECTLY (SERVER-SIDE / SCRIPTS)

If you are writing server-side code (API routes, scripts, tests), you can use the library directly.

### 4.1 Embed

```typescript
import { MP4, Writable, Convert } from "@h3l1os/mp4vault";

const mp4 = new MP4();
mp4.setKey(Convert.hexStringToBuffer("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"));

await mp4.loadFile({ filename: "/path/to/container.mp4" });
await mp4.embedFile({ filename: "/path/to/secret.mp4" });

const writable = new Writable({ filename: "/path/to/output.mp4" });
await mp4.embed(writable);
```

### 4.2 Extract

```typescript
import { MP4, Writable, Convert } from "@h3l1os/mp4vault";

const mp4 = new MP4();
mp4.setKey(Convert.hexStringToBuffer("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"));

await mp4.loadFile({ filename: "/path/to/output.mp4" });

// List what's embedded
const files = mp4.getEmbedFiles();
// [{ filename: "secret.mp4", size: 12345, isEncrypted: true, offset: 0 }]

// Extract file at index 0
const writable = new Writable({ filename: "/path/to/restored.mp4" });
await mp4.extractFile(0, writable);
```

### 4.3 In-memory (no filenames)

```typescript
const mp4 = new MP4();
mp4.setKey(key);
await mp4.loadFile({ filename: inputPath });
await mp4.embedFile({ filename: secretPath });

// Write to in-memory writable (no filename = in-memory buffer)
const writable = new Writable();
await mp4.embed(writable);

// Save the in-memory buffer to disk later
await writable.saveToFile("/path/to/output.mp4");

// Or convert to a Readable for re-processing
const readable = await writable.toReadable();
```

### 4.4 Embed with metadata

```typescript
await mp4.embedFile({
  filename: "/path/to/secret.mp4",
  meta: {
    id: "unique-id-123",
    author: "alice",
    tags: ["premium", "tutorial"],
  },
});
```

Metadata is stored in the embedded header (encrypted along with the file list). It is returned by `getEmbedFiles()` and `vaultList()`.

### 4.5 Mix public and encrypted files

```typescript
const mp4 = new MP4();
mp4.setKey(key);
await mp4.loadFile({ filename: containerPath });

// This file will NOT be encrypted (key: null opts out)
await mp4.embedFile({ filename: previewPath, key: null });

// This file WILL be encrypted (uses the key set on the MP4 instance)
await mp4.embedFile({ filename: premiumPath });

const writable = new Writable({ filename: outputPath });
await mp4.embed(writable);
```

### 4.6 API surface

| Class | Method | Signature | Description |
|-------|--------|-----------|-------------|
| `MP4` | `setKey` | `(key: Buffer): void` | Set AES key (16/24/32 bytes) |
| `MP4` | `setPassword` | `(password: string): void` | Set password (PBKDF2 derived) |
| `MP4` | `loadFile` | `({ filename }): Promise<void>` | Parse an MP4 file from disk |
| `MP4` | `embedFile` | `({ filename, meta?, key?, password? }): Promise<void>` | Add a file to embed. `key: null` or `password: null` to skip encryption for this file |
| `MP4` | `embed` | `(writable?): Promise<IWritable>` | Write embedded MP4. Returns writable |
| `MP4` | `getEmbedFiles` | `(): FileRecord[]` | List embedded files in a loaded MP4 |
| `MP4` | `extractFile` | `(index, writable?): Promise<IWritable>` | Extract embedded file by index |
| `MP4` | `getExpectedSize` | `(): Promise<number>` | Get expected output size before writing |
| `Writable` | constructor | `({ filename? })` | With filename: writes to disk. Without: in-memory |
| `Writable` | `saveToFile` | `(filename): Promise<void>` | Save in-memory buffer to disk |
| `Writable` | `toReadable` | `(): Promise<IReadable>` | Convert to readable for re-processing |
| `Writable` | `size` | `(): number` | Bytes written so far |
| `Convert` | `hexStringToBuffer` | `(hex: string): Buffer` | Hex string to Buffer (validates input) |

---

## 5. API ROUTE REFERENCE

### POST /api/vault/embed

**Location:** `src/app/api/vault/embed/route.ts`

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `video` | File | Yes | The MP4 container video |
| `file` | File | Yes | The file to embed inside the MP4 |
| `key` | string | No | Hex-encoded AES key (64 chars = 32 bytes) |
| `password` | string | No | Password for PBKDF2 key derivation |
| `meta` | string | No | JSON string of metadata to attach |

**Success response:** `200` — raw bytes of the embedded MP4 (`application/octet-stream`)

**Error responses:**
- `400` — missing fields or invalid meta JSON
- `413` — payload too large (>200MB)
- `500` — embed failed (bad MP4 format, etc.)

**Internal flow:**
1. Writes uploaded files to `os.tmpdir()` (mp4vault needs file paths)
2. Creates `MP4` instance, sets key/password, loads video
3. Embeds file with optional metadata
4. Writes output to temp file, reads it back, returns as response
5. Cleans up all temp files in `finally` block

### POST /api/vault/extract

**Location:** `src/app/api/vault/extract/route.ts`

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `video` | File | Yes | The MP4 container with embedded data |
| `key` | string | No | Hex-encoded AES decryption key |
| `password` | string | No | Password for PBKDF2 key derivation |
| `index` | string | No | `"list"` to list files, or `"0"`, `"1"`, etc. to extract. Default: `"0"` |

**List mode** (`index: "list"`):
```json
{
  "success": true,
  "files": [
    { "filename": "secret.mp4", "size": 12345, "isEncrypted": true },
    { "filename": "preview.mp4", "size": 5000, "isEncrypted": false }
  ]
}
```

**Extract mode** (`index: "0"`):
- `200` — raw bytes of the extracted file (`application/octet-stream`)
- Response headers include `X-Vault-Filename` and `X-Vault-Encrypted`

**Error responses:**
- `400` — missing video or invalid index
- `403` — wrong decryption key (auth tag mismatch)
- `404` — file index out of range
- `413` — payload too large
- `500` — internal error

---

## 6. CLIENT HELPER REFERENCE

**Location:** `src/lib/vault.ts`

All functions are async. All accept `File | Blob` for the video. Keys are `Uint8Array` (converted to hex internally for transport).

```typescript
// Embed: returns the resulting MP4 as Blob
async function vaultEmbed(params: {
  video: File | Blob;
  file: File | Blob;
  key?: Uint8Array;
  password?: string;
  meta?: Record<string, unknown>;
}): Promise<Blob>

// List: returns array of embedded file records
async function vaultList(params: {
  video: File | Blob;
  key?: Uint8Array;
  password?: string;
}): Promise<FileRecord[]>

// Extract: returns the extracted file as Blob
async function vaultExtract(params: {
  video: File | Blob;
  key?: Uint8Array;
  password?: string;
  index?: number;
}): Promise<Blob>
```

**Utility functions** (in `src/lib/utils/encoding.ts`):
```typescript
function hex2u8a(hexString: string): Uint8Array  // "a1b2c3" → Uint8Array
function u8a2hex(a: Uint8Array): string           // Uint8Array → "a1b2c3"
```

---

## 7. HOW IT CONNECTS TO SOLANA (H3L1OS-ANCHOR)

The Solana program manages **access control** — who can decrypt a video. mp4vault manages the **actual embedding/encryption**. Here is how they connect:

### The key lifecycle

```
CREATOR SIDE:
1. Browser generates random 32-byte AES key
2. mp4vault encrypts private video with this key (via /api/vault/embed)
3. Encoded MP4 uploaded to IPFS
4. AES key is NaCl-box-encrypted with backend's X25519 public key
5. Encrypted key stored on-chain in MediaAccount.token_key
6. Creator mints NFT pointing to the IPFS content

BUYER SIDE:
1. Buyer purchases access → creates PurchaseAccount on-chain
2. Buyer calls "askForKey" → stores their X25519 public key on-chain
3. Backend (/api/fill) reads on-chain data:
   - Decrypts AES key from MediaAccount.token_key using NaCl box
   - Re-encrypts AES key for buyer using buyer's X25519 public key
   - Sends "fillKey" transaction to store buyer's encrypted key on-chain
4. Buyer reads their encrypted key from PurchaseAccount
5. Buyer decrypts the AES key using their NaCl secret key
6. Buyer sends AES key to /api/vault/extract → gets decrypted video
```

### On-chain encrypted key format

```
MediaAccount.token_key (Vec<u8>):
  [creatorNaclPubkey (32 bytes)] [nonce (24 bytes)] [ciphertext (...)]

PurchaseAccount.buyer_key (Vec<u8>) — after fillKey:
  [backendNaclPubkey (32 bytes)] [nonce (24 bytes)] [ciphertext (...)]
```

Both use NaCl `box` (X25519 + XSalsa20-Poly1305). The ciphertext contains the raw 32-byte AES key.

### Important: Two separate crypto systems

| Layer | Algorithm | Purpose | Library |
|-------|-----------|---------|---------|
| File encryption | AES-256-GCM | Encrypt the actual video content | `@h3l1os/mp4vault` (Node `crypto`) |
| Key transport | NaCl box (X25519) | Encrypt/relay the AES key on-chain | `tweetnacl` |

Do NOT confuse them. mp4vault never touches NaCl. The Solana program never touches AES.

---

## 8. END-TO-END FLOW: CREATOR UPLOADS VIDEO

This is the sequence when a creator uploads content on h3l1os-next:

```
Step 1: User selects two videos in the browser
        - Public video (the "container" — plays as preview)
        - Private video (the content to hide)

Step 2: Browser generates 32-byte AES key
        const key = crypto.getRandomValues(new Uint8Array(32));

Step 3: UserContainer.makeEncoded() calls vaultEmbed()
        → POST /api/vault/embed
        → Server uses mp4vault to embed private video inside public MP4
        → Returns encoded Blob
        → Stored in IndexedDB

Step 4: UserContainer.uploadToIPFS()
        → Uploads encoded MP4 to IPFS via /api/pinata
        → Uploads public thumbnail to IPFS
        → Generates NFT metadata JSON, uploads to IPFS

Step 5: UserContainer.mintOn(wallet)
        → Calls Solana program's "create_media" instruction
        → Stores NaCl-encrypted AES key in MediaAccount.token_key
        → Mints NFT with IPFS metadata URI
```

### Key class: UserContainer

```
UserContainer {
  containerUserFile   ← public video (the MP4 container)
  privateUserFile     ← private video (gets embedded)
  _password           ← 32-byte AES key (Uint8Array)
  encodedBlob         ← resulting MP4 after embedding

  compose(key, privateFile) → sets up the container
  makeEncoded()             → calls vaultEmbed(), sets encodedBlob
  uploadToIPFS()            → uploads to IPFS
  mintOn(wallet)            → mints on Solana
  getKeyAsHex()             → returns key as hex string
}
```

---

## 9. END-TO-END FLOW: BUYER WATCHES VIDEO

```
Step 1: Buyer purchases access
        → Calls "purchase" instruction on Solana program
        → Creates PurchaseAccount (isPending = true)

Step 2: Buyer asks for key
        → Calls "ask_for_key" instruction
        → Stores buyer's X25519 public key in PurchaseAccount.buyer_pubkey

Step 3: Backend fills key
        → POST /api/fill
        → Reads MediaAccount.token_key (NaCl-encrypted AES key)
        → Decrypts using backend NaCl secret key
        → Re-encrypts for buyer using buyer's NaCl public key
        → Sends "fill_key" instruction → PurchaseAccount.buyer_key filled

Step 4: Buyer decrypts the AES key
        → Reads PurchaseAccount.buyer_key from chain
        → NaCl box.open() with buyer's secret key → 32-byte AES key

Step 5: Viewer.getDecodedVideoURL(aesKey)
        → Fetches encoded MP4 from IPFS gateway
        → Creates UploadedContainer, calls decode(aesKey)
          → vaultList() → gets file list
          → vaultExtract() → gets decrypted video Blob
        → Creates blob URL for video playback
```

### Key class: UploadedContainer

```
UploadedContainer {
  containerUserFile   ← the encoded MP4 (from IPFS)
  _key                ← AES decryption key (Uint8Array)
  _decodedBlob        ← extracted video (after decode)

  decode(key)  → calls vaultList() then vaultExtract()
  decodedBlob  → getter, returns the decrypted Blob
}
```

### Key class: Viewer

```
Viewer {
  loadInfoByHash(hash)       → fetches NFT metadata from IPFS
  getVideoURL()              → returns IPFS URL of encoded MP4
  getDecodedVideoURL(key)    → fetches MP4, decodes, returns blob URL
}
```

---

## 10. KEY FILES MAP

### mp4vault package (`@h3l1os/mp4vault`)

| File | What it does |
|------|-------------|
| `src/MP4.ts` | Core: parse MP4, embed files, extract files, adjust offsets |
| `src/AES.ts` | AES-256-GCM encrypt/decrypt using Node.js `crypto` |
| `src/Embed.ts` | Coordinates embedding: headers, file list, write sequence |
| `src/EmbedBinary.ts` | Embeds/extracts a single binary file (with optional encryption) |
| `src/EmbedObject.ts` | Embeds/extracts a JSON object (used for file list headers) |
| `src/Atom.ts` | MP4 atom/box parsing and writing |
| `src/Convert.ts` | Hex↔Buffer, JSON↔Buffer, random byte generation |
| `src/Pack.ts` | Binary struct pack/unpack (big-endian integers) |
| `src/node/Readable.ts` | File reader (uses `fs/promises`) |
| `src/node/Writable.ts` | File writer (disk or in-memory buffer) |
| `src/types.ts` | Interfaces: IReadable, IWritable, FileRecord, EmbedFileParams |

### h3l1os-next frontend

| File | What it does |
|------|-------------|
| `src/app/api/vault/embed/route.ts` | API: embed file into MP4 |
| `src/app/api/vault/extract/route.ts` | API: list or extract files from MP4 |
| `src/lib/vault.ts` | Client helper: vaultEmbed, vaultExtract, vaultList |
| `src/lib/classes/UserContainer.ts` | Creator flow: compose → embed → IPFS → mint |
| `src/lib/classes/UploadedContainer.ts` | Consumer flow: load MP4 → decode with key |
| `src/lib/classes/Viewer.ts` | Playback: fetch from IPFS → decode → blob URL |
| `src/app/api/fill/route.ts` | Key relay: decrypt creator key, re-encrypt for buyer |
| `src/lib/utils/encoding.ts` | hex2u8a, u8a2hex utility functions |

---

## 11. COMMON MISTAKES

### Mistake: Importing mp4vault in client-side code

```typescript
// WRONG — this will fail in the browser
"use client";
import { MP4 } from "@h3l1os/mp4vault";
```

```typescript
// CORRECT — use the client helper
"use client";
import { vaultEmbed } from "@/lib/vault";
```

### Mistake: Passing Uint8Array directly to the API

```typescript
// WRONG — FormData can't transport binary keys directly
form.append("key", myUint8Array);
```

```typescript
// CORRECT — the vault helper converts to hex automatically
await vaultEmbed({ video, file, key: myUint8Array });
// Internally: form.append("key", u8a2hex(myUint8Array))
```

### Mistake: Confusing NaCl keys with AES keys

```typescript
// WRONG — this is the NaCl X25519 key, not the AES video key
const key = purchaseAccount.buyerPubkey;
await vaultExtract({ video, key });

// CORRECT — decrypt the NaCl box first to get the AES key
const aesKey = nacl.box.open(ciphertext, nonce, serverPubkey, mySecretKey);
await vaultExtract({ video, key: aesKey });
```

### Mistake: Using setKey and setPassword together

```typescript
// WRONG — setPassword clears the key, and vice versa
mp4.setKey(key);
mp4.setPassword("password"); // key is now null!
```

They are mutually exclusive. Use one or the other.

### Mistake: Forgetting serverExternalPackages

Without this config, Next.js/Turbopack will try to bundle mp4vault and fail on Node.js `crypto`, `fs`, `tmp` imports:

```typescript
// next.config.ts — REQUIRED
const nextConfig: NextConfig = {
  serverExternalPackages: ["@h3l1os/mp4vault"],
};
```

### Mistake: Not handling file size limits

The API routes enforce a 200MB limit. If deploying to Vercel serverless, the default body limit is 4.5MB. Either:
- Use Vercel Pro (allows up to 100MB)
- Deploy to a custom server (no limit)
- Chunk large files client-side before sending

---

## 12. ENCODING FORMAT

How data is physically laid out inside the MP4:

```
┌────────────────────────────────────────────────────┐
│ ftyp atom (original — file type declaration)       │
├────────────────────────────────────────────────────┤
│ free atom (8 bytes — padding)                      │
├────────────────────────────────────────────────────┤
│ mdat atom (media data — size increased)            │
│ ┌────────────────────────────────────────────────┐ │
│ │ PUBLIC HEADER (EmbedObject, unencrypted)        │ │
│ │   flag byte, type byte, JSON file list          │ │
│ ├────────────────────────────────────────────────┤ │
│ │ ENCRYPTED HEADER (EmbedObject, AES-GCM)        │ │
│ │   flag, type, salt(16), IV(12), ciphertext,    │ │
│ │   authTag(16) — contains encrypted file list    │ │
│ ├────────────────────────────────────────────────┤ │
│ │ PUBLIC FILES (EmbedBinary, unencrypted)         │ │
│ │   flag, type, raw file bytes                    │ │
│ ├────────────────────────────────────────────────┤ │
│ │ ENCRYPTED FILES (EmbedBinary, AES-GCM)         │ │
│ │   flag, type, salt(16), IV(12), ciphertext,    │ │
│ │   authTag(16)                                   │ │
│ ├────────────────────────────────────────────────┤ │
│ │ ORIGINAL MDAT PAYLOAD (video/audio samples)    │ │
│ └────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────┤
│ moov atom (metadata — sample offsets adjusted)     │
└────────────────────────────────────────────────────┘
```

**Per-chunk format:**

- Unencrypted: `[flag 1B] [type 1B] [payload]`
- Encrypted: `[flag 1B] [type 1B] [salt 16B] [IV 12B] [ciphertext] [authTag 16B]`

The `flag` byte encodes encrypted (odd) vs unencrypted (even) via modulo 2.
The `type` byte encodes the chunk type (binary=1) via modulo 11.

Sample offsets in `stco`/`co64` atoms inside `moov` are shifted by the size of the embedded data so the video player can still find the original audio/video samples.
