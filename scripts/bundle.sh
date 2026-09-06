#!/bin/sh
set -eu

profile="${1:-debug}"
cargo_target_dir="${CARGO_TARGET_DIR:-target}"
if [ -n "${TIDE_CODESIGN_IDENTITY:-}" ]; then
  codesign_identity="$TIDE_CODESIGN_IDENTITY"
else
  # Ad-hoc by default: without a paid Apple Developer Program membership there
  # is no Developer ID identity, and an Apple Development certificate is worse
  # than useless here — its bundles are refused at spawn without provisioning
  # and untrusted on every other Mac. Release scripts pass an explicit
  # identity via TIDE_CODESIGN_IDENTITY when one exists.
  codesign_identity=""
  if [ "$profile" = "release" ]; then
    codesign_identity=$(security find-identity -v -p codesigning 2>/dev/null \
      | awk -v identity="Developer ID Application:" 'index($0, "\"" identity) { print $2; exit }')
  fi
  if [ -z "$codesign_identity" ]; then
    codesign_identity="-"
  fi
fi
case "$profile" in
  debug)
    app_name="Tide Debug"
    helper_name="Tide Debug Computer Use"
    bundle_identifier="codes.tide.dev"
    icon_file="AppIconDev.icns"
    ;;
  release)
    app_name="Tide"
    helper_name="Tide Computer Use"
    bundle_identifier="codes.tide"
    icon_file="AppIcon.icns"
    ;;
  *)
    echo "usage: scripts/bundle.sh [debug|release]" >&2
    exit 2
    ;;
esac
debug_adhoc_requirement="=designated => identifier \"$bundle_identifier\""
if [ "${TIDE_SKIP_CARGO_BUILD:-0}" != "1" ]; then
  if [ "$profile" = "release" ]; then
    cargo build --release --package tide --bin tide --bin tide_js_repl
  else
    cargo build --package tide --bin tide --bin tide_js_repl
  fi
fi

