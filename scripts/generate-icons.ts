#!/usr/bin/env bun
//
// Regenerate the native app icons from their master PNGs.
//
// Usage:
//   bun scripts/generate-icons.ts [release-master.png] [dev-master.png]
//
// With no arguments it uses resources/master.png and, when present,
// resources/master-dev.png (the red debug tint). From the release master it
// writes every platform artifact the build steps consume as-is:
//
//   resources/AppIcon.icns          macOS bundle icon (scripts/bundle.sh copies
//                                   it into Tide.app/Contents/Resources)
//   resources/windows/AppIcon.ico   PE icon (build.rs embeds it via an .rc)
//   resources/linux/app-icon.png    256x256 hicolor icon (bundle-linux.sh)
//
// and, when a dev master is given, resources/AppIconDev.icns — the debug app's
// dock icon, so "Tide Debug" is distinguishable from "Tide" at a glance.
//
// macOS only: needs `sips` and `iconutil`. Masters should be 1024x1024; a
// smaller one is upscaled (with a warning) so run this again with a
// high-resolution master when one becomes available.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dir, "..");

/** The full iconset table `iconutil` expects, size → file name. */
const ICONSET_SIZES: Array<[size: number, name: string]> = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

/** Sizes baked into the Windows icon. The committed one carries exactly these
 *  seven as PNG-compressed entries, so keep the set identical. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function run(tool: string, args: string[]): void {
  const result = spawnSync(tool, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${tool} ${args.join(" ")} failed` +
        (result.stderr?.trim() ? `: ${result.stderr.trim()}` : ""),
    );
  }
}

/** Render `master` as a square PNG of `size` px at `out`. */
function render(master: string, size: number, out: string): void {
  run("sips", ["-s", "format", "png", "-z", `${size}`, `${size}`, master, "--out", out]);
}

function masterPixelWidth(master: string): number {
  const result = spawnSync("sips", ["-g", "pixelWidth", master], { encoding: "utf8" });
  return Number(result.stdout.match(/pixelWidth: (\d+)/)?.[1] ?? 0);
}

/** Build an .icns from `master` through a temporary iconset. */
function buildIcns(master: string, out: string): void {
  const work = mkdtempSync(join(tmpdir(), "tide-icons-"));
  try {
    const iconset = join(work, "AppIcon.iconset");
    mkdirSync(iconset);
    for (const [size, name] of ICONSET_SIZES) render(master, size, join(iconset, name));
    // iconutil fails with a bare "Failed to generate ICNS" when -o lands on
    // some mounted volumes (an external APFS volume mounted noowners does it)
    // even though plain writes there succeed — so stage next to the iconset
    // and copy the finished file into place.
    const staged = join(work, "AppIcon.icns");
    run("iconutil", ["-c", "icns", iconset, "-o", staged]);
    copyFileSync(staged, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Pack rendered PNGs into an .ico with PNG-compressed entries — the same
 *  layout Explorer has read from Tide's PE all along (Vista and later). */
function packIco(entries: Array<{ size: number; png: Buffer }>): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const table = Buffer.alloc(16 * entries.length);
  let offset = header.length + table.length;
  entries.forEach((entry, index) => {
    // 256 is encoded as 0 — the single size that does not fit a byte.
    const dimension = entry.size === 256 ? 0 : entry.size;
    const base = index * 16;
    table.writeUInt8(dimension, base);
    table.writeUInt8(dimension, base + 1);
    table.writeUInt8(0, base + 2); // palette color count
    table.writeUInt8(0, base + 3); // reserved
    table.writeUInt16LE(1, base + 4); // color planes
    table.writeUInt16LE(32, base + 6); // bits per pixel
    table.writeUInt32LE(entry.png.length, base + 8);
    table.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, table, ...entries.map((entry) => entry.png)]);
}

function buildIco(master: string, out: string): void {
  const work = mkdtempSync(join(tmpdir(), "tide-ico-"));
  try {
    const entries = ICO_SIZES.map((size) => {
      const png = join(work, `${size}.png`);
      render(master, size, png);
      return { size, png: readFileSync(png) };
    });
    writeFileSync(out, packIco(entries));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const [releaseMaster, devMaster] = process.argv.slice(2).map((arg) => resolve(arg));

const defaultRelease = join(projectRoot, "resources", "master.png");
const defaultDev = join(projectRoot, "resources", "master-dev.png");
const release = releaseMaster ?? defaultRelease;
const dev = devMaster ?? (existsSync(defaultDev) ? defaultDev : undefined);

if (!existsSync(release)) {
  console.error(
    `usage: bun scripts/generate-icons.ts [release-master.png] [dev-master.png]\n` +
      `no master found at ${release}`,
  );
  process.exit(1);
}

if (process.platform !== "darwin") {
  console.error("generate-icons.ts needs macOS tooling (sips + iconutil)");
  process.exit(1);
}

const width = masterPixelWidth(release);
if (width < 1024) {
  console.warn(
    `warning: ${release} is ${width}x${width}; sizes above it (512, 1024) are ` +
      `upscaled. Re-run with a 1024x1024 master for crisp large icons.`,
  );
}

const resources = join(projectRoot, "resources");
buildIcns(release, join(resources, "AppIcon.icns"));
console.log(`Wrote ${join(resources, "AppIcon.icns")}`);

buildIco(release, join(resources, "windows", "AppIcon.ico"));
console.log(`Wrote ${join(resources, "windows", "AppIcon.ico")}`);

const linuxIcon = join(resources, "linux", "app-icon.png");
render(release, 256, linuxIcon);
console.log(`Wrote ${linuxIcon}`);

if (dev) {
  buildIcns(dev, join(resources, "AppIconDev.icns"));
  console.log(`Wrote ${join(resources, "AppIconDev.icns")}`);
}
