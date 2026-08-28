import { readFileSync, writeFileSync } from "node:fs";

const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const version = cargo.match(/^\[workspace\.package\][^\[]*?version = "([^"]+)"/m)?.[1];
if (!version) throw new Error("workspace version not found");

const check = process.argv.includes("--check");
const targets = [
  ["src-tauri/tauri.conf.json", (c) => JSON.parse(c), (c, v) => ({ ...c, version: v }), (c) => c.version],
  ["package.json", (p) => JSON.parse(p), (p, v) => ({ ...p, version: v }), (p) => p.version],
];

let changed = false;
const mismatches = [];
for (const [path, parse, update, read] of targets) {
  const doc = parse(readFileSync(path, "utf8"));
  if (read(doc) === version) continue;
  mismatches.push(`${path}: ${read(doc)} != Cargo workspace ${version}`);
  if (!check) {
    writeFileSync(path, JSON.stringify(update(doc, version), null, 2) + "\n");
    console.log(`synced ${path} -> ${version}`);
    changed = true;
  }
}
if (check && mismatches.length) {
  for (const line of mismatches) console.error(line);
  process.exit(1);
}
if (!changed && !check) console.log(`all version files already at ${version}`);
