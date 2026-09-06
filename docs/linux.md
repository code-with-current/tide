# Tide on Linux

## Install

```sh
curl -fsSL https://tide.codes/install.sh | sh
```

The script needs no root. It unpacks the release tarball into
`~/.local/tide.app` and installs the desktop entry into
`~/.local/share/applications`, so **Tide appears in your applications menu** —
you can also launch it from a terminal via `tide` command. Run the script again to
upgrade; it replaces the previous install rather than merging into it.

Tide expects:

- **glibc 2.35 or newer** — Ubuntu 22.04, Debian 12, Fedora 36, and anything
  more recent. Releases are built on Ubuntu 22.04, so older distributions must
  build from source.
- **A working Vulkan or OpenGL driver.** Tide renders through wgpu, which tries
  Vulkan first and falls back to GL. Software rasterizers (lavapipe, llvmpipe)
  are accepted, so it can run in a VM, but see the note below.
- **x86_64 or aarch64.** Other architectures build from source.
- `xdg-desktop-portal` for native file dialogs.

Set `TIDE_VERSION` to install a specific version rather than the latest.

## Installing manually

The script is a convenience, not a requirement. Download
`tide-<version>-<target>.tar.gz` from
[releases.tide.codes](https://releases.tide.codes) or the
[GitHub release](https://github.com/code-with-current/page/releases), then unpack it
wherever you like:

```sh
mkdir -p ~/.local/tide.app
tar -xzf tide-<version>-<target>.tar.gz --strip-components=1 -C ~/.local/tide.app
ln -sf ~/.local/tide.app/bin/tide ~/.local/bin/tide   # optional
```

The archive uses an install-prefix layout (`bin/`, `share/`) beneath one
versioned directory, so `--strip-components=1` into a prefix such as
`/usr/local` works too.

**Keep `bin/` intact.** Tide launches `tide-daemon` from its own directory, so
copying `bin/tide` somewhere on its own leaves it unable to start the daemon.
A symlink is fine — Tide resolves it back to the real path.

Installing the desktop entry is the part that matters — it is how the app is
launched normally, and it is what associates the running window with its icon
and name (Tide reports the Wayland `app_id` / X11 `WM_CLASS` `codes.tide`, which
matches the entry's filename). Install the packaged file and point it at the
install (the packaged copy uses bare `Exec=tide` and `Icon=codes.tide` names so it
can be relocated):

```sh
install -D ~/.local/tide.app/share/applications/codes.tide.desktop \
  -t ~/.local/share/applications
sed -i "s|^Exec=tide$|Exec=$HOME/.local/tide.app/bin/tide|" \
  ~/.local/share/applications/codes.tide.desktop
sed -i "s|^Icon=codes.tide$|Icon=$HOME/.local/tide.app/share/icons/hicolor/256x256/apps/codes.tide.png|" \
  ~/.local/share/applications/codes.tide.desktop
```

## Updating

Tide does not update itself on Linux — Sparkle is macOS-only. Re-run the
install script to upgrade.

## Uninstalling

```sh
curl -fsSL https://tide.codes/install.sh | sh -s -- --uninstall
```

This removes `~/.local/tide.app`, the symlink, and the desktop entry. Projects
and settings stay in `~/.tide`; delete that directory to remove them too.

## Building from source

See [CONTRIBUTING.md](../CONTRIBUTING.md) for build prerequisites, then
produce the same archive this page installs with:

```sh
./scripts/bundle-linux.sh
```

To exercise the install script against that local build:

```sh
TIDE_BUNDLE_PATH=target/release/tide-<version>-<target>.tar.gz \
  sh website/public/install.sh
```

## Running in a virtual machine

VMs usually have no GPU passthrough, so Mesa falls back to a software
rasterizer. That works in principle — wgpu accepts a CPU adapter — but both
lavapipe (Vulkan) and llvmpipe (GL) JIT-compile shaders through LLVM, and that
path is fragile: on Fedora 44 aarch64 (mesa 26.0.3 + LLVM 22.1) it segfaults
inside `gallivm_jit_function` while compiling a fragment shader. The crash is
in the driver, not in Tide, and no application-side setting avoids it.

If the app dies on its first frame in a VM, check `coredumpctl info` for a
backtrace through `libvulkan_lvp.so` or `libgallium`. The reliable fix is to
give the guest a real GL driver — on UTM that means the QEMU backend with
virtio-gpu-gl (virgl) rather than Apple Virtualization, which offers Linux
guests no 3D at all. `VK_DRIVER_FILES=/nonexistent.json` hides the software
Vulkan driver so wgpu takes the GL path instead.
