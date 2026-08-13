/* eslint-disable no-template-curly-in-string */

import builder from 'electron-builder'
import { execSync } from 'child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/**
* @type {import('electron-builder').Configuration}
* @see https://www.electron.build/configuration/configuration
*/
const options = {
  appId: 'com.tide.code',
  productName: 'Tide',
  directories: {
    buildResources: 'build',
    output: 'release',
  },
  files: [
    'dist/**/*',
    'dist-electron/**/*',
    // Strip dead weight from transitive deps of @xenova/transformers:
    //   - onnxruntime-web ships ~60 MB of WASM binaries, but transformers.js
    //     only statically imports the JS entry — in Node it always uses
    //     onnxruntime-node's CPU provider, so the WASM files are never loaded.
    '!**/node_modules/onnxruntime-web/**/*.wasm',
    '!**/node_modules/onnxruntime-web/dist/ort-wasm*.jsep.mjs',
    //   - @xenova/transformers bundles its own ORT WASM binaries (~38 MB)
    //     for browser inference. In Node/Electron the CPU provider is used
    //     via onnxruntime-node, so these are dead weight.
    '!**/node_modules/@xenova/transformers/dist/*.wasm',
    //   - sharp (~24 MB) is pulled in for image preprocessing that Tide never
    //     does — it only embeds source code.
    '!**/node_modules/sharp/**',
    '!**/node_modules/@img/**',
    '!**/node_modules/sharp-libvips*/**',
    //   - Strip source maps and TypeScript declarations from production builds.
    //     They bloat the asar by ~20 MB and are useless at runtime.
    '!**/*.map',
    '!**/*.d.ts',
  ],
  asar: true,
  asarUnpack: [
    'node_modules/better-sqlite3/**',
    'node_modules/node-pty/**',
    'node_modules/onnxruntime-node/**',
    'node_modules/sqlite-vec*/**',
    'node_modules/node-mac-permissions/**',
  ],
  electronLanguages: ['en-US'],
  afterAllArtifactBuild: extractStandaloneAsar,
  publish: [
    {
      provider: 'github',
      owner: 'code-with-current',
      repo: 'tide',
    },
  ],
}

// Copies app.asar out of the built app as a standalone asset for delta
// (ASAR-only) updates — the ~5-10 MB JS bundle vs ~150 MB full installer.
// Gated by EXTRACT_ASAR=1 so only one CI leg produces it (app.asar is
// cross-platform). Also writes a SHA256 checksum for download verification.
function extractStandaloneAsar(context) {
  if (process.env.EXTRACT_ASAR !== '1') return

  // afterAllArtifactBuild receives a BuildResult ({ outDir, artifactPaths,
  // platformToTargets, configuration }) — NOT a PackContext, so appOutDir
  // and packager are unavailable. Locate app.asar in the platform-specific
  // unpacked directory under outDir.
  const { outDir } = context
  let src = null
  for (const dir of fs.readdirSync(outDir)) {
    const dirPath = path.join(outDir, dir)
    // Linux / Windows: <outDir>/{linux,win}-unpacked/resources/app.asar
    const direct = path.join(dirPath, 'resources', 'app.asar')
    if (fs.existsSync(direct)) {
      src = direct
      break
    }
    // macOS: <outDir>/{mac,mac-arm64}/<App>.app/Contents/Resources/app.asar
    if (dir === 'mac' || dir.startsWith('mac-')) {
      for (const entry of fs.readdirSync(dirPath)) {
        if (!entry.endsWith('.app')) continue
        const macAsar = path.join(dirPath, entry, 'Contents', 'Resources', 'app.asar')
        if (fs.existsSync(macAsar)) {
          src = macAsar
          break
        }
      }
    }
    if (src) break
  }

  if (!src) {
    console.warn('EXTRACT_ASAR: app.asar not found in', outDir, '— skipping')
    return
  }

  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const baseName = `tide-core-${version}`
  const dest = path.join(outDir, `${baseName}.asar`)
  fs.copyFileSync(src, dest)

  const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
  fs.writeFileSync(path.join(outDir, `${baseName}.asar.sha256`), `${hash}  ${baseName}.asar\n`)

  console.log(`Extracted standalone asar: ${dest} (${hash.slice(0, 12)}...)`)
}

