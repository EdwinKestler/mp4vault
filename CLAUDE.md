# Agent Instructions — @h3l1os/mp4vault

## What this is

Node.js library (npm: `@h3l1os/mp4vault`) that hides files inside MP4 video containers and JPEG/PNG images using AES-256-GCM encryption. Output files remain valid and playable/viewable. Part of the h3l1os ecosystem.

## Quick facts

- **Package:** `@h3l1os/mp4vault` v2.1.0
- **License:** AGPL-3.0
- **Runtime:** Node.js 18+ only (uses `crypto`, `fs`). Does NOT run in browsers.
- **Output:** Dual ESM (`dist/index.js`) + CJS (`dist/index.cjs`) via tsup
- **Dependencies:** `debug` (only runtime dep)
- **Tests:** 48 tests, vitest, all passing
- **CI:** GitHub Actions on Node 18/20/22

## Repository layout

```
├── src/
│   ├── index.ts           # Public exports: MP4, ImageVault, AES, Convert, Embed, etc.
│   ├── MP4.ts             # MP4 container parser + embed/extract (atom-based)
│   ├── ImageVault.ts      # JPEG/PNG container parser + embed/extract (marker/chunk-based)
│   ├── Atom.ts            # MP4 atom/box read/write
│   ├── AES.ts             # AES-256-GCM, PBKDF2 (600k iterations, SHA-512)
│   ├── Embed.ts           # Embedding coordinator: headers, file list, public/private split
│   ├── EmbedBinary.ts     # Single binary file embed/extract with optional encryption
│   ├── EmbedObject.ts     # JSON object embed/extract (used for file manifest headers)
│   ├── Convert.ts         # hex↔Buffer, JSON↔Buffer, randomByteIn, isByteIn
│   ├── Pack.ts            # Binary pack/unpack using native Buffer methods (uint32, uint64, ASCII)
│   ├── constants.ts       # BUFFER_SIZE=100000, MAX_HEADER_SIZE=10MB, MAX_INT32
│   ├── types.ts           # IReadable, IWritable, FileRecord, AtomParams, EmbedFileParams
│   ├── utils.ts           # tmpFileSync() via fs.mkdtempSync + crypto.randomUUID
│   └── node/
│       ├── Readable.ts    # File reader (fs.open, getSlice with auto-prepare)
│       └── Writable.ts    # File/memory writer (chunked O(n), not O(n²))
├── test/                  # 8 test files, 48 tests total
├── dist/                  # Built output (gitignored but included in npm package)
├── package.json           # @h3l1os/mp4vault v2.1.0
├── tsconfig.json          # ES2020, strict, bundler resolution
├── tsup.config.ts         # ESM+CJS, dts, node18 target
└── vitest.config.ts       # 30s timeout
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
        └─────┬─────┘
        ┌─────┴─────┐
        ▼           ▼
  EmbedBinary   EmbedObject          ← Payload writers (binary files, JSON headers)
        └─────┬─────┘
              ▼
         ┌─────────┐
         │ AES.ts  │                 ← Crypto layer (AES-256-GCM, PBKDF2)
         └─────────┘
```

**Key pattern:** `MP4` and `ImageVault` are thin wrappers around the shared `Embed` layer. They differ only in how they parse/write the container format. The crypto, embedding, and I/O layers are fully shared.

## Two container classes

### MP4 — Video steganography
- Parses MP4 atoms (ftyp, mdat, moov, stco, co64)
- Embeds data at the start of the `mdat` atom payload
- Adjusts sample offsets in `stco`/`co64` so the video stays playable
- Complex: must rewrite atom headers and offset tables

### ImageVault — Image steganography
- Supports JPEG and PNG (auto-detected from file header)
- JPEG: forward-scans markers, finds EOI (`FF D9`), appends data after it
- PNG: iterates chunks, finds IEND, appends data after it
- Simple: no offset adjustment needed, just append

## Encryption

- **AES-256-GCM** with 128-bit auth tag (tamper detection)
- **Key mode:** Raw 16/24/32-byte Buffer
- **Password mode:** PBKDF2 with 600,000 iterations, SHA-512, 16-byte random salt
- **IV:** 12 bytes, random per operation via `crypto.randomBytes()`
- **Per-file:** Each embedded file gets its own salt/IV/authTag
- **Mixed mode:** Same container can have public (unencrypted) + private (encrypted) files

## Binary format (inside containers)

```
[public header (EmbedObject)] [encrypted header (EmbedObject)] [file1 (EmbedBinary)] [file2] ...
```

Each chunk: `[flag 1B][type 1B][salt? 16B][IV? 12B][payload][authTag? 16B]`
- Flag byte: even = unencrypted, odd = encrypted (modulo 2)
- Type byte: encodes chunk type via modulo 11

## Commands

```bash
npm install          # Install dependencies
npm test             # Run 48 tests (vitest)
npm run typecheck    # tsc --noEmit (strict mode)
npm run build        # tsup → dist/ (ESM + CJS + .d.ts)
npm run test:watch   # vitest watch mode
```

## Ecosystem context

This package is used by:
- **h3l1os-next** (Next.js frontend) — server-side API routes `/api/vault/embed` and `/api/vault/extract` use `MP4` class. `ImageVault` routes planned.
- **h3l1os-anchor** (Solana program) — does NOT use this package directly. It manages encryption key relay on-chain.

The h3l1os platform flow:
1. Creator uploads video → mp4vault embeds private content in public MP4 → uploads to IPFS
2. AES key is NaCl-encrypted and stored on Solana
3. Buyer purchases access → backend relays key → buyer decrypts via mp4vault

## Remotes

- `origin` → `https://github.com/EdwinKestler/mp4vault.git` (personal)
- `upstream` → `https://github.com/h3l1os-sol/mp4vault.git` (org)

## Things to know

- `Readable.getSlice()` auto-calls `prepare()` if the file handle was closed — this is intentional and relied upon by both MP4 and ImageVault
- `Writable` uses chunked array storage (O(n) total), concatenates once on `saveToFile()`/`toReadable()`
- `Pack.ts` only supports `>I` (uint32), `>Q` (uint64), and `>Ns` (ASCII string) — all big-endian. No other format tokens are used in the codebase
- The `Embed` class calls `composeHeader()` in both `getExpectedSize()` and `writeTo()` — this is redundant but harmless
- `MP4.getExpectedSize()` has side effects (calls `adjustSampleOffsets`) — do not call it more than once per embed operation
- Test fixtures live in `test/`: `test.mp4`, `test.txt`, `image.jpg`, `image1.jpg`, `image2.png`, `pdf1.pdf`, `pdf2.pdf`
