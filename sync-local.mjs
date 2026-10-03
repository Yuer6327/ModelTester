#!/usr/bin/env node
/**
 * Sync the freshly built plugin into the local DSH desktop profile.
 *
 * Dev convenience: `pnpm build` ends by copying the artifacts into
 * `~/.dsh/profiles/desktop/node_modules/dsh-modeltester` so the desktop
 * host picks up the new build on its next reload — no manual copy step,
 * nothing to remember. Anywhere the profile does not exist (CI, machines
 * without the desktop host) this is a silent no-op with exit 0, so it is
 * safe inside the publish pipeline (install→prepare→build).
 *
 * Copies the whole `lib/` tree (replaced wholesale — stale leftovers would
 * shadow fixes) plus `package.json` / `dsh-plugin.json` / `cordis.patch.yml`,
 * then verifies every synced file byte-for-byte by SHA-256.
 *
 * Run: node sync-local.mjs (usually via `pnpm build`)
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DEST = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-modeltester')

/** Files synced verbatim from the repo root (besides the lib/ tree). */
const ROOT_FILES = ['package.json', 'dsh-plugin.json', 'cordis.patch.yml']

if (!existsSync(join(DEST, 'package.json'))) {
  console.log(`[sync-local] no desktop profile at ${DEST} — skipped`)
  process.exit(0)
}
if (!existsSync(join(ROOT, 'lib'))) {
  console.error('[sync-local] lib/ missing — run tsdown first')
  process.exit(1)
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Recursively list every file under a directory (absolute paths). */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

/**
 * Recursive file copy without fs.cpSync: cpSync's directory fast-path
 * hard-crashes node 24 on this machine (0xC0000409 fastfail, OneDrive-backed
 * source dir) while plain copyFileSync is fine — so walk and copy by hand.
 */
function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry)
    const dest = join(destDir, entry)
    if (statSync(src).isDirectory()) copyTree(src, dest)
    else copyFileSync(src, dest)
  }
}

// Replace the lib tree wholesale; refresh the manifest files in place.
rmSync(join(DEST, 'lib'), { recursive: true, force: true })
copyTree(join(ROOT, 'lib'), join(DEST, 'lib'))
for (const file of ROOT_FILES) {
  if (existsSync(join(ROOT, file))) copyFileSync(join(ROOT, file), join(DEST, file))
}

// Verify every synced file byte-for-byte against the repo copy.
const synced = [...walk(join(DEST, 'lib')), ...ROOT_FILES.map(file => join(DEST, file))]
let mismatches = 0
for (const dest of synced) {
  const rel = relative(DEST, dest)
  const src = join(ROOT, rel)
  if (!existsSync(src) || sha256(src) !== sha256(dest)) {
    console.error(`[sync-local] MISMATCH ${rel}`)
    mismatches += 1
  }
}
if (mismatches > 0) {
  console.error(`[sync-local] ${mismatches} file(s) failed verification`)
  process.exit(1)
}

// Guard: the host composes its plugin graph from the PROFILE patch layer, and a
// settings-driven rewrite of that file silently drops the plugin's insert entry
// (measured 2026-10-02: the panel stopped mounting while every file here stayed
// intact). Synced files alone prove nothing — the loader must still name us.
const PROFILE_PATCH = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
if (existsSync(PROFILE_PATCH) && !readFileSync(PROFILE_PATCH, 'utf8').includes('dsh-modeltester')) {
  console.error(`[sync-local] WARNING ${PROFILE_PATCH} no longer inserts dsh-modeltester — the host will NOT load the plugin. Re-add:\n- insert:\n    - id: modeltester\n      name: dsh-modeltester`)
}
console.log(`[sync-local] ${synced.length} file(s) synced to desktop profile — reload to take effect`)
