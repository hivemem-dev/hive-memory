#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

npm install --prefix "$SCRIPT_DIR"

echo "Installation complete. The database is created automatically on first server run."
echo
echo "Add this to ~/.claude.json under \"mcpServers\":"
cat <<EOF
{
  "mcpServers": {
    "hive-memory": {
      "command": "node",
      "args": ["$SCRIPT_DIR/server.js"],
      "env": {
        "HIVE_MEMORY_AGENT": "claude-code",
        "HIVE_MEMORY_PROJECT": "$SCRIPT_DIR"
      }
    }
  }
}
EOF
echo
echo "Then restart Claude Code."
echo
echo "To attach hive-memory hooks to an agent yourself:"
echo "  node \"$SCRIPT_DIR/cli.js\" status"
echo "  node \"$SCRIPT_DIR/cli.js\" attach <claude-code|cursor|codex|all>"
echo
echo "Optional: run a background watcher that detects installed agents (Claude"
echo "Code, Cursor, Codex) via fs.watch and prints which cli.js attach command"
echo "to run - it never edits configs on its own:"
echo "  screen -dmS hive-memory-watcher node --max-old-space-size=64 \"$SCRIPT_DIR/watcher.js\""
