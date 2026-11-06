#!/usr/bin/env sh
# Stop the dashboard started by start.sh.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PIDFILE="$DIR/.dashboard.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "not running (no $PIDFILE; if you use systemd, run: systemctl --user stop opencode-cache-dashboard)"
  exit 0
fi

pid=$(cat "$PIDFILE" 2>/dev/null || true)
if [ -z "${pid:-}" ] || ! kill -0 "$pid" 2>/dev/null; then
  echo "not running (stale pid file)"
  rm -f "$PIDFILE"
  exit 0
fi

kill "$pid" 2>/dev/null || true
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do
  sleep 0.1
  i=$((i + 1))
done
if kill -0 "$pid" 2>/dev/null; then
  kill -9 "$pid" 2>/dev/null || true
fi
rm -f "$PIDFILE"
echo "stopped (pid $pid)"
