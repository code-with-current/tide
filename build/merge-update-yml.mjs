/**
 * Merges per-arch latest-mac-*.yml files (produced by separate CI legs)
 * into a single latest-mac.yml for electron-updater.
 *
 * electron-updater downloads latest-mac.yml and picks the right file from
 * the `files` array based on the running architecture. Each CI leg only
 * knows about its own arch, so we combine them here.
 *
 * Usage: node build/merge-update-yml.mjs <assets-dir> <output-dir>
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const assetsDir = process.argv[2] || 'assets'
const outputDir = process.argv[3] || 'dist'

/**
 * Minimal parser for electron-builder's flat YAML format.
 * Handles: version, files[] (url, sha512, size), path, sha512, releaseDate.
 */
function parseYml(content) {
  const result = { files: [] }
  let currentFile = null
  for (const line of content.split('\n')) {
    if (line.startsWith('version: ')) result.version = line.slice(9).trim()
    else if (line.startsWith('  - url: ')) {
      currentFile = { url: line.slice(9).trim() }
      result.files.push(currentFile)
    } else if (line.startsWith('    sha512: ') && currentFile) {
      currentFile.sha512 = line.slice(12).trim()
    } else if (line.startsWith('    size: ') && currentFile) {
      currentFile.size = line.slice(10).trim()
    } else if (line.startsWith('path: ')) result.path = line.slice(6).trim()
    else if (line.startsWith('sha512: ')) result.sha512 = line.slice(8).trim()
    else if (line.startsWith('releaseDate: ')) result.releaseDate = line.slice(13).trim()
  }
  return result
}

function serializeYml(data) {
  const lines = [`version: ${data.version}`, 'files:']
  for (const f of data.files) {
    lines.push(`  - url: ${f.url}`)
    if (f.sha512) lines.push(`    sha512: ${f.sha512}`)
    if (f.size) lines.push(`    size: ${f.size}`)
  }
  if (data.path) lines.push(`path: ${data.path}`)
  if (data.sha512) lines.push(`sha512: ${data.sha512}`)
  if (data.releaseDate) lines.push(`releaseDate: ${data.releaseDate}`)
  return lines.join('\n') + '\n'
}

const arm64Path = path.join(assetsDir, 'latest-mac-arm64.yml')
const x64Path = path.join(assetsDir, 'latest-mac-x64.yml')

if (!fs.existsSync(arm64Path) && !fs.existsSync(x64Path)) {
  console.log('No per-arch mac metadata found — skipping merge')
  process.exit(0)
}

const parts = []
for (const [arch, file] of [['arm64', arm64Path], ['x64', x64Path]]) {
  if (!fs.existsSync(file)) continue
  const parsed = parseYml(fs.readFileSync(file, 'utf8'))
  parts.push(parsed)
  console.log(`  ${arch}: ${parsed.files.length} file(s), version ${parsed.version}`)
}

if (parts.length === 0) {
  console.error('No valid mac metadata found')
  process.exit(1)
}

const merged = {
  version: parts[0].version,
  files: parts.flatMap((p) => p.files),
  path: parts[0].path,
  sha512: parts[0].sha512,
  releaseDate: parts[0].releaseDate,
}

const outPath = path.join(outputDir, 'latest-mac.yml')
fs.writeFileSync(outPath, serializeYml(merged))
console.log(`Merged latest-mac.yml → ${outPath} (${merged.files.length} files)`)
