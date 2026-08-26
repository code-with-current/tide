#!/usr/bin/env node
// Renders the winget / homebrew manifests for a given Tide release by
// substituting @@MARKERS@@ in the templates under packaging/<platform>/ and
// streaming each GitHub Release asset through sha256.
//
// Usage:
//   node packaging/render.mjs --version 0.3.0-beta.1 [--repo code-with-current/tide] [--out out/]
//
// Release tags carry the v prefix; the artifact names below match what
// release.yml actually publishes (see the live release):
//   mac arm64: Tide-<version>-arm64.dmg
//   win x64  : win-x64-Tide-Setup.zip   (zip wrapping a Tide-Setup.exe bootstrapper)
//   linux    : linux-{x64,arm64}-Tide-Setup.tar.gz  (no manifest consumer yet)
//
// Partial releases don't fail the run: an asset that can't be fetched disables
// that platform's manifests with a warning. If no platform can be rendered,
// the script exits 1 (the version is probably wrong).

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(__dirname, '..')

// Accept both --key value and --key=value.
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.replace(/^--/, '')
    const eq = key.indexOf('=')
    if (eq !== -1) {
      out[key.slice(0, eq)] = key.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = ''
      }
    }
  }
  return out
}
const args = parseArgs(process.argv.slice(2))

const version = args.version
const repo = args.repo ?? 'code-with-current/tide'
// Optional: point at a mirror or local release cache instead of github.com.
// Default BASE is the canonical GitHub Release download URL for this version
// (tags are v-prefixed).
const outDir = path.resolve(args.out ?? path.join(PKG, 'packaging', 'out'))

if (!version) {
  console.error('Missing --version (e.g. 0.3.0-beta.1, matching the tag without the v prefix)')
  process.exit(1)
}

// winget PackageVersion: dotted numeric only (drop the prerelease segment),
// padded to four parts: "0.3.0-beta.1" -> "0.3.0.0".
const wingetParts = version.replace(/-[A-Za-z0-9.]+$/, '').split('.').map(Number)
while (wingetParts.length < 4) wingetParts.push(0)
const WINGET_VERSION = wingetParts.slice(0, 4).join('.')

const BASE = args.base ?? `https://github.com/${repo}/releases/download/v${version}`
const ASSETS = {
  DMG_ARM64: `${BASE}/Tide-${version}-arm64.dmg`,
  WIN_ZIP: `${BASE}/win-x64-Tide-Setup.zip`,
}

async function sha256(url) {
  try {
    const res = await fetch(url)
    if (!res.ok || !res.body) {
      console.warn(`  warning: ${path.basename(url)} not fetchable (HTTP ${res.status}) — skipping`)
      return null
    }
    const hash = crypto.createHash('sha256')
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
    }
    const hex = hash.digest('hex')
    console.error(`  sha256 ${path.basename(url)} = ${hex.slice(0, 12)}…`)
    return hex
  } catch (err) {
    console.warn(`  warning: failed to hash ${url}: ${err.message} — skipping`)
    return null
  }
}

function render(template, replacements) {
  let out = template
  for (const [marker, value] of Object.entries(replacements)) {
    out = out.replaceAll(`@@${marker}@@`, value)
  }
  const leftover = out.match(/@@[A-Z0-9_]+@@/g)
  if (leftover) throw new Error(`Unfilled markers remain: ${[...new Set(leftover)].join(', ')}`)
  return out
}

function writeOut(relPath, content) {
  const dest = path.join(outDir, relPath)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, content)
  console.error(`  wrote ${path.relative(PKG, dest)}`)
}

const readTpl = (p) => fs.readFileSync(path.join(PKG, 'packaging', p), 'utf8')

console.error(`Rendering manifests for Tide v${version} (${repo})`)
console.error('Hashing release assets (this downloads each installer)…')

const SHAS = {
  DMG_ARM64: await sha256(ASSETS.DMG_ARM64),
  WIN_ZIP: await sha256(ASSETS.WIN_ZIP),
}

const platforms = {
  homebrew: SHAS.DMG_ARM64 !== null,
  winget: SHAS.WIN_ZIP !== null,
}

// meta.json carries every value the release-pkgs workflow needs to submit to
// winget/homebrew without re-downloading the installers. Assets that were
// missing from the release are omitted; `platforms` tells the downstream
// jobs which manifest sets were actually rendered.
const meta = {
  version,
  tag: `v${version}`,
  wingetVersion: WINGET_VERSION,
  platforms,
  assets: {},
}
if (platforms.homebrew) meta.assets.dmgArm64 = { url: ASSETS.DMG_ARM64, sha256: SHAS.DMG_ARM64 }
if (platforms.winget) meta.assets.winZip = { url: ASSETS.WIN_ZIP, sha256: SHAS.WIN_ZIP }
writeOut('meta.json', JSON.stringify(meta, null, 2) + '\n')

const common = {
  VERSION: version,
  VERSION_WINGET: WINGET_VERSION,
  SHA256_ARM64: SHAS.DMG_ARM64 ?? '',
  SHA256_WINZIP: SHAS.WIN_ZIP ?? '',
}

console.error('Writing rendered manifests…')

// homebrew
if (platforms.homebrew) {
  writeOut('homebrew/tide.rb', render(readTpl('homebrew/tide.rb'), common))
} else {
  console.warn('warning: no arm64 .dmg asset — homebrew cask NOT rendered')
}

// winget (version + installer + default locale)
if (platforms.winget) {
  writeOut('winget/Tide.Tide.yaml', render(readTpl('winget/Tide.Tide.yaml'), common))
  writeOut('winget/Tide.Tide.installer.yaml', render(readTpl('winget/Tide.Tide.installer.yaml'), common))
  writeOut('winget/Tide.Tide.locale.en-US.yaml', render(readTpl('winget/Tide.Tide.locale.en-US.yaml'), common))
} else {
  console.warn('warning: no win-x64-Tide-Setup.zip asset — winget manifests NOT rendered')
}

// Drop manifests left by earlier renders of a platform we couldn't render
// this time, so packaging/out/ (and the workflow artifact built from it)
// never mixes versions.
for (const [platform, enabled] of Object.entries(platforms)) {
  if (!enabled) fs.rmSync(path.join(outDir, platform), { recursive: true, force: true })
}

if (!platforms.homebrew && !platforms.winget) {
  console.error('error: no release assets could be hashed — wrong --version?')
  process.exit(1)
}

console.error(`Done. Rendered manifests are in ${path.relative(PKG, outDir)}/`)
