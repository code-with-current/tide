#!/usr/bin/env bun
//
// Build and package the Windows release: a portable zip and the Inno Setup
// installer the in-app updater re-runs silently. Mirrors bundle-linux.sh for
// the archive half and resources/windows/tide.iss for the installer half.
//
// Usage:
//   bun scripts/bundle-windows.ts
//
// Env:
//   CARGO_TARGET_DIR              cargo target directory (default: target)
//   WINDOWS_CERTIFICATE           base64 Authenticode .pfx (optional)
//   WINDOWS_CERTIFICATE_PASSWORD  password for it
import { $ } from "bun";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageName = "tide";
const projectRoot = resolve(import.meta.dir, "..");

/** Release-asset naming (tide-v<version>-windows-<arch>), which shortens the
 *  Rust triple. The updater's feed names keep the Rust arch names instead. */
const architectureForTarget: Record<string, string> = {
  "x86_64-pc-windows-msvc": "x64",
  "aarch64-pc-windows-msvc": "arm64",
};

interface CargoMetadata {
  packages: { name: string; version: string }[];
}

/** Inno Setup's compiler, however it was installed. */
function findInnoSetupCompiler(): string {
  const onPath = Bun.which("ISCC.exe") ?? Bun.which("iscc");
  if (onPath) return onPath;
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!base) continue;
    const candidate = join(base, "Inno Setup 6", "ISCC.exe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "ISCC.exe was not found. Install Inno Setup 6 (choco install innosetup).",
  );
}

/** The newest signtool in the installed Windows SDKs, preferring the host's
 *  own architecture. An SDK lays these out as `bin\<version>\<arch>`, with
 *  older ones dropping the version directory. */
