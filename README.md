# @h3l1os/mp4vault

Hide and extract files within MP4, JPEG, and PNG containers with optional AES-256-GCM encryption.

## Features

- Embed any file (text, images, binaries) inside MP4, JPEG, or PNG containers
- AES-256-GCM authenticated encryption with key or password
- Mix public and encrypted files in the same container
- Attach metadata to embedded files
- Preserves container validity — output files remain playable videos / viewable images
- Dual ESM/CJS output
- Node.js 18+

## Install

```bash
npm install @h3l1os/mp4vault
```

## Usage

### MP4: Embed a file with key encryption

```typescript
import { MP4, Convert, Writable } from '@h3l1os/mp4vault';

const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

const mp4 = new MP4();
mp4.setKey(key);
await mp4.loadFile({ filename: 'video.mp4' });

await mp4.embedFile({ filename: 'secret.pdf' });

const writable = new Writable({ filename: 'output.mp4' });
await mp4.embed(writable);
```

### MP4: Embed with password encryption

```typescript
const mp4 = new MP4();
mp4.setPassword('my-secret-password');
await mp4.loadFile({ filename: 'video.mp4' });

await mp4.embedFile({ filename: 'secret.pdf' });

const writable = new Writable({ filename: 'output.mp4' });
await mp4.embed(writable);
```

### Image: Embed a file inside a JPEG

```typescript
import { ImageVault, Writable } from '@h3l1os/mp4vault';

const img = new ImageVault();
img.setPassword('my-secret');
await img.loadFile({ filename: 'photo.jpg' });

await img.embedFile({ filename: 'secret.pdf' });

const writable = new Writable({ filename: 'output.jpg' });
await img.embed(writable);
```

### Image: Embed inside a PNG

```typescript
const img = new ImageVault();
img.setKey(key);
await img.loadFile({ filename: 'image.png' });

await img.embedFile({ filename: 'document.txt' });

const writable = new Writable({ filename: 'output.png' });
await img.embed(writable);
```

### Embed without encryption

```typescript
const mp4 = new MP4();
await mp4.loadFile({ filename: 'video.mp4' });
await mp4.embedFile({ filename: 'document.txt' });
const writable = new Writable({ filename: 'output.mp4' });
await mp4.embed(writable);
```

### Mix public and encrypted files

```typescript
const mp4 = new MP4();
mp4.setKey(key);
await mp4.loadFile({ filename: 'video.mp4' });

// Public file (opt out of encryption with password: null)
await mp4.embedFile({ filename: 'readme.txt', password: null });

// Encrypted file (uses the key set on the MP4 instance)
await mp4.embedFile({ filename: 'secret.pdf' });

const writable = new Writable({ filename: 'output.mp4' });
await mp4.embed(writable);
```

### Embed with metadata

```typescript
await mp4.embedFile({
  filename: 'photo.jpg',
  meta: { author: 'alice', tags: ['vacation', '2026'] },
});
```

### Extract files

```typescript
import { MP4, Convert, Writable } from '@h3l1os/mp4vault';

const key = Convert.hexStringToBuffer('000102030405060708090a0b0c0d0e0f');

const mp4 = new MP4();
mp4.setKey(key);
await mp4.loadFile({ filename: 'output.mp4' });

// List embedded files
const files = mp4.getEmbedFiles();
console.log(files);
// [{ filename: 'secret.pdf', size: 12345, isEncrypted: true, offset: 0 }]

// Extract by index
const extracted = await mp4.extractFile(0);
await (extracted as Writable).saveToFile('restored-secret.pdf');
```

### Get expected output size

```typescript
const mp4 = new MP4();
mp4.setKey(key);
await mp4.loadFile({ filename: 'video.mp4' });
await mp4.embedFile({ filename: 'secret.pdf' });

const expectedBytes = await mp4.getExpectedSize();
```

## API

### `MP4` — Video container steganography

| Method | Description |
|--------|-------------|
| `setKey(key: Buffer)` | Set AES encryption key (16, 24, or 32 bytes) |
| `setPassword(password: string)` | Set password for PBKDF2 key derivation |
| `loadFile({ filename })` | Parse an MP4 file |
| `embedFile({ filename, meta?, key?, password? })` | Add a file to embed. Pass `password: null` or `key: null` to opt out of encryption for this file |
| `embed(writable?)` | Write the MP4 with embedded data |
| `getExpectedSize()` | Get the expected output size in bytes |
| `getEmbedFiles()` | List files embedded in the loaded MP4 |
| `extractFile(index, writable?)` | Extract an embedded file by index |
| `findAtom(name)` | Find a top-level atom by name |
| `findAtoms(atoms, name)` | Recursively find atoms by name |

### `ImageVault` — JPEG/PNG image steganography

Same API as `MP4`. Supports JPEG and PNG (auto-detected from file header).

| Method | Description |
|--------|-------------|
| `setKey(key: Buffer)` | Set AES encryption key (16, 24, or 32 bytes) |
| `setPassword(password: string)` | Set password for PBKDF2 key derivation |
| `loadFile({ filename })` | Parse a JPEG or PNG file |
| `embedFile({ filename, meta?, key?, password? })` | Add a file to embed |
| `embed(writable?)` | Write the image with embedded data |
| `getExpectedSize()` | Get the expected output size in bytes |
| `getEmbedFiles()` | List files embedded in the loaded image |
| `extractFile(index, writable?)` | Extract an embedded file by index |

