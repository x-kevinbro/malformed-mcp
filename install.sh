#!/usr/bin/env bash
# =============================================================================
#  Malformed-MCP — One-Line Installer
#
#  Public repo:
#    bash <(curl -fsSL https://raw.githubusercontent.com/x-kevinbro/malformed-mcp/main/install.sh)
#
#  With domain + TLS:
#    bash <(curl -fsSL https://raw.githubusercontent.com/x-kevinbro/malformed-mcp/main/install.sh) \
#      --domain mcp.yourdomain.com --email you@example.com
#
#  Private repo (pass your GitHub token):
#    GITHUB_TOKEN=ghp_xxx bash <(curl -fsSL ...)
#
# =============================================================================
set -Eeuo pipefail

REPO_OWNER="x-kevinbro"
REPO_NAME="malformed-mcp"
INSTALL_DIR="/opt/malformed-mcp"

B=$'\033[1m'; R=$'\033[0m'; G=$'\033[32m'; C=$'\033[36m'; E=$'\033[31m'

echo ""
echo "${C}╔══════════════════════════════════════════╗${R}"
echo "${C}║       Malformed-MCP  Installer           ║${R}"
echo "${C}╚══════════════════════════════════════════╝${R}"
echo ""

# root check
[[ $EUID -eq 0 ]] || { echo "${E}Error:${R} must run as root → sudo bash <(curl ...)"; exit 1; }

# ensure git
if ! command -v git &>/dev/null; then
  echo "Installing git..."
  if   command -v apt-get &>/dev/null; then apt-get update -qq && apt-get install -y -qq git
  elif command -v dnf     &>/dev/null; then dnf install -y git
  else                                      yum install -y git
  fi
fi

# build clone URL (inject token if provided)
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  CLONE_URL="https://${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
else
  CLONE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
fi

# clone or update
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "${G}==> Updating existing install in $INSTALL_DIR${R}"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "${G}==> Cloning into $INSTALL_DIR${R}"
  git clone "$CLONE_URL" "$INSTALL_DIR"
fi

# launch the real installer, forwarding all args
echo "${G}==> Running installer...${R}"
echo ""
exec bash "$INSTALL_DIR/deploy.sh" "$@"
