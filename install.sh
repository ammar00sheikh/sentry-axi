#!/usr/bin/env bash
# sentry-axi installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ammar00sheikh/sentry-axi/main/install.sh | bash
#
# Clones (or updates) the repo into $SENTRY_AXI_HOME (default ~/.sentry-axi/cli),
# builds it, and links the `sentry-axi` binary onto PATH via npm link.
# Requirements: git, Node >= 20, npm. Everything else is HTTP - sentry-axi talks
# to the Sentry API directly, so there is nothing else to install.
set -euo pipefail

INSTALL_DIR="${SENTRY_AXI_HOME:-$HOME/.sentry-axi/cli}"
REPO="${SENTRY_AXI_REPO:-https://github.com/ammar00sheikh/sentry-axi.git}"

command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
command -v npm >/dev/null || { echo "error: npm (Node >= 20) is required" >&2; exit 1; }

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 20 ]; then
  echo "error: Node >= 20 is required (found $(node -v 2>/dev/null || echo none))" >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing install in $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Cloning into $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "Installing dependencies..."
npm install --no-fund --no-audit
echo "Building..."
npm run build
echo "Linking sentry-axi onto PATH..."
npm link

echo
echo "sentry-axi $(sentry-axi -v) installed."
if ! command -v sentry-cli >/dev/null; then
  echo "note: the official sentry-cli binary was not found on PATH - it is only"
  echo "      needed for sourcemap and debug-file uploads. sentry-axi will tell"
  echo "      you if a command needs it."
fi
echo "Next: create a token at https://sentry.io/settings/account/api/auth-tokens/,"
echo "      then run: sentry-axi login --token <token>"
echo "      followed by: sentry-axi use <org>/<project>"
