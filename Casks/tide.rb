cask "tide" do
  version "0.1.0-beta"

  url "https://github.com/code-with-current/tide/releases/download/v#{version}/tide-v#{version}-mac-arm64.dmg"
  sha256 "417df5c106541bc58048354bf429b76161639348c51c968b34efa871920dc2fe"

  depends_on arch: :arm64

  name "Tide"
  desc "Local-first agentic coding companion"
  homepage "https://tide.codes/"

  # The .app is ad-hoc signed (no Apple Developer ID). Homebrew installs
  # casks without quarantine, which suppresses the Gatekeeper prompt.
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
