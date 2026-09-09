#!/usr/bin/env bash
# =============================================================================
#  Malformed-MCP — One-Line Installer
#
#  Usage (just run it — it will ask what it needs):
#    bash <(curl -fsSL https://raw.githubusercontent.com/x-kevinbro/malformed-mcp/main/install.sh)
#
#  Or pass args up-front to skip the prompts:
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

B=$'\033[1m'; R=$'\033[0m'; G=$'\033[32m'; C=$'\033[36m'; E=$'\033[31m'; Y=$'\033[33m'

echo ""
echo "${C}╔══════════════════════════════════════════╗${R}"
echo "${C}║       Malformed-MCP  Installer           ║${R}"
echo "${C}╚══════════════════════════════════════════╝${R}"
echo ""

# ── root check ──────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || { echo "${E}Error:${R} must run as root → sudo bash <(curl ...)"; exit 1; }

# ── parse CLI args (all optional — prompts fill in the rest) ─────────────────
DOMAIN=""
EMAIL=""
NO_CERT=0
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)  DOMAIN="${2:-}";  shift 2 ;;
    --email)   EMAIL="${2:-}";   shift 2 ;;
    --no-cert) NO_CERT=1;        shift   ;;
    *)         EXTRA_ARGS+=("$1"); shift  ;;
  esac
done

# ── interactive prompts (only if not already supplied) ───────────────────────
echo "${B}Step 1 of 2 — TLS / Domain setup${R}"
echo ""

if [[ $NO_CERT -eq 0 && -z "$DOMAIN" ]]; then
  echo "  A custom domain lets the installer get a free Let's Encrypt certificate."
  echo "  Point your DNS A-record to this server's IP first, then enter the domain."
  echo ""
  printf "  ${B}Domain name${R} (e.g. mcp.yourdomain.com) [leave blank to skip TLS]: "
  read -r DOMAIN
  echo ""
fi

if [[ $NO_CERT -eq 0 && -n "$DOMAIN" && -z "$EMAIL" ]]; then
  printf "  ${B}Contact email${R} for the TLS certificate [optional, press Enter to skip]: "
  read -r EMAIL
  echo ""
fi

# ── build deploy.sh args from what we collected ──────────────────────────────
DEPLOY_ARGS=()
[[ $NO_CERT -eq 1 ]]   && DEPLOY_ARGS+=("--no-cert")
[[ -n "$DOMAIN" ]]     && DEPLOY_ARGS+=("--domain" "$DOMAIN")
[[ -n "$EMAIL" ]]      && DEPLOY_ARGS+=("--email"  "$EMAIL")
DEPLOY_ARGS+=("${EXTRA_ARGS[@]}")

# ── ensure git ───────────────────────────────────────────────────────────────
echo "${B}Step 2 of 2 — Fetching the project${R}"
echo ""

if ! command -v git &>/dev/null; then
  echo "  Installing git..."
  if   command -v apt-get &>/dev/null; then apt-get update -qq && apt-get install -y -qq git
  elif command -v dnf     &>/dev/null; then dnf install -y git
  else                                      yum install -y git
  fi
fi

# ── clone URL (inject token for private repos) ────────────────────────────────
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  CLONE_URL="https://${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
else
  CLONE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
fi

# ── clone or pull ─────────────────────────────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "  ${G}Updating existing install in $INSTALL_DIR${R}"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "  ${G}Cloning into $INSTALL_DIR${R}"
  git clone "$CLONE_URL" "$INSTALL_DIR"
fi

# ── hand off to the real installer ───────────────────────────────────────────
echo ""
echo "${G}==> Launching installer...${R}"
echo ""
exec bash "$INSTALL_DIR/deploy.sh" "${DEPLOY_ARGS[@]}"