### `Convert`

| Method | Description |
|--------|-------------|
| `hexStringToBuffer(hex)` | Convert a hex string to a Buffer (validates input) |
| `objectToBuffer(obj)` | Serialize an object to a Buffer (JSON) |
| `bufferToObject(buf)` | Deserialize a Buffer to an object |

### `Writable`

| Method | Description |
|--------|-------------|
| `new Writable({ filename? })` | Create a writable (file or in-memory) |
| `saveToFile(filename)` | Save in-memory contents to a file |
| `toReadable()` | Convert to a Readable for re-processing |
| `size()` | Get bytes written |

## Security

- **AES-256-GCM** authenticated encryption (detects tampering)
- **PBKDF2** key derivation with 600,000 iterations and SHA-512 for password-based encryption
- Random 12-byte IV and 16-byte salt per encryption operation via `crypto.randomBytes()`
- Uses Node.js native `crypto` module — no third-party crypto dependencies

## How it works

### MP4

Embedded data is placed at the start of the `mdat` atom payload. Sample offsets in `stco`/`co64` atoms are adjusted so the video remains playable.

```
[ftyp][free][mdat: [public header][encrypted header][files...][original video data]][moov (offsets adjusted)]
```

### JPEG

Data is appended after the EOI marker (`FF D9`). All JPEG decoders stop at EOI, so the appended data is invisible to image viewers.

### PNG

Data is appended after the IEND chunk. All PNG decoders stop after IEND.

### Per-chunk binary format

- **Unencrypted**: `[flag 1B][type 1B][payload]`
- **Encrypted**: `[flag 1B][type 1B][salt 16B][IV 12B][ciphertext][authTag 16B]`

## Development

```bash
npm install
npm run build        # Build ESM + CJS with tsup
npm run typecheck    # TypeScript strict mode check
npm test             # Run all tests with vitest
npm run test:watch   # Watch mode
```

### Test suite

- **70 tests** across 10 test files
- Unit tests: AES encryption, Pack binary operations, Convert utilities
- Integration tests: EmbedBinary, EmbedObject, EmbedMeta
- End-to-end tests: MP4 full embed/extract cycles, ImageVault JPEG/PNG cycles
- Stealth tests: encrypted structural markers, auto-detection, backward compatibility
- Deniable tests: outer-only, inner-only, both keys, mixed key types
- Coverage: key, password, no encryption, mixed files, binary files, metadata, re-embedding, size validation, wrong key rejection, format validity

## Project structure

```
src/
  index.ts          # Public API exports
  MP4.ts            # MP4 container parser + embed/extract
  ImageVault.ts     # JPEG/PNG container parser + embed/extract
  Atom.ts           # MP4 atom/box representation
  AES.ts            # AES-256-GCM encryption + PBKDF2
  Embed.ts          # Embedding coordinator (public/encrypted/inner layers)
  EmbedBinary.ts    # Binary file embedding (with stealth support)
  EmbedObject.ts    # JSON header embedding (with stealth support)
  Stealth.ts        # AES-256-CTR encryption of structural marker bytes
  LSB.ts            # LSB pixel-level steganography
  Convert.ts        # Buffer/hex/JSON utilities
  Pack.ts           # Binary pack/unpack (native Buffer methods)
  constants.ts      # Buffer size, max header, max int32
  types.ts          # IReadable, IWritable, FileRecord (includes inner flag)
  utils.ts          # Temp file helper
  node/
    Readable.ts     # Node.js file reader
    Writable.ts     # Node.js file writer (chunked, O(n))
scripts/
  vault-batch.mjs   # Batch encrypt/decrypt folders
  vault-keygen.mjs  # Generate/derive AES keys from mnemonics
  lsb-encode.mjs    # LSB pixel-level encode/decode
test/
  common.test.ts    # AES, Convert, Pack unit tests
  embedBinary.test.ts
  embedObject.test.ts
  embedMeta.test.ts
  mixed.test.ts
  mp4.test.ts
  e2e.test.ts       # MP4 end-to-end tests
  imageVault.test.ts # JPEG/PNG end-to-end tests
  stealth.test.ts   # Stealth mode tests
  deniable.test.ts  # Deniable dual-layer tests
```

## Ecosystem

| Package | Purpose |
|---------|---------|
| [@h3l1os/mp4vault](https://github.com/h3l1os-sol/mp4vault) | Vault container encryption (this package) |
| [@h3l1os/dct-stego](https://github.com/h3l1os-sol/dct-stego) | DCT spread-spectrum JPEG steganography — survives social media re-compression |
| [Chrome Extension](https://github.com/EdwinKestler/Video-Player-Chrome-Extension) | Vault Player — decrypt + play in browser, DCT extraction from right-clicked images |

### Social media pipeline

For images posted on Twitter/Instagram (which re-compress uploads), use `@h3l1os/dct-stego` to embed the IPFS address of a vault file into a public image:

```
Creator: vault file → IPFS → CID → dct-stego embeds CID into public JPEG → post to Twitter
Viewer:  right-click → Chrome extension → DCT extracts CID → fetches vault from IPFS → decrypts
```

See the [@h3l1os/dct-stego README](https://github.com/h3l1os-sol/dct-stego) for the complete pipeline.

## License

[AGPL-3.0](LICENSE)
