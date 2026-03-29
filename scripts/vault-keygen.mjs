#!/usr/bin/env node

/**
 * vault-keygen — Generate or derive AES-256 keys for vault operations
 *
 * Usage:
 *   node scripts/vault-keygen.mjs generate              # Random 8-word mnemonic + key
 *   node scripts/vault-keygen.mjs derive <8 words>       # Derive key from mnemonic
 *   node scripts/vault-keygen.mjs random                 # Random 32-byte hex key (no mnemonic)
 *
 * Examples:
 *   node scripts/vault-keygen.mjs generate
 *   node scripts/vault-keygen.mjs derive wallet image testing vault digital asset any safe
 *   node scripts/vault-keygen.mjs random
 *
 * The mnemonic is run through PBKDF2 (600k iterations, SHA-512) — same as
 * mp4vault's password mode — to produce a 32-byte AES-256 key. The key is
 * deterministic: same mnemonic always produces the same key.
 *
 * Use the hex key output with vault-batch.mjs --key <hex>
 */

import crypto from 'crypto';

// BIP-39 inspired wordlist (2048 common English words)
// Using a compact subset for simplicity — 256 words is enough for 8-word
// mnemonics with 64 bits of entropy (2^64 combinations)
const WORDLIST = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract',
  'absurd', 'abuse', 'access', 'accident', 'account', 'accuse', 'achieve', 'acid',
  'across', 'act', 'action', 'actor', 'actual', 'adapt', 'add', 'addict',
  'address', 'adjust', 'admit', 'adult', 'advance', 'advice', 'afraid', 'again',
  'agent', 'agree', 'ahead', 'aim', 'air', 'airport', 'aisle', 'alarm',
  'album', 'alcohol', 'alert', 'alien', 'all', 'alley', 'allow', 'almost',
  'alone', 'alpha', 'already', 'also', 'alter', 'always', 'amateur', 'amazing',
  'among', 'amount', 'anchor', 'ancient', 'anger', 'angle', 'angry', 'animal',
  'ankle', 'announce', 'annual', 'another', 'answer', 'antenna', 'antique', 'anxiety',
  'any', 'apart', 'apology', 'appear', 'apple', 'approve', 'april', 'arch',
  'arctic', 'area', 'arena', 'argue', 'arm', 'armor', 'army', 'arrange',
  'arrest', 'arrive', 'arrow', 'art', 'artist', 'artwork', 'ask', 'aspect',
  'assault', 'asset', 'assist', 'assume', 'attack', 'attend', 'attract', 'auction',
  'audit', 'august', 'aunt', 'author', 'auto', 'avoid', 'avocado', 'awake',
  'aware', 'away', 'balance', 'ball', 'bamboo', 'banana', 'banner', 'bar',
  'barely', 'bargain', 'barrel', 'base', 'basic', 'basket', 'battle', 'beach',
  'bean', 'beauty', 'become', 'beef', 'before', 'begin', 'behind', 'believe',
  'below', 'bench', 'benefit', 'best', 'betray', 'better', 'between', 'beyond',
  'bird', 'birth', 'bitter', 'black', 'blade', 'blame', 'blanket', 'blast',
  'bleak', 'bless', 'blind', 'blood', 'blossom', 'blue', 'blur', 'blush',
  'board', 'boat', 'body', 'boil', 'bomb', 'bone', 'bonus', 'book',
  'boost', 'border', 'boring', 'borrow', 'boss', 'bottom', 'bounce', 'box',
  'brain', 'brand', 'brave', 'bread', 'breeze', 'brick', 'bridge', 'brief',
  'bright', 'bring', 'brisk', 'broken', 'bronze', 'broom', 'brother', 'brown',
  'brush', 'bubble', 'buddy', 'budget', 'buffalo', 'build', 'bulb', 'bulk',
  'bullet', 'bundle', 'burden', 'burger', 'burst', 'bus', 'business', 'busy',
  'butter', 'buyer', 'cabin', 'cable', 'cactus', 'cage', 'cake', 'call',
  'calm', 'camera', 'camp', 'canal', 'cancel', 'candy', 'cannon', 'canvas',
  'canyon', 'capable', 'capital', 'captain', 'carbon', 'card', 'cargo', 'carpet',
  'carry', 'cart', 'case', 'cash', 'castle', 'casual', 'catalog', 'catch',
  'cattle', 'cause', 'ceiling', 'celery', 'cement', 'census', 'century', 'cereal',
  'certain', 'chair', 'chalk', 'champion', 'change', 'chaos', 'chapter', 'charge',
];

const WORD_COUNT = 8;
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = 'sha512';
const KEY_BYTES = 32;
const SALT = Buffer.from('mp4vault-mnemonic-v1', 'utf8');

function generateMnemonic() {
  const words = [];
  for (let i = 0; i < WORD_COUNT; i++) {
    const idx = crypto.randomInt(WORDLIST.length);
    words.push(WORDLIST[idx]);
  }
  return words.join(' ');
}

function deriveKey(mnemonic) {
  return crypto.pbkdf2Sync(mnemonic, SALT, PBKDF2_ITERATIONS, KEY_BYTES, PBKDF2_DIGEST);
}

function usage() {
  console.log(`
vault-keygen — Generate or derive AES-256 keys for vault operations

  node scripts/vault-keygen.mjs generate            Random 8-word mnemonic + key
  node scripts/vault-keygen.mjs derive <8 words>    Derive key from mnemonic
  node scripts/vault-keygen.mjs random              Random 32-byte hex key
  `);
  process.exit(1);
}

// --- Main ---

const command = process.argv[2];

if (!command) usage();

if (command === 'generate') {
  const mnemonic = generateMnemonic();
  const key = deriveKey(mnemonic);

  console.log(`Mnemonic:  ${mnemonic}`);
  console.log(`AES Key:   ${key.toString('hex')}`);
  console.log();
  console.log(`Use with vault-batch:`);
  console.log(`  node scripts/vault-batch.mjs encrypt ./photos --cover cover.jpg --key ${key.toString('hex')}`);
  console.log();
  console.log(`Recover key from mnemonic:`);
  console.log(`  node scripts/vault-keygen.mjs derive ${mnemonic}`);

} else if (command === 'derive') {
  const words = process.argv.slice(3);
  if (words.length < WORD_COUNT) {
    console.error(`Error: expected ${WORD_COUNT} words, got ${words.length}`);
    console.error(`Usage: node scripts/vault-keygen.mjs derive word1 word2 word3 word4 word5 word6 word7 word8`);
    process.exit(1);
  }

  const mnemonic = words.slice(0, WORD_COUNT).join(' ');
  const key = deriveKey(mnemonic);

  console.log(`Mnemonic:  ${mnemonic}`);
  console.log(`AES Key:   ${key.toString('hex')}`);

} else if (command === 'random') {
  const key = crypto.randomBytes(KEY_BYTES);
  console.log(`AES Key:   ${key.toString('hex')}`);
  console.log();
  console.log(`Use with vault-batch:`);
  console.log(`  node scripts/vault-batch.mjs encrypt ./photos --cover cover.jpg --key ${key.toString('hex')}`);
  console.log(`\nWARNING: No mnemonic — save this key, it cannot be recovered.`);

} else {
  console.error(`Unknown command: ${command}`);
  usage();
}
