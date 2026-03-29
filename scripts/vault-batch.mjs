#!/usr/bin/env node

/**
 * vault-batch — Batch encrypt/decrypt files using MP4 or ImageVault
 *
 * Auto-detects mode from the cover file extension:
 *   .mp4           → MP4 video steganography
 *   .jpg/.jpeg/.png → ImageVault image steganography
 *
 * Encrypt: Takes a folder of private files, embeds each one inside a copy
 * of a public cover file. Output goes to a separate folder (or replaces
 * in-place) so you end up with identical-looking cover files, each hiding
 * a different private file.
 *
 * Decrypt: Takes a folder of vault files, extracts the hidden file from
 * each one into an output directory, restoring the originals.
 *
 * Usage:
 *   node scripts/vault-batch.mjs encrypt <dir> --cover <file> --password <pw> [--output <dir>]
 *   node scripts/vault-batch.mjs encrypt <dir> --cover <file> --key <hex>     [--output <dir>]
 *   node scripts/vault-batch.mjs decrypt <dir> --password <pw> --output <dir> [--mode image|video]
 *   node scripts/vault-batch.mjs decrypt <dir> --key <hex>     --output <dir> [--mode image|video]
 *
 * Examples:
 *   # Encrypt images behind a cover JPEG
 *   node scripts/vault-batch.mjs encrypt ./photos --cover cover.jpg --password "my-secret" --output ./vault
 *
 *   # Encrypt videos behind a cover MP4
 *   node scripts/vault-batch.mjs encrypt ./videos --cover cover.mp4 --password "my-secret" --output ./vault
 *
 *   # Decrypt (auto-detects format from file headers)
 *   node scripts/vault-batch.mjs decrypt ./vault --password "my-secret" --output ./restored
 *
 *   # Force decrypt mode if auto-detect fails
 *   node scripts/vault-batch.mjs decrypt ./vault --password "my-secret" --output ./restored --mode video
 */

import { MP4, ImageVault, Convert, Writable } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.m4a', '.mov']);
const ALL_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

function usage() {
  console.log(`
vault-batch — Batch encrypt/decrypt files using MP4 or ImageVault

ENCRYPT:
  node scripts/vault-batch.mjs encrypt <dir> --cover <file> --password <pw> [--output <dir>]
  node scripts/vault-batch.mjs encrypt <dir> --cover <file> --key <hex>     [--output <dir>]

  Cover file determines mode:
    .mp4              → hides files inside MP4 video containers
    .jpg/.jpeg/.png   → hides files inside JPEG/PNG images

DECRYPT:
  node scripts/vault-batch.mjs decrypt <dir> --password <pw> --output <dir> [--mode image|video]
  node scripts/vault-batch.mjs decrypt <dir> --key <hex>     --output <dir> [--mode image|video]

  Auto-detects format from file headers. Use --mode to override.

Options:
  --cover <file>     Public cover file (required for encrypt)
  --password <pw>    Password for AES-256-GCM encryption
  --key <hex>        Hex-encoded AES key (alternative to --password)
  --output <dir>     Output directory (default: replace in-place for encrypt)
  --ext <ext>        Output extension for encrypt (default: same as cover)
  --mode <mode>      Force mode: "image" or "video" (default: auto from cover)
                     For encrypt: only processes files matching that mode's extensions
                     For decrypt: forces parser instead of auto-detecting from headers
  `);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function listFiles(dir, exts) {
  return fs.readdirSync(dir)
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      return exts.has(ext) && !f.startsWith('.');
    })
    .sort();
}

function isVideoMode(coverPath) {
  const ext = path.extname(coverPath).toLowerCase();
  return VIDEO_EXTS.has(ext);
}

/** Detect format from first bytes of file */
async function detectFileFormat(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);

  // JPEG: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image';
  // MP4: check for ftyp at offset 4
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video';
  // MP4: atom size=1 (extended), ftyp at offset 8 (rare)
  if (buf[8] === 0x66 && buf[9] === 0x74 && buf[10] === 0x79 && buf[11] === 0x70) return 'video';

  return null;
}