bundle="$cargo_target_dir/$profile/$app_name.app"
contents="$bundle/Contents"
helper_bundle="$contents/Helpers/$helper_name.app"
repl_executable="$contents/Resources/tide_js_repl"
swift_module_cache="$cargo_target_dir/$profile/swift-module-cache"
helper_source="resources/computer-use/TideComputerUse.swift"
helper_kit_dir="resources/computer-use/kit"
menu_bar_cursor_resource="resources/computer-use/menubar-cursor.png"
overlay_cursor_resource="resources/computer-use/overlay-cursor.svg"
# The vendored Open Computer Use kit (MIT — see kit/LICENSE) compiles into
# the helper as part of the same module; every kit source participates in
# the fingerprint so a kit edit always rebuilds and reinstalls the helper.
helper_kit_sources=$(ls "$helper_kit_dir"/*.swift | sort)
helper_fingerprint="$({
  shasum -a 256 \
    "$helper_source" \
    $helper_kit_sources \
    resources/computer-use/Info.plist \
    "$menu_bar_cursor_resource" \
    "$overlay_cursor_resource"
  printf '%s\n' "standalone-service-v3" "$helper_name" "$bundle_identifier.computer-use" "$codesign_identity" "$(uname -m)-apple-macos14.0"
  xcrun swiftc -version
} | shasum -a 256 | awk '{ print $1 }')"
helper_cache_root=".tide-cache/computer-use/$profile"
helper_cache_entry="$helper_cache_root/$helper_fingerprint"
cached_helper_bundle="$helper_cache_entry/$helper_name.app"

# Keep compiled helpers outside target so `cargo clean` does not force an
# unnecessary Swift rebuild. The fingerprint includes the signing identity so
# switching certificates can never reuse a helper signed as different code.
# The cached app is copied into Tide's standard Helpers directory as the
# canonical packaged service. Tide refreshes a stable standalone runtime copy
# from it so Screen Recording is attributed to the helper rather than Tide.

if [ ! -d "$cached_helper_bundle" ]; then
  helper_cache_staging="$helper_cache_root/.staging-$helper_fingerprint-$$"
  rm -rf "$helper_cache_staging"
  cached_helper_staging="$helper_cache_staging/$helper_name.app"
  cached_helper_contents="$cached_helper_staging/Contents"
  mkdir -p "$cached_helper_contents/MacOS" "$cached_helper_contents/Resources" "$swift_module_cache"
  cp resources/computer-use/Info.plist "$cached_helper_contents/Info.plist"
  cp "$menu_bar_cursor_resource" "$overlay_cursor_resource" "$cached_helper_contents/Resources/"
  printf '%s\n' "$helper_fingerprint" > "$cached_helper_contents/Resources/.tide-helper-fingerprint"
  plutil -replace CFBundleDisplayName -string "$helper_name" "$cached_helper_contents/Info.plist"
  plutil -replace CFBundleExecutable -string "$helper_name" "$cached_helper_contents/Info.plist"
  plutil -replace CFBundleIdentifier -string "$bundle_identifier.computer-use" "$cached_helper_contents/Info.plist"
  plutil -replace CFBundleName -string "$helper_name" "$cached_helper_contents/Info.plist"
  xcrun swiftc \
    -O \
    -parse-as-library \
    -module-cache-path "$swift_module_cache" \
    -target "$(uname -m)-apple-macos14.0" \
    "$helper_source" \
    $helper_kit_sources \
    -o "$cached_helper_contents/MacOS/$helper_name"
  if [ "$codesign_identity" = "-" ]; then
    codesign --force --sign - "$cached_helper_staging"
  elif [ "$profile" = "release" ]; then
    codesign --force --options runtime --timestamp --sign "$codesign_identity" "$cached_helper_staging"
  else
    codesign --force --options runtime --sign "$codesign_identity" "$cached_helper_staging"
  fi
  mkdir -p "$helper_cache_root"
  mv "$helper_cache_staging" "$helper_cache_entry"
fi

# Sparkle powers in-app updates. The framework is embedded in the bundle and
# the same distribution's bin/ tools (generate_appcast, sign_update) sign
# releases, so both come from one pinned archive cached outside target/ where
# `cargo clean` cannot evict it. Bump the version and checksum together.
sparkle_version="2.9.4"
sparkle_sha256="ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9"
sparkle_cache_root=".tide-cache/sparkle"
sparkle_cache_entry="$sparkle_cache_root/$sparkle_version"
sparkle_framework_source="$sparkle_cache_entry/Sparkle.framework"

if [ ! -d "$sparkle_framework_source" ]; then
  sparkle_staging="$sparkle_cache_root/.staging-$sparkle_version-$$"
  rm -rf "$sparkle_staging"
  mkdir -p "$sparkle_staging"
  sparkle_archive="$sparkle_staging/Sparkle-$sparkle_version.tar.xz"
  curl -fsSL --retry 3 -o "$sparkle_archive" \
    "https://github.com/sparkle-project/Sparkle/releases/download/$sparkle_version/Sparkle-$sparkle_version.tar.xz"
  echo "$sparkle_sha256  $sparkle_archive" | shasum -a 256 -c - >/dev/null
  tar -xJf "$sparkle_archive" -C "$sparkle_staging" ./Sparkle.framework ./bin
  rm "$sparkle_archive"
  mv "$sparkle_staging" "$sparkle_cache_entry"
fi

rm -rf "$bundle"
mkdir -p "$contents/MacOS" "$contents/Resources/computer-use" "$contents/Resources/skills/tide-computer-use" "$contents/Helpers"
cp "$cargo_target_dir/$profile/tide" "$contents/MacOS/$app_name"
cp "$cargo_target_dir/$profile/tide_js_repl" "$repl_executable"
chmod 755 "$repl_executable"
cp resources/Info.plist "$contents/Info.plist"
cp "resources/$icon_file" "$contents/Resources/AppIcon.icns"
cp resources/computer-use/pi-extension.ts "$contents/Resources/computer-use/pi-extension.ts"
cp resources/computer-use/SKILL.md "$contents/Resources/skills/tide-computer-use/SKILL.md"
frameworks_directory="$contents/Frameworks"
sparkle_framework="$frameworks_directory/Sparkle.framework"
mkdir -p "$frameworks_directory"
cp -R "$sparkle_framework_source" "$sparkle_framework"
# Tide is not sandboxed, so Sparkle's XPC services never run; drop them along
# with the header and module folders so the shipped framework carries no dev
# artifacts and no unsigned nested code.
for sparkle_extra in XPCServices Headers PrivateHeaders Modules; do
  rm -rf "$sparkle_framework/$sparkle_extra" \
    "$sparkle_framework/Versions/B/$sparkle_extra"
done
plutil -replace CFBundleDisplayName -string "$app_name" "$contents/Info.plist"
plutil -replace CFBundleExecutable -string "$app_name" "$contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$bundle_identifier" "$contents/Info.plist"
plutil -replace CFBundleName -string "$app_name" "$contents/Info.plist"
cp -R "$cached_helper_bundle" "$helper_bundle"
# Finder info and resource forks on copied resources make codesign reject the
# bundle as "detritus"; strip extended attributes before signing.
xattr -cr "$bundle"
# Sparkle's nested executables sign first, then the framework, then the app.
# The app's hardened runtime enforces library validation, so the framework must
# carry the same identity as the app or dlopen rejects it at launch.
if [ "$codesign_identity" = "-" ]; then
  codesign --force --sign - "$sparkle_framework/Versions/B/Autoupdate"
  codesign --force --sign - "$sparkle_framework/Versions/B/Updater.app"
  codesign --force --sign - "$sparkle_framework"
  codesign --force --identifier "$bundle_identifier.js-repl" --sign - "$repl_executable"
  if [ "$profile" = "debug" ]; then
    # An ordinary ad-hoc signature's designated requirement contains its
    # changing code hash, so macOS TCC treats every rebuild as a different app
    # and repeatedly asks for Files & Folders access. The development-only
    # bundle id is a stable local identity even when no trusted Apple
    # Development certificate is installed.
    codesign --force --identifier "$bundle_identifier" --requirements "$debug_adhoc_requirement" --sign - "$bundle"
  else
    codesign --force --sign - "$bundle"
  fi
elif [ "$profile" = "release" ]; then
  codesign --force --options runtime --timestamp --sign "$codesign_identity" "$sparkle_framework/Versions/B/Autoupdate"
  codesign --force --options runtime --timestamp --sign "$codesign_identity" "$sparkle_framework/Versions/B/Updater.app"
  codesign --force --options runtime --timestamp --sign "$codesign_identity" "$sparkle_framework"
  codesign --force --options runtime --timestamp --identifier "$bundle_identifier.js-repl" --sign "$codesign_identity" "$repl_executable"
  codesign --force --options runtime --timestamp --sign "$codesign_identity" "$bundle"
else
  # Debug with a real identity: no hardened runtime. A development-signed
  # bundle with runtime enabled but no provisioning profile is refused by
  # launchd at spawn (RBS error 5 / POSIX 163), and runtime buys a local
  # debug build nothing.
  codesign --force --sign "$codesign_identity" "$sparkle_framework/Versions/B/Autoupdate"
  codesign --force --sign "$codesign_identity" "$sparkle_framework/Versions/B/Updater.app"
  codesign --force --sign "$codesign_identity" "$sparkle_framework"
  codesign --force --identifier "$bundle_identifier.js-repl" --sign "$codesign_identity" "$repl_executable"
  codesign --force --sign "$codesign_identity" "$bundle"
fi
if [ "$profile" = "release" ]; then
  codesign --verify --strict --verbose=2 "$repl_executable"
  codesign --verify --deep --strict --verbose=2 "$bundle"
fi

echo "$bundle"