function findSigntool(): string {
  const root = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Windows Kits",
    "10",
    "bin",
  );
  if (!existsSync(root)) {
    throw new Error(`signtool.exe was not found: ${root} does not exist.`);
  }
  const versionOrder = new Intl.Collator("en", { numeric: true });
  const versions = readdirSync(root).sort((a, b) => versionOrder.compare(b, a));
  // arm64 Windows runs the x64 tool under emulation, so it stays as a
  // fallback rather than a failure.
  const architectures =
    process.arch === "arm64" ? ["arm64", "x64", "x86"] : ["x64", "x86"];
  for (const architecture of architectures) {
    for (const directory of [...versions.map((v) => join(root, v)), root]) {
      const candidate = join(directory, architecture, "signtool.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`signtool.exe was not found under ${root}.`);
}

async function sign(
  signtool: string,
  certificate: string,
  password: string,
  files: string[],
): Promise<void> {
  for (const file of files) {
    await $`${signtool} sign /f ${certificate} /p ${password} /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ${file}`;
  }
}

process.chdir(projectRoot);

if (process.platform !== "win32") {
  throw new Error(
    "bundle-windows.ts builds a native Windows release and must run on Windows.",
  );
}

const targetDirectory = resolve(process.env.CARGO_TARGET_DIR || "target");
const releaseDirectory = join(targetDirectory, "release");

const metadata = JSON.parse(
  await $`cargo metadata --no-deps --format-version 1`.quiet().text(),
) as CargoMetadata;
const version = metadata.packages.find(
  (candidate) => candidate.name === packageName,
)?.version;
if (!version) {
  throw new Error(`Cargo package "${packageName}" was not found.`);
}
// Inno's VersionInfoVersion must be plain x.x.x.x — a pre-release suffix like
// "-beta" is valid in AppVersion display strings but aborts the compile.
const numericVersion = version.replace(/[-+].*$/, "");

const hostLine = (await $`rustc -vV`.quiet().text())
  .split("\n")
  .find((line) => line.startsWith("host: "));
const targetTriple = hostLine?.slice("host: ".length).trim();
const architecture = targetTriple
  ? architectureForTarget[targetTriple]
  : undefined;
if (!targetTriple || !architecture) {
  throw new Error(`Unsupported Windows target ${targetTriple ?? "(unknown)"}`);
}

const artifactStem = `tide-v${version}-windows-${architecture}`;
const packageDirectoryName = artifactStem;
const archive = join(releaseDirectory, `${artifactStem}-portable.zip`);
const installer = join(releaseDirectory, `${artifactStem}-setup.exe`);

/** The onnxruntime build `ort` 2.0.0-rc.13 pins (see its dist.tsv). */
const onnxRuntimeVersion = "1.28.0";

/** ort rides `load-dynamic` on Windows: its prebuilt static libraries are
 *  compiled against the dynamic CRT, which cannot link into this app —
 *  `.cargo/config.toml` forces `+crt-static` so the install never needs the
 *  VC redistributable. Instead the official onnxruntime.dll ships alongside
 *  the exe (LoadLibrary searches the executable's directory first), together
 *  with the redistributable CRT DLLs that dll itself needs. */
async function stageOnnxRuntime(packageDirectory: string): Promise<void> {
  const flavor = process.arch === "arm64" ? "win-arm64" : "win-x64";
  const zip = join(staging, `onnxruntime-${flavor}.zip`);
  const response = await fetch(
    `https://github.com/microsoft/onnxruntime/releases/download/v${onnxRuntimeVersion}/onnxruntime-${flavor}-${onnxRuntimeVersion}.zip`,
  );
  if (!response.ok) {
    throw new Error(`onnxruntime download failed: HTTP ${response.status}`);
  }
  await writeFile(zip, Buffer.from(await response.arrayBuffer()));
  const extract = join(staging, "onnxruntime");
  await mkdir(extract, { recursive: true });
  await $`tar -xf ${zip} -C ${extract}`;
  const extractedRoot = join(
    extract,
    `onnxruntime-${flavor}-${onnxRuntimeVersion}`,
    "lib",
    "onnxruntime.dll",
  );
  await copyFile(extractedRoot, join(packageDirectory, "onnxruntime.dll"));

  // The redistributable CRT is already on every runner inside Visual Studio;
  // copying those exact files is what the vc_redist installer itself does.
  const crtDirectory = findRedistCrt(
    process.arch === "arm64" ? "arm64" : "x64",
  );
  for (const file of readdirSync(crtDirectory)) {
    if (file.endsWith(".dll")) {
      await copyFile(
        join(crtDirectory, file),
        join(packageDirectory, file),
      );
    }
  }
}

/** Locate the redistributable CRT DLLs (`VC\Redist\MSVC\…\<arch>\…CRT`).
 *  vswhere — the canonical discovery — first, then a scan of both Program
 *  Files roots across every year and edition, because runner images differ
 *  in where (and whether) they install the full VS layout. */
function findRedistCrt(arch: string): string {
  const order = new Intl.Collator("en", { numeric: true });
  const candidates: string[] = [];
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (existsSync(vswhere)) {
    const output = Bun.spawnSync([
      vswhere,
      "-latest",
      "-products",
      "*",
      "-property",
      "installationPath",
    ]);
    const installation = output.stdout.toString().trim().split("\r?\n")[0];
    if (installation) {
      candidates.push(join(installation, "VC", "Redist", "MSVC"));
    }
  }
  for (const root of [
    process.env["ProgramFiles"] ?? "C:\\Program Files",
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  ]) {
    const visualStudio = join(root, "Microsoft Visual Studio");
    if (!existsSync(visualStudio)) continue;
    for (const year of readdirSync(visualStudio)) {
      const yearDirectory = join(visualStudio, year);
      if (!existsSync(yearDirectory)) continue;
      for (const edition of readdirSync(yearDirectory)) {
        candidates.push(join(yearDirectory, edition, "VC", "Redist", "MSVC"));
      }
    }
  }
  for (const redist of candidates) {
    if (!existsSync(redist)) continue;
    for (const version of readdirSync(redist).sort((a, b) => order.compare(b, a))) {
      const candidate = join(redist, version, arch, "Microsoft.VC143.CRT");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`No VC redistributable CRT (${arch}) found on this machine.`);
}

await $`cargo build --locked --release --package tide --bin tide`;

const staging = await mkdtemp(join(tmpdir(), "tide-bundle-"));
try {
  // The backend is served in-process; the app binary is the whole package.
  const packageDirectory = join(staging, packageDirectoryName);
  await mkdir(packageDirectory, { recursive: true });
  await copyFile(join(releaseDirectory, "tide.exe"), join(packageDirectory, "tide.exe"));
  await copyFile(join(projectRoot, "LICENSE"), join(packageDirectory, "LICENSE"));
  await stageOnnxRuntime(packageDirectory);

  // Authenticode has to be applied before anything is packaged, so the
  // executables inside the zip and the installer are all signed. Unsigned
  // builds still package, so a fork without a certificate can release.
  const certificateData = process.env.WINDOWS_CERTIFICATE;
  const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
  let certificate: string | undefined;
  let signtool: string | undefined;
  if (certificateData && certificatePassword) {
    certificate = join(staging, "certificate.pfx");
    await writeFile(certificate, Buffer.from(certificateData, "base64"));
    signtool = findSigntool();
    await sign(signtool, certificate, certificatePassword, [
      join(packageDirectory, "tide.exe"),
    ]);
  } else {
    console.log("No WINDOWS_CERTIFICATE set; packaging unsigned binaries.");
  }

  await mkdir(releaseDirectory, { recursive: true });
  await rm(archive, { force: true });
  // Windows 10 1803 and later ship bsdtar, which writes a zip when the output
  // name says so — no PowerShell, and the same one-versioned-directory layout
  // the Linux tarball uses.
  await $`tar -a -c -f ${archive} -C ${staging} ${packageDirectoryName}`;
  console.log(`Created ${archive}`);

  // The installer is what the in-app updater downloads and re-runs, so it
  // ships from the same signed staging directory as the zip.
  await rm(installer, { force: true });
  await $`${findInnoSetupCompiler()} ${`/DAppVersion=${version}`} ${`/DNumericVersion=${numericVersion}`} ${`/DArch=${architecture}`} ${`/DStageDir=${packageDirectory}`} ${`/DOutputDir=${releaseDirectory}`} ${join(projectRoot, "resources", "windows", "tide.iss")}`;
  if (!existsSync(installer)) {
    throw new Error(`ISCC did not produce ${installer}`);
  }
  if (certificate && signtool && certificatePassword) {
    await sign(signtool, certificate, certificatePassword, [installer]);
  }
  console.log(`Created ${installer} (${statSync(installer).size} bytes)`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