// afterPack hook: onnxruntime-node ships pre-built binaries for ALL platforms
// (darwin x64+arm64, linux x64+arm64, win32 x64+arm64 ≈ 74 MB). Only the
// target platform+arch binary is needed, so we delete the rest after packing.
// Saves ~50 MB per platform leg.
function stripCrossPlatformOrtBinaries(context) {
  const platform = context.electronPlatformName // 'darwin' | 'win32' | 'linux'
  // electron-builder Arch enum: 1=ia32, 2=x64, 3=armv7l, 4=arm64, 5=universal
  const archName = { 1: 'x86', 2: 'x64', 3: 'arm64', 4: 'arm64' }[context.arch]
  if (!platform || !archName) return

  let unpackedDir
  if (platform === 'darwin' || platform === 'mas') {
    const apps = fs.readdirSync(context.appOutDir).filter(f => f.endsWith('.app'))
    if (apps.length === 0) return
    unpackedDir = path.join(context.appOutDir, apps[0], 'Contents', 'Resources', 'app.asar.unpacked')
  } else {
    unpackedDir = path.join(context.appOutDir, 'resources', 'app.asar.unpacked')
  }

  const ortBin = path.join(unpackedDir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3')
  if (!fs.existsSync(ortBin)) return

  let stripped = false
  for (const platDir of fs.readdirSync(ortBin)) {
    const platPath = path.join(ortBin, platDir)
    if (platDir !== platform) {
      fs.rmSync(platPath, { recursive: true, force: true })
      stripped = true
      continue
    }
    for (const archDir of fs.readdirSync(platPath)) {
      if (archDir !== archName) {
        fs.rmSync(path.join(platPath, archDir), { recursive: true, force: true })
        stripped = true
      }
    }
  }
  if (stripped) console.log(`Stripped ORT binaries: kept ${platform}/${archName} only`)
}

/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
const winOptions = {
  win: {
    icon: 'build/icon.ico',
    target: ['nsis', 'portable', '7z'],
  },
  afterPack: stripCrossPlatformOrtBinaries,
  nsis: {
    oneClick: false,
    language: '2052',
    allowToChangeInstallationDirectory: true,
    shortcutName: 'Tide',
  },
}

/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
const linuxOptions = {
  afterPack: stripCrossPlatformOrtBinaries,
  linux: {
    maintainer: 'Yogi Dewansyah <yodeput@gmail.com>',
    icon: 'build/icons',
    category: 'Utility',
    target: ['AppImage', 'deb'],
    desktop: {
      entry: {
        Name: 'Tide',
        Encoding: 'UTF-8',
      },
    },
  },
  appImage: {
    category: 'Utility',
  },
}

/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration/configuration
 */
// Ad-hoc signing hook. `identity: null` makes electron-builder skip its own
// signing pass; this hook then signs the finished .app (and every nested
// binary — node-pty, better-sqlite3, sharp, sqlite-vec) with an ad-hoc
// identity. No Apple Developer cert needed. Satisfies the Apple Silicon
// "all executables must be signed" requirement so the app launches on
// M-series Macs; does NOT silence Gatekeeper for other users (they still
// need `xattr -cr` or right-click → Open on first launch).
//
// afterPack fires for every target this config applies to. macOptions is
// only spread into the build config on `target=mac` (see build() below),
// so in practice this only runs on mac legs — the darwin guard is here
// purely as a safety net for the `target=dir` path, which merges all
// platform options at once.
const adHocSignMacApp = (context) => {
  if (process.platform !== 'darwin') return
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return

  // context.appOutDir is electron-builder's output dir for this leg; the
  // .app sits directly inside it. Glob rather than reconstruct from
  // productName so a name/appId mismatch can't break the path.
  const apps = fs.readdirSync(context.appOutDir).filter((f) => f.endsWith('.app'))
  if (apps.length === 0) {
    console.warn(`ad-hoc sign: no .app found in ${context.appOutDir}, skipping`)
    return
  }
  for (const app of apps) {
    const appPath = path.join(context.appOutDir, app)
    console.log(`ad-hoc signing ${appPath} ...`)
    execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: 'inherit' })
    // Verify every Mach-O in the bundle carries a signature.
    execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' })
    console.log(`ad-hoc sign: ${app} OK`)
  }
}

