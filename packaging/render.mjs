#!/usr/bin/env bun
//
// Render the store packages for a published release: the Homebrew cask and
// the winget manifests, with checksums computed from the release's downloaded
// assets. Nothing here talks to the network — point --assets-dir at a
// directory populated by `gh release download`.
//
// Usage:
//   bun packaging/render.mjs --tag v0.4.0 --repo <owner/repo> \
//     --assets-dir <dir> [--homebrew-out <dir>] [--winget-out <dir>]
//
// Expects in --assets-dir:
//   tide-v<version>-mac-arm64.dmg          tide-v<version>-mac-x64.dmg
//   tide-v<version>-windows-x64-setup.exe  tide-v<version>-windows-arm64-setup.exe
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** The winget package identity. Changing it moves the package, not updates
 *  to it — treat it as frozen once a release has shipped. */
const wingetIdentifier = "Current.Tide";
const wingetPublisher = "Current";
const appDescription = "A fast, native control plane for local coding agents";
const homepage = "https://tide.codes";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    tag: { type: "string" },
    repo: { type: "string" },
    "assets-dir": { type: "string" },
    "homebrew-out": { type: "string" },
    "winget-out": { type: "string" },
  },
  strict: true,
});

if (!values.tag || !values.repo || !values["assets-dir"]) {
  console.error(
    "usage: bun packaging/render.mjs --tag v0.4.0 --repo owner/repo " +
      "--assets-dir dist [--homebrew-out tap] [--winget-out manifests]",
  );
  process.exit(1);
}

const tag = values.tag;
if (!/^v\d/.test(tag)) {
  throw new Error(`--tag must look like v0.4.0, got "${tag}"`);
}
const version = tag.slice(1);
const assetsDir = resolve(values["assets-dir"]);
const owner = values.repo.split("/")[0];
const downloadBase = `https://github.com/${values.repo}/releases/download/${tag}`;

async function sha256(name: string): Promise<string> {
  const path = join(assetsDir, name);
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  await new Promise<void>((fulfil, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => fulfil());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function requireAsset(name: string): string {
  const file = Bun.file(join(assetsDir, name));
  if (!file.exists()) {
    throw new Error(
      `Missing ${name} in ${assetsDir}. Download the release assets first:\n` +
        `  gh release download ${tag} --dir ${values["assets-dir"]}`,
    );
  }
  return name;
}

// --- Homebrew cask ---------------------------------------------------------

if (values["homebrew-out"]) {
  const dmgs = {
    arm64: requireAsset(`tide-${tag}-mac-arm64.dmg`),
    x64: requireAsset(`tide-${tag}-mac-x64.dmg`),
  };
  const sha = {
    arm64: await sha256(dmgs.arm64),
    x64: await sha256(dmgs.x64),
  };
  const cask = `# Homebrew Cask for Tide (published to our own tap,
# code-with-current/homebrew-tap, by .github/workflows/publish-stores.yml via
# packaging/render.mjs — do not hand-edit the version, URLs, or checksums).

cask "tide" do
  version "${version}"

  on_arm do
    url "${downloadBase}/tide-v#{version}-mac-arm64.dmg"
    sha256 "${sha.arm64}"
  end
  on_intel do
    url "${downloadBase}/tide-v#{version}-mac-x64.dmg"
    sha256 "${sha.x64}"
  end
  name "Tide"
  desc "Local-first agentic coding companion"
  homepage "${homepage}/"

  depends_on :macos

  # The .app is ad-hoc signed (no Apple Developer ID), so users see an
  # "unidentified developer" prompt on first launch. homebrew passes
  # --no-quarantine by default for casks, which suppresses Gatekeeper.
  app "Tide.app"

  zap trash: [
    "~/Library/Application Support/Tide",
    "~/Library/Application Support/com.tide.code",
    "~/Library/Caches/Tide",
    "~/Library/Caches/com.tide.code",
    "~/Library/Logs/Tide",
    "~/Library/Preferences/com.tide.code.plist",
    "~/Library/Saved Application State/com.tide.code.savedState",
    "~/Library/WebKit/com.tide.code",
  ]
end
`;
  const out = join(resolve(values["homebrew-out"]), "Casks", "tide.rb");
  await mkdir(join(out, ".."), { recursive: true });
  await writeFile(out, cask);
  console.log(`Wrote ${out}`);
}

// --- winget manifests ------------------------------------------------------

if (values["winget-out"]) {
  const installers = [
    { arch: "x64", file: requireAsset(`tide-${tag}-windows-x64-setup.exe`) },
    { arch: "arm64", file: requireAsset(`tide-${tag}-windows-arm64-setup.exe`) },
  ];
  const manifestDir = join(
    resolve(values["winget-out"]),
    // Winget's path scheme: manifests/<first-letter>/<Publisher>/<Package>/<version>
    "c",
    "Current",
    "Tide",
    version,
  );
  await mkdir(manifestDir, { recursive: true });

  const locale = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultlocale.1.6.0.schema.json
PackageIdentifier: ${wingetIdentifier}
PackageVersion: ${version}
PackageName: Tide
PackageUrl: https://github.com/${values.repo}
Publisher: ${wingetPublisher}
PublisherUrl: https://github.com/${owner}
PublisherSupportUrl: https://github.com/${values.repo}/issues
Author: ${wingetPublisher}
ShortDescription: ${appDescription}
Description: |-
  Tide is a fast, native desktop app for working with local coding agents.
  It runs its agent engine locally and keeps sessions, config, and the RAG
  index in place under ~/.tide.
License: GPL-3.0-only
LicenseUrl: https://github.com/${values.repo}/blob/HEAD/LICENSE
Copyright: Tide contributors
Tags:
  - coding-agents
  - ai
  - developer-tools
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`;

  const installerManifest = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
PackageIdentifier: ${wingetIdentifier}
PackageVersion: ${version}
Installers:
${installers
  .map(
    (entry) => `  - Architecture: ${entry.arch}
    InstallerUrl: ${downloadBase}/${entry.file}
    InstallerType: inno
    InstallerSha256: ${await sha256(entry.file)}
    Scope: user`,
  )
  .join("\n")}
InstallerSwitches:
  Silent: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
  SilentWithProgress: /SILENT /SUPPRESSMSGBOXES /NORESTART
UpgradeBehavior: install
ManifestType: installer
ManifestVersion: 1.6.0
`;

  const versionManifest = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json
PackageIdentifier: ${wingetIdentifier}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`;

  for (const [name, body] of [
    [`${wingetIdentifier}.yaml`, versionManifest],
    [`${wingetIdentifier}.locale.en-US.yaml`, locale],
    [`${wingetIdentifier}.installer.yaml`, installerManifest],
  ] as const) {
    const out = join(manifestDir, name);
    await writeFile(out, body);
    console.log(`Wrote ${out}`);
  }
}
