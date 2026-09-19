#!/usr/bin/env bash
# =============================================================================
#  Malformed-MCP — Uninstaller
#
#  Stops and removes the services and the firewall rule. The install folder is
#  KEPT by default, because it holds everything worth keeping - GitHub
#  profiles, cloud accounts, MCP tokens, certificates, settings and logs - so
#  a reinstall picks right back up.
#
#    ./uninstall.sh                remove the services, keep the folder
#    ./uninstall.sh --purge        also delete the folder itself (all data lost)
#
#  One-line form, like the installer:
#    bash <(curl -fsSL https://raw.githubusercontent.com/x-kevinbro/malformed-mcp/main/uninstall.sh)
#
# =============================================================================
set -Eeuo pipefail

DEFAULT_DIR="/opt/malformed-mcp"
PORT_FALLBACK=40000
UNITS=(malformed-mcp.service mcp-filesystem.service mcp-puppeteer.service mcp-kali.service mcp-kali-api.service)

B=$'\033[1m'; R=$'\033[0m'; G=$'\033[32m'; C=$'\033[36m'; E=$'\033[31m'; Y=$'\033[33m'
step() { printf '%s==>%s %s\n' "$C" "$R" "$*"; }
ok()   { printf '  %s+%s %s\n' "$G" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$R" "$*"; }
die()  { printf '\n%sUninstall failed:%s %s\n' "$E" "$R" "$*" >&2; exit 1; }

echo ""
echo "${C}╔══════════════════════════════════════════╗${R}"
echo "${C}║       Malformed-MCP  Uninstaller         ║${R}"
echo "${C}╚══════════════════════════════════════════╝${R}"
echo ""

# ── args ─────────────────────────────────────────────────────────────────────
PURGE=0
ASSUME_YES=0
DIR_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)   PURGE=1;      shift   ;;
    --dir)     DIR_ARG="${2:-}"; shift 2 ;;
    --yes|-y)  ASSUME_YES=1; shift   ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *)         die "unknown option: $1" ;;
  esac
done

# ── root check (after arg parsing, so --help works for anyone) ───────────────
[[ $EUID -eq 0 ]] || { echo "${E}Error:${R} must run as root → sudo $0"; exit 1; }

# ── find the install ─────────────────────────────────────────────────────────
# Priority: --dir, then the folder this script sits in (when it looks like the
# install), then the default the installer uses.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)"
if [[ -n "$DIR_ARG" ]]; then
  ROOT_DIR="$DIR_ARG"
elif [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/malformed-mcp.service" ]]; then
  ROOT_DIR="$SCRIPT_DIR"
else
  ROOT_DIR="$DEFAULT_DIR"
fi
[[ -d "$ROOT_DIR" ]] || die "no install found at $ROOT_DIR (pass --dir /path/to/malformed-mcp)"
ok "install folder: $ROOT_DIR"

# The port the panel listens on: a panel override in settings.json wins over
# the compiled default.
PORT="$PORT_FALLBACK"
if [[ -f "$ROOT_DIR/runtime/settings.json" ]]; then
  DETECTED="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT_DIR/runtime/settings.json" | head -n1 || true)"
  [[ -n "$DETECTED" ]] && PORT="$DETECTED"
fi
ok "panel port: $PORT"

# ── confirm ──────────────────────────────────────────────────────────────────
if [[ $ASSUME_YES -eq 0 ]]; then
  if [[ $PURGE -eq 1 ]]; then
    printf '\n  %sThis DELETES %s — profiles, cloud accounts, tokens, certs, logs and all.%s' "$E" "$ROOT_DIR" "$R"
  else
    printf '\n  This stops and removes the Malformed-MCP services and closes port %s.' "$PORT"
    printf '\n  %sThe folder %s is kept%s (reinstall picks everything back up).' "$G" "$ROOT_DIR" "$R"
  fi
  printf '\n\n  Continue? [y/N] '
  read -r ANSWER
  [[ "$ANSWER" =~ ^[Yy]$ ]] || { echo "  Aborted."; exit 0; }
fi

# ── services ─────────────────────────────────────────────────────────────────
step "Stopping and removing services"
if [[ -d /run/systemd/system ]]; then
  for unit in "${UNITS[@]}"; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      systemctl stop "$unit" && ok "stopped $unit"
    fi
    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      systemctl disable "$unit" >/dev/null 2>&1 || true
    fi
    if [[ -f "/etc/systemd/system/$unit" ]]; then
      rm -f "/etc/systemd/system/$unit" && ok "removed /etc/systemd/system/$unit"
    fi
  done
  systemctl daemon-reload
  systemctl reset-failed >/dev/null 2>&1 || true
else
  warn "systemd not available - killing the process directly"
  # Started with setsid from deploy.sh, so no unit exists to stop it.
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 && ok "killed the process holding port $PORT" || true
  fi
  pkill -f "node dist/index.js" >/dev/null 2>&1 || true
fi

# ── firewall ─────────────────────────────────────────────────────────────────
step "Closing port $PORT"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw delete allow "${PORT}/tcp" >/dev/null 2>&1 && ok "ufw: rule removed" || ok "ufw: no rule to remove"
fi
if command -v iptables >/dev/null 2>&1; then
  REMOVED=0
  while iptables -D INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; do
    REMOVED=1
  done
  [[ $REMOVED -eq 1 ]] && ok "iptables: rule removed" || ok "iptables: no rule to remove"
  if [[ $REMOVED -eq 1 ]]; then
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save >/dev/null 2>&1 || true
    elif [[ -f /etc/sysconfig/iptables ]] && command -v service >/dev/null 2>&1; then
      service iptables save >/dev/null 2>&1 || true
    fi
  fi
fi

# ── leftovers worth knowing about ────────────────────────────────────────────
if [[ -d "$HOME/.acme.sh" ]]; then
  warn "left in place: $HOME/.acme.sh (the Let's Encrypt client and its renewal cron job)."
  warn "  Only relevant if a certificate was issued. To remove: ~/.acme.sh/acme.sh --uninstall"
fi

# ── the folder ───────────────────────────────────────────────────────────────
if [[ $PURGE -eq 1 ]]; then
  step "Deleting $ROOT_DIR"
  # Deleting the folder this script runs from is safe on Linux: the shell keeps
  # reading the now-unlinked file through its open descriptor until exit. This
  # is why the rm is the last real action.
  rm -rf -- "$ROOT_DIR"
  ok "deleted $ROOT_DIR"
  printf '\n%sMalformed-MCP is fully uninstalled.%s\n\n' "$G" "$R"
else
  printf '\n%sServices removed.%s The folder stayed: %s\n' "$G" "$R" "$ROOT_DIR"
  printf '  Reinstall any time:  bash <(curl -fsSL https://raw.githubusercontent.com/x-kevinbro/malformed-mcp/main/install.sh)\n'
  printf '  Your profiles, cloud accounts, tokens and settings are still there.\n'
  printf '  To remove everything:  %s/uninstall.sh --purge\n\n' "$ROOT_DIR"
fi