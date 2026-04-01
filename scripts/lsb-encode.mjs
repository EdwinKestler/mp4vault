#!/usr/bin/env node

/**
 * lsb-encode — Encode/decode IPFS CIDs (or any short string) into image pixels
 *
 * Usage:
 *   node scripts/lsb-encode.mjs encode <image> <payload> [--output <file>] [--redundancy <n>]
 *   node scripts/lsb-encode.mjs decode <image> [--redundancy <n>]
 *   node scripts/lsb-encode.mjs info <image>
 *
 * Examples:
 *   # Encode an IPFS CID into an image
 *   node scripts/lsb-encode.mjs encode photo.png "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" --output stego.png
 *
 *   # Decode CID from an image
 *   node scripts/lsb-encode.mjs decode stego.png
 *
 *   # Check capacity
 *   node scripts/lsb-encode.mjs info photo.png
 *
 * Requires: sharp (npm install sharp)
 */

import sharp from 'sharp';
import { LSB } from '../dist/index.js';
import fs from 'fs';
import path from 'path';

function usage() {
  console.log(`
lsb-encode — Encode/decode short strings into image pixels via LSB steganography

ENCODE:
  node scripts/lsb-encode.mjs encode <image> <payload> [--output <file>] [--redundancy <n>]

DECODE:
  node scripts/lsb-encode.mjs decode <image> [--redundancy <n>]

INFO:
  node scripts/lsb-encode.mjs info <image>

Options:
  --output <file>      Output image path (default: <name>-lsb.<ext>)
  --redundancy <n>     Error correction factor (default: 15, higher = more robust)
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

async function encode(imagePath, payload, outputPath, redundancy) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  console.log(`Image: ${width}x${height} (${path.basename(imagePath)})`);
  console.log(`Payload: "${payload}" (${Buffer.byteLength(payload)} bytes)`);
  console.log(`Redundancy: ${redundancy}x`);

  const channelsNeeded = LSB.channelsNeeded(Buffer.byteLength(payload), redundancy);
  const available = width * height * 3;
  console.log(`Channels needed: ${channelsNeeded} / ${available} available (${(channelsNeeded / available * 100).toFixed(2)}%)`);

  if (!LSB.canFit(width, height, Buffer.byteLength(payload), redundancy)) {
    console.error(`Error: image too small for this payload with redundancy ${redundancy}`);
    console.error(`  Try a larger image or --redundancy ${Math.floor(available / (channelsNeeded / redundancy))}`);
    process.exit(1);
  }

  // Get raw RGBA pixels
  const { data: pixels, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Encode
  LSB.encode(pixels, payload, redundancy);

  // Write output as PNG (lossless — preserves exact LSB values)
  await sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(outputPath);

  const outSize = fs.statSync(outputPath).size;
  console.log(`\nOutput: ${outputPath} (${(outSize / 1024).toFixed(1)}KB)`);
  console.log('Payload encoded successfully.');

  // Verify by reading back
  const verifyImage = sharp(outputPath);
  const { data: verifyPixels } = await verifyImage.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = LSB.decode(verifyPixels, redundancy);
  if (decoded === payload) {
    console.log('Verification: PASS');
  } else {
    console.error('Verification: FAIL — decoded:', decoded);
  }
}

async function decode(imagePath, redundancy) {
  const image = sharp(imagePath);
  const { data: pixels } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const result = LSB.decode(pixels, redundancy);

  if (result === null) {
    console.log('No LSB payload found in this image.');
    console.log('(Wrong image, wrong redundancy, or data was corrupted by re-compression)');
    process.exit(1);
  }

  console.log(result);
}

async function info(imagePath) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const { width, height, format } = metadata;
  const available = width * height * 3;

  console.log(`Image: ${width}x${height} ${format} (${path.basename(imagePath)})`);
  console.log(`Available RGB channels: ${available}`);
  console.log('');
  console.log('Max payload capacity at different redundancy levels:');
  for (const r of [3, 5, 9, 15, 25, 51]) {
    const headerBits = (16 + 16 + 8) * r; // magic + length + checksum
    const payloadBits = available - headerBits;
    const maxBytes = Math.max(0, Math.floor(payloadBits / (8 * r)));
    console.log(`  ${r}x redundancy: ${maxBytes} bytes (${(maxBytes).toLocaleString()} chars)`);
  }

  // Check for existing payload
  const { data: pixels } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const r of [15, 9, 5, 25, 3, 51]) {
    const result = LSB.decode(pixels, r);
    if (result !== null) {
      console.log(`\nFound existing payload (redundancy ${r}x): "${result}"`);
      return;
    }
  }
  console.log('\nNo existing LSB payload detected.');
}

// --- Main ---

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command) usage();

const redundancy = parseInt(args.redundancy || '15', 10);

if (command === 'encode') {
  const imagePath = args._[1];
  const payload = args._[2];
  if (!imagePath || !payload) {
    console.error('Usage: lsb-encode.mjs encode <image> <payload>');
    process.exit(1);
  }
  const ext = path.extname(imagePath);
  const base = path.basename(imagePath, ext);
  const dir = path.dirname(imagePath);
  const outputPath = args.output || path.join(dir, `${base}-lsb.png`);
  await encode(imagePath, payload, outputPath, redundancy);

} else if (command === 'decode') {
  const imagePath = args._[1];
  if (!imagePath) {
    console.error('Usage: lsb-encode.mjs decode <image>');
    process.exit(1);
  }
  await decode(imagePath, redundancy);

} else if (command === 'info') {
  const imagePath = args._[1];
  if (!imagePath) {
    console.error('Usage: lsb-encode.mjs info <image>');
    process.exit(1);
  }
  await info(imagePath);

} else {
  console.error('Unknown command:', command);
  usage();
}
