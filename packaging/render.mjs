#!/usr/bin/env node
// Renders the winget / homebrew manifests for a given Tide release by
// substituting @@MARKERS@@ in the templates under packaging/<platform>/ and
// streaming each GitHub Release asset through sha256.
//
// Usage:
//   node packaging/render.mjs --version 0.1.2-beta --repo code-with-current/tide [--out out/]
//
// The released artifact names MUST match build/build.js exactly:
//   Windows: Tide-v<version>-x64-Setup.exe
//   mac arm: Tide-<version>-arm64.dmg        mac x64: Tide-<version>-x64.dmg
//   Linux  : Tide-<version>_amd64.deb

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
// Default BASE is the canonical GitHub Release download URL for this version.
const outDir = path.resolve(args.out ?? path.join(PKG, 'packaging', 'out'))

if (!version) {
  console.error('Missing --version (e.g. 0.1.2-beta, matching package.json without the leading v)')
  process.exit(1)
}

// winget PackageVersion: dotted numeric only (drop the prerelease segment),
// padded to four parts: "0.1.2-beta" -> "0.1.2.0".
const wingetParts = version.replace(/-[A-Za-z0-9.]+$/, '').split('.').map(Number)
while (wingetParts.length < 4) wingetParts.push(0)
const WINGET_VERSION = wingetParts.slice(0, 4).join('.')

const BASE = args.base ?? `https://github.com/${repo}/releases/download/v${version}`
const ASSETS = {
  EXE: `${BASE}/Tide-v${version}-x64-Setup.exe`,
  DMG_ARM64: `${BASE}/Tide-${version}-arm64.dmg`,
  DMG_X64: `${BASE}/Tide-${version}-x64.dmg`,
  DEB: `${BASE}/Tide_${version}_amd64.deb`,
}

async function sha256(url) {
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`)
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
  EXE: await sha256(ASSETS.EXE),
  DMG_ARM64: await sha256(ASSETS.DMG_ARM64),
  DMG_X64: await sha256(ASSETS.DMG_X64),
  DEB: await sha256(ASSETS.DEB),
}

// meta.json carries every value the release-pkgs workflow needs to submit to
// winget/homebrew without re-downloading the installers.
const meta = {
  version,
  wingetVersion: WINGET_VERSION,
  assets: {
    exe: { url: ASSETS.EXE, sha256: SHAS.EXE },
    dmgArm64: { url: ASSETS.DMG_ARM64, sha256: SHAS.DMG_ARM64 },
    dmgX64: { url: ASSETS.DMG_X64, sha256: SHAS.DMG_X64 },
    deb: { url: ASSETS.DEB, sha256: SHAS.DEB },
  },
}
writeOut('meta.json', JSON.stringify(meta, null, 2) + '\n')

const common = {
  VERSION: version,
  VERSION_WINGET: WINGET_VERSION,
  SHA256_EXE: SHAS.EXE,
  SHA256_ARM64: SHAS.DMG_ARM64,
  SHA256_X64: SHAS.DMG_X64,
  SHA256_DEB: SHAS.DEB,
}

console.error('Writing rendered manifests…')

// homebrew
writeOut('homebrew/tide.rb', render(readTpl('homebrew/tide.rb'), common))

// winget (version + installer + default locale)
writeOut('winget/Tide.Tide.yaml', render(readTpl('winget/Tide.Tide.yaml'), common))
writeOut('winget/Tide.Tide.installer.yaml', render(readTpl('winget/Tide.Tide.installer.yaml'), common))
writeOut('winget/Tide.Tide.locale.en-US.yaml', render(readTpl('winget/Tide.Tide.locale.en-US.yaml'), common))

console.error(`Done. Rendered manifests are in ${path.relative(PKG, outDir)}/`)