const macOptions = {
  mac: {
    identity: null,
    icon: 'build/icon.icns',
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
  },
  afterPack: (context) => {
    stripCrossPlatformOrtBinaries(context)
    adHocSignMacApp(context)
  },
  dmg: {
    window: {
      width: 530,
      height: 380,
    },
    contents: [
      {
        x: 140,
        y: 200,
      },
      {
        x: 390,
        y: 200,
        type: 'link',
        path: '/Applications',
      },
    ],
    title: 'Tide v${version}',
  },
}

const createTarget = {
  /**
   *
   * @param {*} arch
   * @param {*} packageType
   * @returns {{ buildOptions: import('electron-builder').CliOptions, options: import('electron-builder').Configuration }}
   */
  win(arch, packageType) {
    switch (packageType) {
      case 'setup':
        winOptions.artifactName = `\${productName}-v\${version}-${arch}-Setup.\${ext}`
        return {
          buildOptions: { win: ['nsis'] },
          options: winOptions,
        }
      case 'green':
        winOptions.artifactName = `\${productName}-v\${version}-win_${arch}-green.\${ext}`
        return {
          buildOptions: { win: ['7z'] },
          options: winOptions,
        }
      case 'win7_setup':
        winOptions.artifactName = `\${productName}-v\${version}-win7_${arch}-Setup.\${ext}`
        return {
          buildOptions: { win: ['nsis'] },
          options: winOptions,
        }
      case 'win7_green':
        winOptions.artifactName = `\${productName}-v\${version}-win7_${arch}-green.\${ext}`
        return {
          buildOptions: { win: ['7z'] },
          options: winOptions,
        }
      case 'portable':
        winOptions.artifactName = `\${productName}-v\${version}-${arch}-portable.\${ext}`
        return {
          buildOptions: { win: ['portable'] },
          options: winOptions,
        }
      default: throw new Error('Unknown package type: ' + packageType)
    }
  },
  /**
   *
   * @param {*} arch
   * @param {*} packageType
   * @returns {{ buildOptions: import('electron-builder').CliOptions, options: import('electron-builder').Configuration }}
   */
  linux(arch, packageType) {
    switch (packageType) {
      case 'deb':
        linuxOptions.artifactName = `\${productName}_\${version}_${arch == 'x64' ? 'amd64' : arch}.\${ext}`
        return {
          buildOptions: { linux: ['deb'] },
          options: linuxOptions,
        }
      case 'appImage':
        linuxOptions.artifactName = `\${productName}_\${version}_${arch}.\${ext}`
        return {
          buildOptions: { linux: ['AppImage'] },
          options: linuxOptions,
        }
      case 'pacman':
        linuxOptions.artifactName = `\${productName}_\${version}_${arch}.\${ext}`
        return {
          buildOptions: { linux: ['pacman'] },
          options: linuxOptions,
        }
      case 'rpm':
        linuxOptions.artifactName = `\${productName}-\${version}.${arch}.\${ext}`
        return {
          buildOptions: { linux: ['rpm'] },
          options: linuxOptions,
        }
      default: throw new Error('Unknown package type: ' + packageType)
    }
  },
  /**
   *
   * @param {*} arch
   * @param {*} packageType
   * @returns {{ buildOptions: import('electron-builder').CliOptions, options: import('electron-builder').Configuration }}
   */
  mac(arch, packageType) {
    switch (packageType) {
      case 'dmg':
        macOptions.artifactName = `\${productName}-\${version}-${arch}.\${ext}`
        return {
          buildOptions: { mac: ['dmg'] },
          options: macOptions,
        }
      default: throw new Error('Unknown package type: ' + packageType)
    }
  },
}

