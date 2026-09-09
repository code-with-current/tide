#!/usr/bin/env bash
#
# Build the Linux release packages: deb, rpm, and AppImage, all from one
# staged FHS tree.
#
# Usage:
#   scripts/bundle-linux.sh
#
# Output (in $CARGO_TARGET_DIR/release/):
#   tide-v<version>-linux-x64.deb / .rpm / .AppImage   (or arm64)
#
# Requires: cargo, dpkg-deb, rpmbuild (apt install rpm), and network access
# for the appimagetool download. Binary packages embed the raw semver in the
# filename; the deb/rpm control versions turn prereleases into tilde form so
# 0.4.0~beta.2 sorts strictly before 0.4.0.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

target_dir="${CARGO_TARGET_DIR:-target}"
version="$(cargo metadata --no-deps --format-version 1 | sed -n 's/.*"name":"tide","version":"\([^"]*\)".*/\1/p')"
package_version="${version//-/~}"

host_arch="$(uname -m)"
case "$host_arch" in
  x86_64)
    file_arch=x64
    deb_arch=amd64
    rpm_arch=x86_64
    appimage_arch=x86_64
    ;;
  aarch64)
    file_arch=arm64
    deb_arch=arm64
    rpm_arch=aarch64
    appimage_arch=aarch64
    ;;
  *)
    echo "unsupported architecture: $host_arch" >&2
    exit 1
    ;;
esac

release_dir="$target_dir/release"
prefix="tide-v${version}-linux-${file_arch}"
description="A fast, native control plane for local coding agents"

cargo build --locked --release --package tide --bin tide

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT

# The FHS tree every package format stages from. `dpkg -x` into a snap and
# appimagetool over an AppDir both consume this same layout.
tree="$staging/tree"
install -Dm755 "$release_dir/tide" "$tree/usr/bin/tide"
install -Dm644 resources/linux/codes.tide.desktop \
  "$tree/usr/share/applications/codes.tide.desktop"
install -Dm644 resources/linux/app-icon.png \
  "$tree/usr/share/icons/hicolor/256x256/apps/codes.tide.png"
install -Dm644 LICENSE "$tree/usr/share/licenses/tide/LICENSE"

# --- deb ------------------------------------------------------------------

deb_root="$staging/deb"
mkdir -p "$deb_root/DEBIAN"
cp -R "$tree/." "$deb_root/"
cat > "$deb_root/DEBIAN/control" <<EOF
Package: tide
Version: ${package_version}
Section: devel
Priority: optional
Architecture: ${deb_arch}
Maintainer: Tide <contact@tide.codes>
Depends: libfontconfig1, libxkbcommon-x11-0, libvulkan1
Homepage: https://tide.codes
Description: ${description}
EOF
dpkg-deb --build --root-owner-group "$deb_root" "$release_dir/$prefix.deb"

# --- rpm ------------------------------------------------------------------

rpm_top="$staging/rpm-top"
mkdir -p "$rpm_top/BUILD" "$rpm_top/RPMS" "$rpm_top/SOURCES" "$rpm_top/SPECS" "$rpm_top/SRPMS"
cp -R "$tree" "$staging/rpm-root"
cat > "$rpm_top/SPECS/tide.spec" <<EOF
Name:           tide
Version:        ${package_version}
Release:        1
Summary:        ${description}
License:        GPL-3.0-only
URL:            https://tide.codes
BuildArch:      ${rpm_arch}
AutoReqProv:    no

%description
${description}

%files
/usr/bin/tide
/usr/share/applications/codes.tide.desktop
/usr/share/icons/hicolor/256x256/apps/codes.tide.png
/usr/share/licenses/tide/LICENSE
EOF
rpmbuild -bb --quiet \
  --define "_topdir $rpm_top" \
  --buildroot "$staging/rpm-root" \
  "$rpm_top/SPECS/tide.spec"
mv "$rpm_top/RPMS"/*/*.rpm "$release_dir/$prefix.rpm"

# --- AppImage -------------------------------------------------------------

appdir="$staging/AppDir"
mkdir -p "$appdir"
cp -R "$tree/." "$appdir/"
cp "$tree/usr/share/applications/codes.tide.desktop" "$appdir/codes.tide.desktop"
# The AppDir desktop entry must point at the in-bundle path; the staged copy
# keeps Exec=tide for system installs.
sed -i 's/^Exec=tide$/Exec=usr\/bin\/tide/' "$appdir/codes.tide.desktop"
cp "$tree/usr/share/icons/hicolor/256x256/apps/codes.tide.png" "$appdir/codes.tide.png"
ln -s codes.tide.png "$appdir/.DirIcon"
cat > "$appdir/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/tide" "$@"
EOF
chmod 755 "$appdir/AppRun"

appimagetool="$staging/appimagetool-${appimage_arch}.AppImage"
curl -fsSL --retry 3 -o "$appimagetool" \
  "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${appimage_arch}.AppImage"
chmod 755 "$appimagetool"
# --appimage-extract-and-run: CI runners have no FUSE, so the tool unpacks
# itself before packing.
ARCH="$appimage_arch" "$appimagetool" --appimage-extract-and-run \
  "$appdir" "$release_dir/$prefix.AppImage"

printf 'Created %s.deb, %s.rpm, %s.AppImage\n' "$release_dir/$prefix" "$release_dir/$prefix" "$release_dir/$prefix"
