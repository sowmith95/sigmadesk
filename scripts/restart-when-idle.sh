#!/bin/sh
# Restart the desk service the first time no seat is working (two consecutive idle polls), so no run is cut off.
# Usage: scripts/restart-when-idle.sh [service-name] [port] [max-minutes]
NAME=${1:-default}; PORT=${2:-8790}; MAX=${3:-240}
end=$(( $(date +%s) + MAX * 60 )); idle=0
while [ "$(date +%s)" -lt "$end" ]; do
  n=$(curl -s -m 5 "http://127.0.0.1:$PORT/api/state" | python3 -c "import sys,json; print(sum(1 for a in json.load(sys.stdin)['agents'] if a['status']=='working'))" 2>/dev/null || echo 1)
  if [ "$n" = "0" ]; then idle=$((idle + 1)); else idle=0; fi
  if [ "$idle" -ge 2 ]; then
    case "$(uname -s)" in
      Darwin) launchctl kickstart -k "gui/$(id -u)/com.sigmadesk.$NAME" ;;
      Linux) systemctl --user restart "sigmadesk-$NAME.service" ;;
    esac
    echo "restarted at $(date -u +%H:%M:%S)"; exit 0
  fi
  sleep 20
done
echo "gave up after $MAX minutes (desk never idle)"; exit 1
