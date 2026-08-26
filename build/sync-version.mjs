import { readFileSync, writeFileSync } from "node:fs";
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const version = cargo.match(/^\[workspace\.package\][^\[]*?version = "([^"]+)"/m)?.[1];
if (!version) throw new Error("workspace version not found");
const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
if (conf.version !== version) {
  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
  console.log(`synced tauri.conf.json -> ${version}`);
}
