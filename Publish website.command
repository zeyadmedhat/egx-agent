#!/bin/bash
# Double-click to send the latest version of the agent and your strategy settings to the website (GitHub).
# Your portfolio, your own numbers and the Telegram token never leave this Mac.
cd "$(dirname "$0")" || exit 1
pause() { read -r -p "Press Enter to close this window…"; }

if [ ! -d .git ] || ! git remote get-url origin >/dev/null 2>&1; then
  echo "The website isn't connected to GitHub yet. Ask Claude to set it up first."
  pause; exit 1
fi

echo "Copying your strategy settings (not your own numbers)…"
.venv/bin/python -m app.static_site strategy || { echo "Couldn't read your settings."; pause; exit 1; }

git add -A
# Safety checks: nothing private may be in what's about to be sent.
if git diff --cached --name-only | grep -Eq '^(data/|state/|deploy/|config\.yaml$)|\.db$'; then
  echo "Stopped: private files were about to be sent. Nothing was published."
  git reset -q; pause; exit 1
fi
TOKEN="$(.venv/bin/python -c "from egx_agent import config; print(config.load_config().get('telegram_token') or '')")"
if [ -n "$TOKEN" ] && git grep --cached -q -F "$TOKEN"; then
  echo "Stopped: your Telegram token was about to be sent. Nothing was published."
  git reset -q; pause; exit 1
fi

if git diff --cached --quiet; then
  echo "Nothing new to publish: the website already has this version."
  pause; exit 0
fi
git commit -q -m "Update from the Mac ($(date '+%d %b %Y %H:%M'))"
if git push -q origin main; then
  echo "Published. GitHub rebuilds the website in about 5 minutes."
else
  echo "Couldn't reach GitHub. Check your internet connection and double-click again."
fi
pause
