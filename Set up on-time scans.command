#!/bin/bash
# Double-click once: lets the Telegram bot (worker/bot.js) start the website's scan on GitHub right after each close,
# because GitHub's own timer often starts it late or not at all. You make the GitHub key yourself and paste it here;
# it goes only to Cloudflare, and it can do nothing but start this repository's runs.
cd "$(dirname "$0")/worker" || exit 1
pause() { read -r -p "Press Enter to close this window…"; }
W="npx --yes wrangler@4"

cat <<'EOF'
1/3  Make the GitHub key (about a minute), in your browser:

     github.com → your photo (top right) → Settings → Developer settings (at the bottom)
       → Personal access tokens → Fine-grained tokens → Generate new token

       Token name:         EGX on-time scans
       Expiration:         the longest it offers (GitHub asks you to renew it then)
       Repository access:  Only select repositories → egx-agent
       Permissions:        Repository permissions → Actions → Read and write
                           (leave everything else as it is)

     Press Generate token and copy it (it starts with github_pat_).

EOF
echo "2/3  Sign in to Cloudflare if a browser window asks (the same account as the bot)."
$W whoami >/dev/null 2>&1 || $W login || { echo "Sign-in didn't finish."; pause; exit 1; }

echo; echo "3/3  Paste the GitHub key, then Enter. It isn't shown while you paste."
read -r -s KEY; echo
[ -n "$KEY" ] || { echo "No key pasted."; pause; exit 1; }
printf '%s' "$KEY" | $W secret put GH_TOKEN >/dev/null || { echo "Couldn't save the key."; pause; exit 1; }

cat <<'EOF'

Done. During each session the bot starts a scan of the live prices every half hour (10:30 to 14:30 Cairo time),
and after the close it starts the closing scan if it hasn't run yet (at 15:40, then 16:10, 16:40, 17:40, 19:10
and 21:10 until it has).
You can see those runs on GitHub → Actions: they say "workflow_dispatch".
EOF
pause