function createVault(mode, args) {
  const vault = mode === 'video' ? new MP4() : new ImageVault();
  if (args.key) {
    vault.setKey(Convert.hexStringToBuffer(args.key));
  } else {
    vault.setPassword(args.password);
  }
  return vault;
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function elapsed(startMs) {
  const s = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${s}s`;
}

// --- Encrypt ---

async function batchEncrypt(inputDir, args) {
  const coverPath = args.cover;
  if (!coverPath) {
    console.error('Error: --cover <file> is required for encrypt');
    process.exit(1);
  }
  if (!fs.existsSync(coverPath)) {
    console.error(`Error: cover file not found: ${coverPath}`);
    process.exit(1);
  }

  const video = isVideoMode(coverPath);
  const mode = args.mode || (video ? 'video' : 'image');

  // --mode filters input files to matching extensions only
  // Without --mode, accept all files in the directory
  const filterExts = args.mode === 'video' ? VIDEO_EXTS
    : args.mode === 'image' ? IMAGE_EXTS
    : null;

  const outputDir = args.output || inputDir;
  const inPlace = outputDir === inputDir;
  const coverExt = args.ext || path.extname(coverPath).toLowerCase();

  if (!inPlace) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const files = fs.readdirSync(inputDir)
    .filter(f => {
      if (f.startsWith('.')) return false;
      if (!fs.statSync(path.join(inputDir, f)).isFile()) return false;
      if (filterExts) {
        return filterExts.has(path.extname(f).toLowerCase());
      }
      return true;
    })
    .sort();

  if (files.length === 0) {
    console.log('No files found in', inputDir);
    return;
  }

  console.log(`Encrypting ${files.length} files (${mode} mode)`);
  console.log(`  Cover:    ${coverPath} (${fmt(fs.statSync(coverPath).size)})`);
  console.log(`  Input:    ${inputDir}`);
  console.log(`  Output:   ${outputDir}${inPlace ? ' (in-place)' : ''}`);
  console.log(`  Crypto:   ${args.key ? 'AES key' : 'password'}`);
  console.log();

  let success = 0;
  let failed = 0;
  const totalStart = Date.now();

  for (const file of files) {
    const inputPath = path.join(inputDir, file);
    const baseName = path.basename(file, path.extname(file));
    const outputName = baseName + coverExt;
    const outputPath = path.join(outputDir, outputName);
    const tempPath = path.join(os.tmpdir(), `vault-${crypto.randomUUID()}${coverExt}`);
    const fileStart = Date.now();

    try {
      const origSize = fs.statSync(inputPath).size;

      const vault = createVault(mode, args);
      await vault.loadFile({ filename: coverPath });
      await vault.embedFile({ filename: inputPath });
      await vault.embed(new Writable({ filename: tempPath }));

      fs.copyFileSync(tempPath, outputPath);
      fs.unlinkSync(tempPath);

      if (inPlace && outputName !== file) {
        fs.unlinkSync(inputPath);
      }

      const vaultSize = fs.statSync(outputPath).size;
      console.log(`  [+] ${file} → ${outputName}  (${fmt(origSize)} hidden in ${fmt(vaultSize)}, ${elapsed(fileStart)})`);
      success++;
    } catch (err) {
      console.error(`  [!] ${file} — FAILED: ${err.message}`);
      failed++;
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  console.log(`\nDone: ${success} encrypted, ${failed} failed (${elapsed(totalStart)} total)`);
}

// --- Decrypt ---

async function batchDecrypt(inputDir, args) {
  const outputDir = args.output;
  if (!outputDir) {
    console.error('Error: --output <dir> is required for decrypt');
    process.exit(1);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const forceMode = args.mode || null; // 'image', 'video', or null (auto)

  const files = fs.readdirSync(inputDir)
    .filter(f => {
      const ext = path.extname(f).toLowerCase();
      return ALL_EXTS.has(ext) && !f.startsWith('.');
    })
    .sort();

  if (files.length === 0) {
    console.log('No supported files found in', inputDir);
    return;
  }

  console.log(`Decrypting ${files.length} files${forceMode ? ` (forced ${forceMode} mode)` : ' (auto-detect)'}`);
  console.log(`  Input:    ${inputDir}`);
  console.log(`  Output:   ${outputDir}`);
  console.log(`  Crypto:   ${args.key ? 'AES key' : 'password'}`);
  console.log();

  let success = 0;
  let failed = 0;
  let skipped = 0;
  const totalStart = Date.now();

  for (const file of files) {
    const inputPath = path.join(inputDir, file);
    const fileStart = Date.now();

    try {
      // Detect format
      let mode = forceMode;
      if (!mode) {
        mode = await detectFileFormat(inputPath);
        if (!mode) {
          console.log(`  [-] ${file} — unknown format, skipping`);
          skipped++;
          continue;
        }
      }

      const vault = createVault(mode, args);
      await vault.loadFile({ filename: inputPath });
      const embedded = vault.getEmbedFiles();

      if (embedded.length === 0) {
        console.log(`  [-] ${file} — no embedded files, skipping`);
        skipped++;
        continue;
      }

      // Extract the first (primary) embedded file
      const record = embedded[0];
      const outputPath = path.join(outputDir, record.filename);

      const extracted = await vault.extractFile(0);
      await extracted.saveToFile(outputPath);

      console.log(`  [+] ${file} → ${record.filename}  (${fmt(record.size)}, ${mode}, ${elapsed(fileStart)})`);
      success++;
    } catch (err) {
      console.error(`  [!] ${file} — FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${success} decrypted, ${failed} failed, ${skipped} skipped (${elapsed(totalStart)} total)`);
}

// --- Main ---

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const dir = args._[1];

if (!command || !dir) usage();

if (!args.password && !args.key) {
  console.error('Error: --password or --key is required');
  process.exit(1);
}

if (!fs.existsSync(dir)) {
  console.error(`Error: directory not found: ${dir}`);
  process.exit(1);
}

if (command === 'encrypt') {
  await batchEncrypt(dir, args);
} else if (command === 'decrypt') {
  await batchDecrypt(dir, args);
} else {
  console.error(`Unknown command: ${command}`);
  usage();
}
