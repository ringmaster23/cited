#!/bin/sh
# Install git hooks for citedconversations build checks.
# Run: sh scripts/install-hooks.sh

HOOK_SRC="scripts/hooks/pre-push"
HOOK_DEST=".git/hooks/pre-push"

if [ ! -d .git ]; then
  echo "Error: run this from the repo root directory."
  exit 1
fi

cp "$HOOK_SRC" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
echo "Installed pre-push hook at $HOOK_DEST"
echo "The hook runs node build.js before every push. Fix failures before pushing."
