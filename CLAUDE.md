# Agent Instructions — @h3l1os/mp4vault

## What this is

Node.js library (npm: `@h3l1os/mp4vault`) that hides files inside MP4 video containers and JPEG/PNG images using AES-256-GCM encryption. Supports stealth mode (encrypted structural markers) and deniable dual-layer encryption (inner/outer key slots). Output files remain valid and playable/viewable. Part of the h3l1os ecosystem.

## Quick facts

- **Package:** `@h3l1os/mp4vault` v2.1.0
- **License:** AGPL-3.0
- **Runtime:** Node.js 18+ only (uses `crypto`, `fs`). Does NOT run in browsers.
- **Output:** Dual ESM (`dist/index.js`) + CJS (`dist/index.cjs`) via tsup
- **Dependencies:** `debug` (only runtime dep), `sharp` (optional, for LSB scripts)
- **Tests:** 70 tests, vitest, all passing
- **CI:** GitHub Actions on Node 18/20/22

## Repository layout

```
├── src/
│   ├── index.ts           # Public exports
│   ├── MP4.ts             # MP4 container parser + embed/extract (atom-based)
│   ├── ImageVault.ts      # JPEG/PNG container parser + embed/extract (marker/chunk-based)
│   ├── Atom.ts            # MP4 atom/box read/write
│   ├── AES.ts             # AES-256-GCM, PBKDF2 (600k iterations, SHA-512)
│   ├── Embed.ts           # Embedding coordinator: headers, file list, public/private/inner split
│   ├── EmbedBinary.ts     # Single binary file embed/extract with optional encryption
│   ├── EmbedObject.ts     # JSON object embed/extract (file manifest headers)
│   ├── Stealth.ts         # Stealth mode: AES-256-CTR encryption of structural marker bytes
│   ├── LSB.ts             # LSB pixel-level steganography (for lossless transport)
│   ├── Convert.ts         # hex↔Buffer, JSON↔Buffer, randomByteIn, isByteIn
│   ├── Pack.ts            # Binary pack/unpack using native Buffer methods
│   ├── constants.ts       # BUFFER_SIZE=100000, MAX_HEADER_SIZE=10MB, MAX_INT32
│   ├── types.ts           # IReadable, IWritable, FileRecord, EmbedFileParams (includes inner flag)
│   ├── utils.ts           # tmpFileSync() via fs.mkdtempSync + crypto.randomUUID
│   └── node/
│       ├── Readable.ts    # File reader (fs.open, getSlice with auto-prepare)
│       └── Writable.ts    # File/memory writer (chunked O(n))
├── scripts/
│   ├── vault-batch.mjs    # Batch encrypt/decrypt folders (MP4 + image modes)
│   ├── vault-keygen.mjs   # Generate/derive AES keys from 8-word mnemonics
│   └── lsb-encode.mjs     # LSB pixel-level encode/decode (requires sharp)
├── test/                  # 10 test files, 70 tests total
├── dist/                  # Built output (gitignored)
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

## Architecture

```
User code
    │
    ▼
┌──────────┐     ┌──────────────┐
│   MP4    │     │  ImageVault  │   ← Container parsers (format-specific)
│ (atoms)  │     │ (JPEG/PNG)   │
└────┬─────┘     └──────┬───────┘
     │                  │
     └────────┬─────────┘
              ▼
        ┌───────────┐
        │  Embed.ts │               ← Embedding coordinator (format-agnostic)
        └─────┬─────┘                 Supports: public, encrypted, inner (deniable) layers
        ┌─────┴─────┐
        ▼           ▼
  EmbedBinary   EmbedObject          ← Payload writers (binary files, JSON headers)
        └─────┬─────┘                  Both support stealth mode
              ▼
         ┌─────────┐
         │ AES.ts  │                 ← Crypto layer (AES-256-GCM, PBKDF2)
         └────┬────┘
              ▼
         ┌──────────┐
         │Stealth.ts│               ← Stealth: AES-256-CTR encrypts flag/type/salt/IV bytes
         └──────────┘
