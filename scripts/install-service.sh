#!/bin/sh
# Install SigmaDesk as a background service: launchd on macOS, a systemd user unit on Linux.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=${1:-default}
NODE=$(command -v node)
mkdir -p "$ROOT/data"
case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.sigmadesk.$NAME.plist"
    sed -e "s|__ROOT__|$ROOT|g" -e "s|__NODE__|$NODE|g" -e "s|__PATH__|$PATH|g" -e "s|__HOME__|$HOME|g" -e "s|__NAME__|$NAME|g" \
      "$ROOT/launchd/com.sigmadesk.plist.template" > "$PLIST"
    launchctl bootout "gui/$(id -u)/com.sigmadesk.$NAME" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Installed $PLIST (logs: $ROOT/data/sigmadesk.log)"
    echo "Stop: launchctl bootout gui/$(id -u)/com.sigmadesk.$NAME"
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/sigmadesk-$NAME.service"
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNIT
[Unit]
Description=SigmaDesk ($NAME)
After=network-online.target

[Service]
WorkingDirectory=$ROOT
Environment=PATH=$PATH
ExecStart=$NODE --disable-warning=ExperimentalWarning $ROOT/src/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now "sigmadesk-$NAME.service"
    echo "Installed $UNIT — logs: journalctl --user -u sigmadesk-$NAME -f"
    ;;
  *) echo "unsupported OS"; exit 1 ;;
esac