/**
 *
 * @param {'win' | 'mac' | 'linux' | 'dir'} target 构建目标平台
 * @param {'x86_64' | 'x64' | 'x86' | 'arm64' | 'armv7l'} arch 包架构
 * @param {*} packageType 包类型
 * @param {'onTagOrDraft' | 'always' | 'never'} publishType 发布类型
 */
const build = async(target, arch, packageType, publishType) => {
  if (target == 'dir') {
    const dirConfig = { ...options, ...winOptions, ...linuxOptions, ...macOptions }
    delete dirConfig.publish
    await builder.build({
      dir: true,
      config: dirConfig,
    })
    return
  }
  const targetInfo = createTarget[target](arch, packageType)

  await builder.build({
    ...targetInfo.buildOptions,
    publish: publishType ?? 'never',
    x64: arch == 'x64' || arch == 'x86_64',
    ia32: arch == 'x86' || arch == 'x86_64',
    arm64: arch == 'arm64',
    armv7l: arch == 'armv7l',
    config: { ...options, ...targetInfo.options },
  })
}

const params = {}

for (const param of process.argv.slice(2)) {
  const [name, value] = param.split('=')
  params[name] = value
}

if (params.target == null) throw new Error('Missing target')
if (params.target != 'dir' && params.arch == null) throw new Error('Missing arch')
if (params.target != 'dir' && params.type == null) throw new Error('Missing type')

// Run build first.
// Order matters: renderer (dist/) → electron entry (dist-electron/) →
// vendor tree-sitter grammars into dist-electron/grammars/. The chunker
// is bundled into main.mjs, so __dirname at runtime is dist-electron/
// and it loads grammars from there. Skipping any step ships a broken app.
console.log('Bundling system prompt...')
execSync('node build/promptMarkdownUtils.mjs', { stdio: 'inherit' })

console.log('Building renderer (dist/)...')
execSync('npm run build', { stdio: 'inherit' })

console.log('Building electron entry (dist-electron/)...')
// Use npx so the local vite binary is resolved regardless of package
// manager (npm or pnpm). A bare `vite` call only works if node_modules/.bin
// is on PATH, which it isn't under `node build/build.js`.
execSync('npx vite build --config vite.electron.config.ts', { stdio: 'inherit' })

console.log('Vendoring tree-sitter grammars into dist-electron/grammars/...')
execSync('node build/copy-tree-sitter-grammars.mjs --dist', { stdio: 'inherit' })

// Remove any stale model from dist-electron/models/ — the embedding model
// is lazy-downloaded from HuggingFace at runtime (see electron/rag/model-downloader.ts),
// so it must NOT ship in the bundle. A stale copy from dev builds may linger
// here because vite.electron.config.ts sets emptyOutDir:false (to preserve
// grammars). This guard ensures production builds never carry the 22 MB model.
const staleModel = path.join(ROOT, 'dist-electron', 'models')
if (fs.existsSync(staleModel)) {
  console.log('Removing stale model from dist-electron/models/ (lazy-downloaded at runtime)...')
  fs.rmSync(staleModel, { recursive: true, force: true })
}

// electron-builder accepts: "onTag", "onTagOrDraft", "always", "never".
// Map "none" (used in npm scripts) to "never".
const publishParam = params.publish === 'none' || !params.publish ? 'never' : params.publish
console.log(params.target, params.arch, params.type, publishParam)
build(params.target, params.arch, params.type, publishParam)
  .then(() => console.log('Build completed!'))
  .catch(err => {
    console.error('Build failed:', err)
    process.exit(1)
  })