```

## Container classes

### MP4 — Video steganography
- Parses MP4 atoms (ftyp, mdat, moov, stco, co64)
- Embeds data at the start of the `mdat` atom payload
- Adjusts sample offsets in `stco`/`co64` so the video stays playable

### ImageVault — Image steganography
- Supports JPEG and PNG (auto-detected from file header)
- JPEG: forward-scans markers, finds EOI (`FF D9`), appends data after it
- PNG: iterates chunks, finds IEND, appends data after it

## Encryption modes

- **AES-256-GCM** with 128-bit auth tag (tamper detection)
- **Key mode:** Raw 16/24/32-byte Buffer via `setKey()`
- **Password mode:** PBKDF2 with 600,000 iterations, SHA-512 via `setPassword()`
- **Per-file:** Each embedded file gets its own salt/IV/authTag
- **Mixed mode:** Same container can have public + private + inner files

## Stealth mode

When enabled via `setStealth(true)`, encrypts the structural marker bytes (flag, type, salt, IV — 30 bytes) at the start of each encrypted chunk using AES-256-CTR. Makes the entire payload indistinguishable from random data. Requires raw key (not password mode).

## Deniable dual-layer encryption

Supports two independent key slots via `setInnerKey()` / `setInnerPassword()`:
- **Outer layer** (decoy): `embedFile({ filename })` — visible with outer key
- **Inner layer** (real): `embedFile({ filename, inner: true })` — invisible without inner key
- Outer key holder sees decoy files + "random padding"
- Inner key holder sees real files
- No mathematical proof the inner layer exists

## Binary format

```
[public header (EmbedObject)] [encrypted header (EmbedObject)] [inner header (EmbedObject, if deniable)]
[public file1] [encrypted file1] [inner file1 (if deniable)] ...
```

Each chunk: `[flag 1B][type 1B][salt? 16B][IV? 12B][payload][authTag? 16B]`
- Stealth mode: first 30 bytes are AES-256-CTR encrypted

## Commands

```bash
npm install          # Install dependencies
npm test             # Run 70 tests (vitest)
npm run typecheck    # tsc --noEmit
npm run build        # tsup → dist/ (ESM + CJS + .d.ts)
```

## Scripts

```bash
# Batch encrypt/decrypt folders
node scripts/vault-batch.mjs encrypt ./photos --cover cover.jpg --password "secret" --output ./vault
node scripts/vault-batch.mjs decrypt ./vault --password "secret" --output ./restored
node scripts/vault-batch.mjs encrypt ./videos --cover cover.mp4 --key HEX --mode video

# Generate/derive AES keys
node scripts/vault-keygen.mjs generate              # Random 8-word mnemonic + key
node scripts/vault-keygen.mjs derive word1 word2 ... word8   # Derive key from mnemonic
node scripts/vault-keygen.mjs random                # Random 32-byte hex key

# LSB pixel-level encoding (requires sharp)
node scripts/lsb-encode.mjs encode photo.png "QmCID..." --output stego.png
node scripts/lsb-encode.mjs decode stego.png
node scripts/lsb-encode.mjs info photo.png
```

## Ecosystem

| Package | Purpose | Repo |
|---------|---------|------|
| **@h3l1os/mp4vault** | Vault container encryption (MP4, JPEG, PNG) | [h3l1os-sol/mp4vault](https://github.com/h3l1os-sol/mp4vault) |
| **@h3l1os/dct-stego** | DCT spread-spectrum JPEG steganography | [h3l1os-sol/dct-stego](https://github.com/h3l1os-sol/dct-stego) |
| **Chrome Extension** | Vault Player (decrypt + play in browser) | [EdwinKestler/Video-Player-Chrome-Extension](https://github.com/EdwinKestler/Video-Player-Chrome-Extension) |
| **h3l1os-next** | Next.js frontend (API routes for embed/extract) | [h3l1os-sol/h3l1os-next](https://github.com/h3l1os-sol/h3l1os-next) |
| **h3l1os-anchor** | Solana program (key relay, not mp4vault directly) | [h3l1os-sol/h3l1os-anchor](https://github.com/h3l1os-sol/h3l1os-anchor) |

## External services

| Service | Usage |
|---------|-------|
| **IPFS / Pinata** | Hosts encrypted vault files. CIDs are embedded in public images via dct-stego |
| **npm registry** | Package distribution: `@h3l1os/mp4vault`, `@h3l1os/dct-stego` |
| **GitHub Actions** | CI on Node 18/20/22 |
| **Solana devnet** | h3l1os-anchor program for key relay (separate from mp4vault) |

## Remotes

- `origin` → `https://github.com/EdwinKestler/mp4vault.git`
- `upstream` → `https://github.com/h3l1os-sol/mp4vault.git`

## Key behaviors to know

- `Readable.getSlice()` auto-calls `prepare()` if the file handle was closed
- `Writable` uses chunked array storage (O(n) total), concatenates once on `saveToFile()`
- `Pack.ts` only supports `>I` (uint32), `>Q` (uint64), and `>Ns` (ASCII string)
- `MP4.getExpectedSize()` has side effects (calls `adjustSampleOffsets`) — do not call more than once
- Stealth mode requires raw key (`setKey()`), not password — chicken-and-egg with salt
- Deniable inner header offset stored as `_reserved` field in outer header JSON
- When only inner key provided, scan approach finds inner header (checks candidate offsets)
- Test fixtures: `test/test.mp4`, `test.txt`, `image.jpg`, `image1.jpg`, `image2.png`, `pdf1.pdf`, `pdf2.pdf`

## Findings and known limitations

### Successes
- AES-256-GCM encryption is unbreakable (2^256 key space, 600k PBKDF2 iterations)
- Stealth mode eliminates all structural markers — payload indistinguishable from random
- Deniable dual-layer works with outer+inner key separation
- ImageVault supports both JPEG and PNG with zero offset adjustment
- Batch scripts handle thousands of files with lazy file loading
- Chrome extension decrypts vault files entirely in-memory (never to disk)

### Known limitations
- Vault data appended after EOI/IEND is stripped by social media re-encoding (use dct-stego instead)
- LSB pixel-level encoding does NOT survive JPEG re-compression
- Progressive JPEG input must be converted to baseline for the Node.js encoder
- Stealth + deniable + inner-key-only is an unsupported edge case (needs both keys)
- `MP4.getExpectedSize()` should not be called more than once per embed operation
- Minimum strength for spread-spectrum DCT that survives Twitter: 4 (strength 3 fails)
