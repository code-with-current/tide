# Homebrew Cask for Tide (published to our own tap,
# code-with-current/homebrew-tap, by .github/workflows/release-pkgs.yml).
#
# Markers filled by packaging/render.mjs: VERSION, SHA256_ARM64, SHA256_X64.

cask "tide" do
  version "@@VERSION@@"

  on_arm do
    url "https://github.com/code-with-current/tide/releases/download/v#{version}/Tide_#{version}_aarch64.dmg"
    sha256 "@@SHA256_ARM64@@"
  end
  on_intel do
    url "https://github.com/code-with-current/tide/releases/download/v#{version}/Tide_#{version}_x64.dmg"
    sha256 "@@SHA256_X64@@"
  end
  name "Tide"
  desc "Local-first agentic coding companion"
  homepage "https://tide.codes/"

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
