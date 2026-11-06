#!/usr/bin/env sh
# Start the OpenCode cache-hit dashboard in the background.
#
# Usage:
#   ./start.sh                 # http://127.0.0.1:8788
#   PORT=9000 ./start.sh       # custom port
#   HOST=0.0.0.0 ./start.sh    # expose on the LAN (no auth: trusted networks only)
#
# Logs and the PID file stay next to this script.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT=${PORT:-8788}
HOST=${HOST:-127.0.0.1}
PIDFILE="$DIR/.dashboard.pid"
LOGFILE="$DIR/.dashboard.log"

if [ ! -f "$DIR/server.mjs" ]; then
  echo "server.mjs not found next to start.sh" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found in PATH (Node 18+ required)" >&2
  exit 1
fi

if [ -f "$PIDFILE" ]; then
  old=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -n "${old:-}" ] && kill -0 "$old" 2>/dev/null; then
    echo "already running (pid $old): http://$HOST:$PORT"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

nohup node "$DIR/server.mjs" --port "$PORT" --host "$HOST" >"$LOGFILE" 2>&1 &
pid=$!
echo "$pid" >"$PIDFILE"
sleep 1

if kill -0 "$pid" 2>/dev/null; then
  echo "dashboard: http://$HOST:$PORT (pid $pid)"
  echo "log: $LOGFILE"
else
  echo "dashboard failed to start; last log lines:" >&2
  tail -n 20 "$LOGFILE" >&2 || true
  rm -f "$PIDFILE"
  exit 1
fi
