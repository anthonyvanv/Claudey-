#!/bin/bash
# Deploys the Toot Trays portal to Cloudflare. Safe to run again any time.
set -e
cd "$(dirname "$0")"
W="npx -y wrangler@4"
$W whoami >/dev/null 2>&1 || $W login
if ! $W deploy; then
  echo "Custom domain failed (is princefabrication.com on Cloudflare?). Deploying on workers.dev instead."
  sed -i '' '/^routes/,/^]/d' wrangler.toml
  $W deploy
fi
if [ ! -f .secrets_done ]; then
  echo; echo "Type the SHARED password for you and Nicola:"; $W secret put PORTAL_PASSWORD
  echo; echo "Type YOUR owner password (unlocks In production / Complete):"; $W secret put OWNER_PASSWORD
  touch .secrets_done
fi
echo; echo "Done. Portal: https://toottrays.princefabrication.com (or the workers.dev link above)"
