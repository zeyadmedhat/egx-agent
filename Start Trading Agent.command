#!/bin/bash
# Double-click this file to start the EGX Trading Agent dashboard in your browser.
cd "$(dirname "$0")" || exit 1
echo "EGX Trading Agent: starting…"

pause_and_exit() { read -r -p "Press Enter to close this window…"; exit 1; }

PY=""
for c in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /opt/anaconda3/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$(command -v "$c")"; break; fi
done

if [ ! -x .venv/bin/python ]; then
  if [ -z "$PY" ]; then
    echo "Python 3 is not installed. Install it from https://www.python.org/downloads/ and double-click again."
    pause_and_exit
  fi
  echo "First run: setting up (about a minute)…"
  "$PY" -m venv .venv || { echo "Could not create the Python environment."; pause_and_exit; }
fi

REQ_HASH="$(shasum requirements.txt | cut -d' ' -f1)"
if [ "$(cat .venv/.req_hash 2>/dev/null)" != "$REQ_HASH" ]; then
  echo "Installing packages…"
  .venv/bin/python -m pip install --quiet --upgrade pip
  if .venv/bin/python -m pip install --quiet -r requirements.txt; then
    echo "$REQ_HASH" > .venv/.req_hash
  else
    echo "Package installation failed. Check your internet connection and try again."
    pause_and_exit
  fi
fi

URL="http://localhost:8501"
if curl -s "$URL/api/health" | grep -q egx-trading-agent; then
  echo "Already running (in another window or in the background). Opening your browser."
  echo "To stop it, double-click \"Stop Trading Agent.command\"."
  open "$URL"
  exit 0
fi

# The old Streamlit version of the dashboard may still be running on the same address: stop it first.
if pgrep -f "streamlit run app/main.py" >/dev/null; then
  echo "Stopping the old version of the dashboard…"
  pkill -f "streamlit run app/main.py"
  sleep 2
  pkill -9 -f "streamlit run app/main.py" 2>/dev/null
fi
if lsof -nP -iTCP:8501 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Another program is using port 8501. Close it (or restart your Mac) and double-click again."
  pause_and_exit
fi

# Open the browser as soon as the dashboard answers.
( for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$URL/api/health"; then open "$URL"; break; fi
    sleep 1
  done ) &

echo ""
echo "Dashboard: $URL"
echo "Keep this window open while you use the agent. Close it (or press Ctrl+C) to stop."
echo ""
exec .venv/bin/python -m app.server --port 8501
