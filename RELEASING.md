# Releasing Tide

Tide auto-updates with [Sparkle](https://sparkle-project.org). Releases live
as assets of the **GitHub releases** of `code-with-current/tide`. New users
download a notarized **`.dmg`** from the release page; existing users get
in-app updates via Sparkle, which reads the appcast at
`https://github.com/code-with-current/tide/releases/latest/download/appcast.xml`,
verifies each build's EdDSA signature, and installs it. The CI workflow builds
every platform and attaches the assets, including the appcasts, to a draft
release; publishing the draft is what opens the update channel (draft assets
are unreachable through `releases/latest`).

Once set up, cutting a release is:

```sh
bun run release
```

- Updater code: [`src/updater.rs`](src/updater.rs) — loads the embedded
  Sparkle.framework at runtime and starts `SPUUpdater` with Tide's custom user
  driver. Available updates appear in the sidebar footer; download, signature
  verification, install, and relaunch remain owned by Sparkle. **Check for
  Updates…** lives in the app menu, and the **Automatic updates** toggle in
  Settings → General mirrors Sparkle's persisted setting.
- Feed URL + public key: [`resources/Info.plist`](resources/Info.plist)
  (`SUFeedURL`, `SUPublicEDKey`).
- Framework embedding + pinned Sparkle version:
  [`scripts/bundle.sh`](scripts/bundle.sh) (bump `sparkle_version` and
  `sparkle_sha256` together; the distribution is cached under
  `.tide-cache/sparkle/`).
- Release automation: [`scripts/release.ts`](scripts/release.ts),
  [`scripts/appcast.ts`](scripts/appcast.ts),
  [`scripts/changelog.ts`](scripts/changelog.ts).
- GitHub Actions: [`.github/workflows/release.yml`](.github/workflows/release.yml)
  builds Linux (x86_64, arm64), Windows (x86_64, arm64), and macOS archives on
  a `v*` tag — or on a manual **Run workflow**, which takes the version from
  `Cargo.toml` — and opens a draft GitHub release with every asset attached.

---

## One-time setup

The release runs on [Bun](https://bun.sh) and needs
[`create-dmg`](https://github.com/create-dmg/create-dmg)
(`brew install bun create-dmg`).

### 1. Sparkle signing keys

Updates are signed with an ed25519 key; the private half stays in the login
keychain and the public half ships in Info.plist as `SUPublicEDKey`.

**This Mac already has the key** — Tide signs with the same default-account
Sparkle key as kero, and the matching public key is already in Info.plist.
Nothing to do.

On a fresh machine, restore the key from the password-manager backup with the
Sparkle tools (they land in `.tide-cache/sparkle/<version>/bin` after any
build, or download the release from
[sparkle-project/Sparkle](https://github.com/sparkle-project/Sparkle/releases)):

```sh
./bin/generate_keys -f sparkle_private_key.txt   # import the backed-up key
./bin/generate_keys -p                            # prints the public key — must
                                                  # match SUPublicEDKey
```

> ⚠️ Lose the private key and existing installs can never update again. Keep
> the backup current.

To split Tide onto its own key later: `generate_keys --account tide`, put the
new public key in Info.plist, and pass `--account tide` through to
`generate_appcast` in `scripts/appcast.ts`. Users on old builds only trust the
old key, so do this on a release that still signs with the old key… in other
words, don't do it casually.

### 2. Developer ID signing + notarization

**No Apple Developer Program membership?** Skip this section — build releases
with `--adhoc` (see the flags table below). Ad-hoc builds are unsigned for
Gatekeeper purposes: they run fine locally, and anyone else who downloads one
bypasses Gatekeeper once (right-click → Open, or `xattr -d com.apple.quarantine`).
Sparkle updates still work — the feed's EdDSA signature is independent of Apple
certificates. Direct `bundle.sh` invocations also default to ad-hoc signing
when no Developer ID identity is installed; the Apple Development certificate
from a free personal team is deliberately never picked, since its bundles are
refused at spawn without provisioning and untrusted on other Macs.

Copy `.env.example` to `.env` and replace the signing and analytics
placeholders. Bun loads these values before Cargo compiles the release, so the
analytics endpoint and website ID are embedded in the executable. The script
notarizes with the `NOTARY` keychain profile by default. On a fresh machine:

```sh
cp .env.example .env
xcrun notarytool store-credentials NOTARY \
  --apple-id you@example.com --team-id YOUR_APPLE_TEAM_ID
```

Override the environment with `--signing-identity`, or change the notary
profile with `--notary-profile` / `TIDE_NOTARY_PROFILE`.

### 3. Release hosting  ← **GitHub Releases, nothing to set up**

Binaries, update feeds, and the `latest-*.txt` pointers are all attached to the
GitHub draft release the CI workflow creates; `releases/latest/download/<file>`
is the stable URL each channel reads. There is no bucket to create — publishing
the draft (which also creates the `v<version>` tag) is the only manual step.

---

## Cutting a release

1. **Bump `version` in `Cargo.toml`** — the single source of truth.
   `CFBundleShortVersionString` is the version, and `CFBundleVersion` is
   derived from it (`major*1e6 + minor*1e3 + patch`, so `0.2.0` → `2000`),
   which keeps Sparkle's build-number comparison monotonic without a manual
   counter. Prerelease versions (`-beta.1`) are refused for publishing — the
   appcast serves one stable channel.
2. **Write the release notes** — add a `## [<version>]` section at the top of
   [`CHANGELOG.md`](CHANGELOG.md).
3. **Run it:**
   ```sh
   bun run release
   ```

The CI workflow is the publisher: it builds, signs, generates the signed
`appcast.xml`, and attaches everything to a draft GitHub release. Locally,
`bun run release --local --adhoc` produces the same DMG + zip + appcast for
testing without any credentials (the full-publish path that uploaded to the
retired R2 bucket no longer has a destination). When the draft finishes:

- **Download link**: the `v<version>` GitHub release page
- **In-app updates**: the same release's appcast assets via `releases/latest`

Test by keeping an older build around, launching it, and choosing
**Check for Updates…**.

### GitHub draft release

The Release workflow runs two ways:

- **Push a `v*` tag** — the tag must match the `version` in `Cargo.toml`, or the
  run fails before anything builds.
- **Actions → Release → Run workflow** — no tag needed. The run releases
  whatever `Cargo.toml` says and drafts it as `v<version>`; that tag is created
  at the built commit when you publish the draft.

macOS CI runs `bun run release --local`, which signs, notarizes, and writes the
same artifacts as a local release:

- `Tide-<version>.dmg`
- `Tide-<version>.zip`
- `appcast.xml` (Sparkle-signed)

Linux CI adds:

- `tide-<version>-x86_64-unknown-linux-gnu.tar.gz`
- `tide-<version>-aarch64-unknown-linux-gnu.tar.gz`
- `latest-linux.txt` — the version `install.sh` resolves "latest" to

Windows CI adds:

- `Tide-<version>-x86_64-Setup.exe`
- `Tide-<version>-aarch64-Setup.exe`
- `tide-<version>-x86_64-pc-windows-msvc.zip` (portable)
- `tide-<version>-aarch64-pc-windows-msvc.zip` (portable)
- `appcast-windows-x86_64.xml`, `appcast-windows-aarch64.xml`
- `latest-windows.txt` — the version the download page resolves "latest" to

[`scripts/bundle-windows.ts`](scripts/bundle-windows.ts) builds both, driving
[`resources/windows/tide.iss`](resources/windows/tide.iss) through Inno Setup's
`ISCC`. The installer is **per-user** (`PrivilegesRequired=lowest`,
`%LOCALAPPDATA%\Programs\Tide`) — no elevation, which is exactly what lets the
updater re-run it silently. The script signs the two executables and the
installer with Authenticode when `WINDOWS_CERTIFICATE` and
`WINDOWS_CERTIFICATE_PASSWORD` are set, and packages them unsigned otherwise,
so a fork without a certificate can still cut a release at the cost of a
SmartScreen warning.

**Never change `AppId` in `tide.iss`.** It is how Windows recognizes an
existing install; a new one turns every update into a second copy in
Add/Remove Programs.

#### The Windows update feed

Windows has no Sparkle, so [`src/updater.rs`](src/updater.rs) runs the same
contract itself: fetch the appcast, compare versions, download, verify the
EdDSA signature, and hand the installer to Inno Setup with `/SILENT`. The
installer closes Tide, replaces it, and starts it again.

- **One feed per architecture.** A Sparkle appcast cannot say which binary an
  item is for, and the client picks its feed at compile time.
- **Same key as macOS.** `build.rs` reads `SUPublicEDKey` out of
  `resources/Info.plist` and compiles it in, so the two platforms cannot drift
  onto different keys.
- [`scripts/appcast-windows.ts`](scripts/appcast-windows.ts) signs the feeds in
  the draft-release job — the only one holding both installers. There is no
  `sign_update` on Linux, so it signs with Node's Ed25519 over the same
  `SPARKLE_PRIVATE_KEY`, and refuses to run when the key does not derive
  `SUPublicEDKey` (signing with the wrong key ships a feed the app rejects).
- The step pulls the live feeds down first and merges, so previously published
  releases keep their entries.

Both Linux jobs run on **Ubuntu 22.04**, and that choice is load-bearing: the
binaries link against the build machine's glibc, so the runner sets the oldest
distribution Tide can start on (2.35 — Ubuntu 22.04, Debian 12, Fedora 36).
Moving those jobs to a newer runner silently drops support for everything
older.

The workflow opens (or updates) a **draft** GitHub release with those files
and the matching `CHANGELOG.md` section. **Publishing the draft is the whole
switch**: it creates the `v<version>` tag and makes every asset — including
the signed `appcast.xml`, `latest-linux.txt`, and `latest-windows.txt` —
reachable through `releases/latest/download/<file>`, which is what the
in-app updaters and the Linux docs point at. Configure these repository
secrets first:

| Secret | Purpose |
| --- | --- |
| `TIDE_ANALYTICS_ENDPOINT` | embedded in the macOS CI build |
| `TIDE_ANALYTICS_WEBSITE_ID` | embedded in the macOS CI build |
| `TIDE_SIGNING_IDENTITY` | Developer ID identity selector |
| `APPLE_CERTIFICATE` | base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID used by `notarytool` |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Developer Team ID |
| `SPARKLE_PRIVATE_KEY` | Sparkle EdDSA key for `generate_appcast`, base64 of the 64-byte seed+public (from `generate_keys`; the seed half feeds the mac appcast, both halves the Windows feed signer) |
| `WINDOWS_CERTIFICATE` | optional; base64-encoded Authenticode `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | optional; password for that `.pfx` |

### Options

| Flag / Env | Default | Purpose |
| --- | --- | --- |
| `--local` | — | build, notarize, and write the DMG + zip without publishing |
| `--adhoc`, `--skip-notarize` | — | no-Apple-Program / local test builds (imply `--local`; `--adhoc` skips the signing identity entirely) |
| `--skip-build` | — | reuse existing release binaries |
| `--build-number <n>` / `TIDE_BUILD_NUMBER` | derived | `CFBundleVersion` override |
| `TIDE_DOWNLOAD_URL_PREFIX` | `releases/latest/download` base | base URL in the appcast |
| `SPARKLE_BIN` | the `.tide-cache` copy | Sparkle tools directory |

---

## Notes

- **Two artifacts per release:** the notarized `.dmg` (what people download)
  and a `.zip` (what Sparkle installs, plus `.delta` files against recent
  builds). Only the zip family appears in the appcast; point download buttons
  at the DMG.
- **Debug builds never update themselves.** `Updater::init` returns `None`
  under `debug_assertions`, so the dev watcher's app can't offer to replace
  itself with a production Tide. Set `TIDE_FORCE_UPDATER=1` to exercise the
  real Sparkle flow from a debug bundle anyway. A bare `cargo run` binary has
  no embedded framework and also degrades to no updater. For UI-only testing,
  start the watcher with `TIDE_PREVIEW_UPDATE=1`; the sidebar immediately
  shows an available update and clicking it changes to the spinner without
  installing anything. The preview flag fakes only that sidebar result;
  **Check for Updates…** still uses the embedded Sparkle framework and its
  real standard window.
- **Automatic and explicit checks have separate presentation.** Scheduled
  checks stay silent until the sidebar update button appears. Choosing
  **Check for Updates…** promotes an existing silent result into Sparkle's
  standard updater window, or shows its checking progress while an automatic
  check finishes. With no automatic session active, it starts Sparkle's
  standard user-initiated check directly.
- **First-run consent:** Sparkle shows its one-time "check automatically?"
  prompt on the second launch. The Settings → General toggle reads and writes
  the same persisted value.
- **Tide isn't sandboxed**, so Sparkle's XPC services are unnecessary;
  `bundle.sh` strips them (plus headers/modules) from the embedded framework
  and re-signs the rest with the app's identity — hardened-runtime library
  validation requires the identities to match.
- **Old release assets stay published** so far-behind users can still be
  served; only the recent history is staged locally under `dist/updates/`
  (git-ignored).
- **Platform artifacts:** keep asset names flat and platform-tagged — today's
  macOS names (`Tide-<v>.dmg`, `Tide-<v>.zip`, `appcast.xml`) must keep their
  URLs. Linux CI releases produce `.deb`/`.rpm`/`.AppImage` with
  `scripts/bundle-linux.sh`, Windows CI produces the portable zip and
  `Tide-<v>-<arch>-Setup.exe` with `scripts/bundle-windows.ts`, all attached to
  the GitHub release. Windows also updates itself from
  `appcast-windows-<arch>.xml`. Automatic Linux updates are still
  not wired — installing the new package is the upgrade path, and
  `latest-linux.txt` is how a client learns what "latest" means.
  `src/updater.rs` is the per-platform seam, and everything
  mac-specific in the existing release pipeline lives behind the Darwin guard
  in `scripts/release.ts` plus `scripts/bundle.sh`.
