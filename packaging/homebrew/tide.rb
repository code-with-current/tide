# Homebrew Cask for Tide.
#
# First-time submission: PR this file to homebrew/homebrew-cask as
# Casks/t/tide.rb (https://github.com/Homebrew/homebrew-cask). Run
# `brew audit --cask tide` and `brew style Casks/t/tide.rb` locally first.
#
# After the cask is merged, subsequent releases are bumped automatically by
# .github/workflows/release-pkgs.yml (`brew bump-cask-pr`).
#
# Markers filled by packaging/render.mjs: VERSION, SHA256_ARM64.

cask "tide" do
  version "@@VERSION@@"

  sha256 "@@SHA256_ARM64@@"

  url "https://github.com/code-with-current/tide/releases/download/v#{version}/Tide-#{version}-arm64.dmg"
  name "Tide"
  desc "Local-first agentic coding companion"
  homepage "https://tide.codes/"

  # mac builds are arm64-only (no x64 dmg is published), so gate the cask
  # on Apple Silicon instead of an on_intel fallback.
  depends_on :macos
  depends_on arch: :arm64

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
