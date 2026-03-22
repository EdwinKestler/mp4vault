# Deployment Steps — h3l1os Ecosystem

## Phase 1: npm Organization & Package (DONE)

### 1.1 Create npm org — DONE
- npm org: `h3l1os` at https://www.npmjs.com/org/h3l1os

### 1.2 Publish @h3l1os/mp4vault — DONE
- Published: https://www.npmjs.com/package/@h3l1os/mp4vault
- Version: 2.0.0

---

## Phase 2: GitHub Repos — Rename & Create

### 2.1 GitHub org — DONE
- Org: https://github.com/h3l1os-sol

### 2.2 mp4vault repo — DONE
- Repo: https://github.com/h3l1os-sol/mp4vault
- Pushed to `upstream` remote
- TODO: rename local folder `mv ~/github/mp4steg ~/github/mp4vault`

### 2.3 h3l1os-anchor repo (Solana program)
- Create `h3l1os-sol/h3l1os-anchor` on GitHub
- From PowerShell (Windows):
```powershell
cd D:\github\pepperwatch-anchor
git remote set-url origin https://github.com/h3l1os-sol/h3l1os-anchor.git
git push -u origin master
```
- Rename local folder: `Rename-Item D:\github\pepperwatch-anchor h3l1os-anchor`
- Update in files:
  - `Anchor.toml` — program name, paths
  - `Cargo.toml` — package name
  - `programs/pepperwatch-anchor/` — rename directory
  - `programs/pepperwatch-anchor/Cargo.toml` — crate name
  - `lib.rs` — `declare_id!()` stays the same (same program ID)
  - `tests/pepperwatch-anchor.ts` — import paths
  - `CLAUDE.md` — references
  - IDL/types will regenerate on next `anchor build`

### 2.4 h3l1os-next repo (Next.js frontend)
- Create `h3l1os-sol/h3l1os-next` on GitHub
- From WSL:
```bash
cd ~/github/pepperwatch-next
git remote set-url origin https://github.com/h3l1os-sol/h3l1os-next.git
git push -u origin master
```
- Rename local folder: `mv ~/github/pepperwatch-next ~/github/h3l1os-next`

---

## Phase 3: Update h3l1os-next to use @h3l1os/mp4vault (DONE)

All code changes below have already been applied:

### 3.1 Replace mp4steg dependency
```bash
cd ~/github/pepperwatch-next
npm uninstall mp4steg
npm install @h3l1os/mp4vault
```

### 3.2 Server-side API routes (created)
Embed/extract now runs server-side via Next.js API routes instead of in the browser:

- **`POST /api/vault/embed`** — `src/app/api/vault/embed/route.ts`
  - Accepts: `video` (File), `file` (File), `key` (hex string), `password` (string), `meta` (JSON string)
  - Returns: embedded MP4 as `application/octet-stream`

- **`POST /api/vault/extract`** — `src/app/api/vault/extract/route.ts`
  - Accepts: `video` (File), `key` (hex), `password` (string), `index` ("list" | number)
  - Returns: extracted file as `application/octet-stream`, or file list as JSON

### 3.3 Client-side vault helper (created)
- **`src/lib/vault.ts`** — `vaultEmbed()`, `vaultExtract()`, `vaultList()`
  - Handles FormData construction, hex key encoding, error handling
  - Drop-in replacement for the old window.newMP4Steg pattern

### 3.4 Updated consumer classes
- **`UserContainer.ts`** — `makeEncoded()` now calls `vaultEmbed()` instead of `window.newMP4Steg()`
- **`UploadedContainer.ts`** — `decode()` now calls `vaultList()` + `vaultExtract()`
- Removed `MP4StegInstance` interface and `window.newMP4Steg` dependency from both files

### 3.5 Config updated
- **`next.config.ts`** — added `serverExternalPackages: ["@h3l1os/mp4vault"]`

### 3.6 Still TODO after npm publish
- Delete `scripts/patch-mp4steg.js`
- Remove `"postinstall": "node scripts/patch-mp4steg.js"` from package.json
- Remove `"mp4steg": "github:PepperWatch/mp4steg"` from dependencies
- Remove or gut `StegProvider.tsx` (no longer needed — crypto is server-side)
- Remove `StegProvider` from root layout (`src/app/layout.tsx`)
- Rename pepperwatch references throughout codebase

---

## Phase 4: Update h3l1os-anchor references in frontend

### 4.1 Regenerate IDL
```bash
# From PowerShell: D:\github\h3l1os-anchor
anchor build
```
- Copy new IDL to frontend if program name changed

### 4.2 Update frontend Anchor integration
- Update IDL import path in frontend
- Update program name in any `Program` constructor calls
- Program ID stays the same — no redeployment needed unless you want a fresh deploy

---

## Phase 5: Verify

- [ ] `npm info @h3l1os/mp4vault` returns package metadata
- [ ] https://github.com/h3l1os-sol/mp4vault — repo accessible
- [ ] https://github.com/h3l1os-sol/h3l1os-anchor — repo accessible
- [ ] https://github.com/h3l1os-sol/h3l1os-next — repo accessible
- [ ] `anchor build` succeeds in h3l1os-anchor
- [ ] `anchor test` passes in h3l1os-anchor
- [ ] `npm run build` succeeds in h3l1os-next
- [ ] `POST /api/vault/embed` — embed a file into an MP4
- [ ] `POST /api/vault/extract` — extract a file from an MP4
- [ ] Wrong key returns 403
- [ ] Solana program interactions work from frontend

---

## Known Issues / Future Work

1. **Embed.ts:55 logic bug** — encryption condition uses `&&` where `||` likely intended
2. **Anchor program rename** — if you rename the Rust crate, `anchor build` regenerates IDL with new name; all consumers must update
3. **Program ID** — stays the same across renames; only changes if you redeploy to a new keypair
4. **Upload size limits** — API routes allow 200MB; adjust in route files and hosting provider (Vercel default is 4.5MB for serverless, need pro plan or custom server for large files)
5. **Viewer.ts** — `getDecodedVideoURL()` still creates an `UploadedContainer` which now calls the API; this means the video gets uploaded to the server twice (once to fetch from IPFS, once to send to `/api/vault/extract`). Consider adding a server-side extract-from-URL endpoint later.
