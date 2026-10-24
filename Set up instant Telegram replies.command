#!/bin/bash
# Double-click once: puts the bot's instant replies (worker/bot.js) on Cloudflare's free plan.
# You sign in to Cloudflare yourself in the browser, and you paste the bot token yourself: it goes only to Cloudflare.
cd "$(dirname "$0")/worker" || exit 1
pause() { read -r -p "Press Enter to close this window…"; }
W="npx --yes wrangler@4"

echo "1/4  Sign in to Cloudflare in the browser window that opens (make a free account if you have none)."
$W login || { echo "Sign-in didn't finish."; pause; exit 1; }

echo; echo "2/4  Putting the bot on Cloudflare…"
OUT="$($W deploy 2>&1)"; echo "$OUT"
URL="$(echo "$OUT" | grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$URL" ] || { echo "Couldn't put it on Cloudflare (see above)."; pause; exit 1; }

echo; echo "3/4  Paste the bot's token from @BotFather (the same as the TELEGRAM_TOKEN GitHub secret), then Enter."
echo "     It isn't shown while you paste."
read -r -s TOKEN; echo
[ -n "$TOKEN" ] || { echo "No token pasted."; pause; exit 1; }
printf '%s' "$TOKEN" | $W secret put BOT_TOKEN >/dev/null || { echo "Couldn't save the token."; pause; exit 1; }
KEY="$(openssl rand -hex 24)"
printf '%s' "$KEY" | $W secret put SYNC_KEY >/dev/null || { echo "Couldn't save the key."; pause; exit 1; }

cat <<EOF

4/4  Last step, on GitHub: your repository → Settings → Secrets and variables → Actions → New repository secret.
     Add these two:

       Name: WORKER_URL    Value: $URL
       Name: WORKER_KEY    Value: $KEY

     Then run the website once (Actions → Daily scan and website → Run workflow).
     From then on the bot answers commands at once.
EOF
pause
