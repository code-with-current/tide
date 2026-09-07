cask "tide" do
  version "0.1.16"

  url "https://github.com/code-with-current/tide/releases/download/v#{version}/tide-v#{version}-mac-arm64.dmg",
      verified: "github.com/code-with-current/tide/releases/"
  sha256 "2e64bffe8a7abf252e16aceb16724635b1816c186ae1788eb1070c0016736494"

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
