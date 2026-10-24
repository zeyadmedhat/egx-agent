#!/bin/bash
# Double-click this file to stop the EGX Trading Agent dashboard, however it was started.
cd "$(dirname "$0")" || exit 1

stopped=""
# The dashboard.
for pattern in "python -m app.server"; do
  if pkill -f "$pattern"; then
    stopped=1
    for _ in 1 2 3 4 5; do
      pgrep -f "$pattern" >/dev/null || break
      sleep 1
    done
    pkill -9 -f "$pattern" 2>/dev/null
  fi
done

if [ -n "$stopped" ]; then
  echo "EGX Trading Agent stopped."
else
  echo "EGX Trading Agent was not running."
fi
sleep 2
