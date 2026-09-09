#!/usr/bin/env bash
#
# Malformed-MCP installer.
#
# Everything lives in this folder. Nothing is copied elsewhere, there is no
# Docker, and no reverse proxy: one Node process serves the panel and the MCP
# endpoint on a single port.
#
# Safe to re-run. Profiles and certificates are kept, but every run mints a new
# panel password and prints it at the end - so re-running is also how you get
# back in after losing it.
#
#   ./deploy.sh                                    interactive
#   ./deploy.sh --domain mcp.x.com --email me@x.com  unattended
#   ./deploy.sh --no-cert                          skip TLS entirely
#
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PORT=40000
SERVICE=malformed-mcp
DOMAIN=""
EMAIL=""
WANT_CERT=1
ASSUME_YES=0
LOG="$ROOT_DIR/runtime/install.log"

mkdir -p "$ROOT_DIR/runtime"
: > "$LOG"

B=$'\033[1m'; R=$'\033[0m'; G=$'\033[32m'; Y=$'\033[33m'; E=$'\033[31m'; C=$'\033[36m'
step() { printf '%s==>%s %s\n' "$C" "$R" "$*"; }
ok()   { printf '  %s+%s %s\n' "$G" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$R" "$*"; }
die()  {
  printf '\n%sInstall failed:%s %s\n  Full log: %s\n' "$E" "$R" "$*" "$LOG" >&2
  # The password is reset early in the run, so any failure after that point
  # still has to show it. Dying silently would leave a panel that is often
  # working perfectly well behind a password nobody has ever seen.
  if [[ -n "${PANEL_PASSWORD:-}" ]]; then
    printf '\n  %sThe panel password was already reset. It is:%s  %s%s%s\n' "$Y" "$R" "$Y" "$PANEL_PASSWORD" "$R" >&2
    printf '  %sIt works as soon as the service is running.%s\n\n' "$Y" "$R" >&2
  fi
  exit 1
}

# Fail loudly and at the right line rather than leaving a half-install behind.
trap 'die "line $LINENO: $BASH_COMMAND"' ERR

run() { echo "+ $*" >> "$LOG"; "$@" >> "$LOG" 2>&1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email)  EMAIL="${2:-}";  shift 2 ;;
    --port)   PORT="${2:-}";   shift 2 ;;
    --no-cert) WANT_CERT=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

printf '\n%sMalformed-MCP installer%s\n\n' "$B" "$R"

# ---------------------------------------------------------------- environment
step "Checking the environment"
[[ $EUID -eq 0 ]] || die "must run as root (try: sudo ./deploy.sh)"
ok "running as root"

if   command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf     >/dev/null 2>&1; then PKG=dnf
elif command -v yum     >/dev/null 2>&1; then PKG=yum
else die "no supported package manager found (need apt, dnf or yum)"; fi
ok "package manager: $PKG"

pkg_install() {
  case "$PKG" in
    apt) DEBIAN_FRONTEND=noninteractive run apt-get install -y "$@" ;;
    dnf) run dnf install -y "$@" ;;
    yum) run yum install -y "$@" ;;
  esac
}

step "Installing system packages"
if [[ "$PKG" == apt ]]; then run apt-get update || true; fi
MISSING=()
for tool in git curl socat openssl iptables fuser; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    if [[ "$tool" == "fuser" ]]; then
      MISSING+=(psmisc)
    else
      MISSING+=("$tool")
    fi
  fi
done
# cron is the odd one out: acme.sh installs its renewal job into it.
if ! command -v crontab >/dev/null 2>&1; then
  if [[ "$PKG" == apt ]]; then MISSING+=(cron); else MISSING+=(cronie); fi
fi
if [[ ${#MISSING[@]} -gt 0 ]]; then
  pkg_install "${MISSING[@]}" || die "could not install: ${MISSING[*]}"
  ok "installed: ${MISSING[*]}"
else
  ok "git, curl, socat, openssl, iptables, fuser, cron already present"
fi

# ----------------------------------------------------------------------- node
step "Checking Node.js"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$MAJOR" -ge 20 ]]; then NEED_NODE=0; ok "node $(node -v) is recent enough"; fi
fi
if [[ $NEED_NODE -eq 1 ]]; then
  warn "installing Node.js 22 (need >= 20.6)"
  case "$PKG" in
    apt) run bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'; pkg_install nodejs ;;
    *)   run bash -c 'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -'; pkg_install nodejs ;;
  esac
  command -v node >/dev/null 2>&1 || die "Node.js installation failed"
  ok "installed node $(node -v)"
fi

# ------------------------------------------------------------------- the app
step "Building Malformed-MCP"
[[ -f package.json ]] || die "package.json not found - run this from inside the Malformed-MCP folder"
run npm install --no-audit --no-fund || die "npm install failed (see the log)"
ok "dependencies installed"
run npm run build || die "TypeScript build failed (see the log)"
[[ -f dist/index.js ]] || die "build produced no dist/index.js"
ok "compiled to dist/"

mkdir -p runtime/logs runtime/output runtime/backups runtime/certs profiles
chmod 700 runtime runtime/certs profiles
ok "runtime folders ready (all inside $ROOT_DIR)"

# ---------------------------------------------------------------- the browser
# The browser tools ship enabled, and npm install does not bring the browser
# with it: playwright-core carries no postinstall hook, so a fresh box would
# advertise 25 browser tools that every one of them fails on first navigation
# with "Executable doesn't exist". The system libraries are the other half -
# Chromium needs libnss3 and friends, which a minimal server image does not
# have, and --with-deps is what fetches them.
#
# Best-effort on purpose. A box that cannot download a browser should still end
# up with a working server, so this warns and carries on instead of calling
# die() and taking the whole install down with it.
step "Installing the browser"
# Keep the browser inside the project ($ROOT_DIR/vendor/ms-playwright) instead of
# the default ~/.cache/ms-playwright, so everything this host needs lives under
# one folder. The MCP puppeteer unit points PLAYWRIGHT_BROWSERS_PATH here too.
export PLAYWRIGHT_BROWSERS_PATH="$ROOT_DIR/vendor/ms-playwright"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
if grep -q '"@playwright/mcp"' package.json 2>/dev/null; then
  PW_ARGS=(install chromium)
  [[ "$PKG" == apt ]] && PW_ARGS=(install --with-deps chromium)
  if run npx --no-install playwright "${PW_ARGS[@]}"; then
    ok "chromium ready for the browser tools (in $PLAYWRIGHT_BROWSERS_PATH)"
  else
    warn "chromium was not installed - everything else works, but the browser"
    warn "tools will fail until you run, from $ROOT_DIR:"
    warn "  PLAYWRIGHT_BROWSERS_PATH=$ROOT_DIR/vendor/ms-playwright npx playwright install --with-deps chromium"
  fi
else
  ok "no browser dependency in package.json - nothing to install"
fi

# ------------------------------------------------------ integrated MCP servers
# Besides this host's own MCP endpoint, three stdio MCP servers ship enabled and
# appear on the panel's MCP Servers page: a filesystem server, a headless-browser
# (puppeteer) server, and the Kali security-tools bridge. All three live entirely
# under this folder, and each is kept resident by a small systemd unit so the
# panel's status probe reports them "running" instead of "stopped".
#
# A stdio MCP server exits as soon as its stdin closes; scripts/mcp-stdio-run.sh
# hands it a never-closing FIFO so it stays up under systemd with no client
# attached. The filesystem and puppeteer servers are ordinary npm dependencies,
# so the npm install above already put their binaries in node_modules/.bin.
step "Setting up the integrated MCP servers"

chmod +x "$ROOT_DIR/scripts/"*.sh 2>/dev/null || true

for bin in mcp-server-filesystem mcp-server-puppeteer; do
  if [[ -x "$ROOT_DIR/node_modules/.bin/$bin" ]]; then
    ok "$bin present"
  else
    warn "$bin missing from node_modules/.bin - that MCP server will not start"
  fi
done

# The filesystem server is scoped to this directory; create it, plus a home for
# the stdio FIFOs, so a brand-new box has both.
mkdir -p "$ROOT_DIR/mcp-workspace" "$ROOT_DIR/runtime/fifos"
ok "filesystem workspace and stdio FIFO directory ready"

# The Kali bridge needs Python and a virtualenv. Best-effort, like the browser:
# a box without Python still ends up with a working core server and the other
# two MCP servers.
KALI_DIR="$ROOT_DIR/vendor/mcp-kali-server"
KALI_OK=0
if command -v python3 >/dev/null 2>&1; then
  # python3-venv and python3-pip are separate packages on Debian/Ubuntu.
  if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
    case "$PKG" in
      apt) pkg_install python3-venv python3-pip || warn "could not install python3-venv/python3-pip" ;;
      dnf|yum) pkg_install python3-pip || true ;;
    esac
  fi
  if [[ ! -d "$KALI_DIR/.git" ]]; then
    if run git clone --depth 1 https://github.com/Wh0am123/MCP-Kali-Server "$KALI_DIR"; then
      ok "cloned the Kali MCP server into vendor/mcp-kali-server"
    else
      warn "could not clone the Kali MCP server - terminal-security will be skipped"
    fi
  else
    run git -C "$KALI_DIR" pull --ff-only || warn "could not update the Kali MCP server checkout"
  fi
  if [[ -f "$KALI_DIR/requirements.txt" ]]; then
    # mcp 2.x dropped mcp.server.fastmcp, which this client imports, so pin <2.
    if run python3 -m venv "$KALI_DIR/.venv" \
       && run "$KALI_DIR/.venv/bin/pip" install --upgrade pip \
       && run "$KALI_DIR/.venv/bin/pip" install -r "$KALI_DIR/requirements.txt" \
       && run "$KALI_DIR/.venv/bin/pip" install 'mcp<2'; then
      KALI_OK=1
      ok "Kali MCP server virtualenv ready (mcp pinned <2 for fastmcp)"
    else
      warn "Kali virtualenv setup failed - terminal-security will not start"
    fi
  fi
else
  warn "python3 not found - skipping the Kali (terminal-security) MCP server"
fi

# Installs the resident systemd units for the stdio MCP servers, templated the
# same way as the main unit: the repo ships /root/Malformed-MCP and the node path
# as placeholders, rewritten here to this install's real locations.
install_mcp_units() {
  local node_bin; node_bin="$(command -v node)"
  local units=(mcp-filesystem.service mcp-puppeteer.service)
  [[ $KALI_OK -eq 1 ]] && units+=(mcp-kali-api.service mcp-kali.service)
  local installed=()
  local unit
  for unit in "${units[@]}"; do
    if [[ -f "$ROOT_DIR/systemd/$unit" ]]; then
      sed -e "s#/root/Malformed-MCP#${ROOT_DIR}#g" \
          -e "s#/usr/bin/node#${node_bin}#g" \
          "$ROOT_DIR/systemd/$unit" > "/etc/systemd/system/$unit"
      installed+=("$unit")
    else
      warn "unit template systemd/$unit not found - skipping"
    fi
  done
  run systemctl daemon-reload
  for unit in "${installed[@]}"; do
    run systemctl enable "$unit" && ok "unit $unit installed and enabled"
  done
}

# Starts (or restarts) the resident MCP-server units after the main service.
start_mcp_units() {
  local units=(mcp-filesystem.service mcp-puppeteer.service)
  [[ $KALI_OK -eq 1 ]] && units+=(mcp-kali-api.service mcp-kali.service)
  local unit
  for unit in "${units[@]}"; do
    [[ -f "/etc/systemd/system/$unit" ]] || continue
    run systemctl restart "$unit" || warn "could not start $unit"
    if systemctl is-active --quiet "$unit"; then
      ok "$unit is running"
    else
      warn "$unit is not running - check: journalctl -u $unit -n 50"
    fi
  done
}

# --------------------------------------------------------------------- portal
step "Opening port $PORT"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  run ufw allow "${PORT}/tcp"
  ok "ufw: allowed ${PORT}/tcp"
fi
if command -v iptables >/dev/null 2>&1; then
  if iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
    ok "iptables: ${PORT}/tcp already allowed"
  else
    # The chain may end in a catch-all REJECT. Appending after it would have no
    # effect, so the rule goes in immediately before it when one exists.
    REJECT_LINE="$(iptables -L INPUT --line-numbers -n 2>/dev/null | awk '$2=="REJECT"{print $1; exit}')"
    if [[ -n "$REJECT_LINE" ]]; then
      run iptables -I INPUT "$REJECT_LINE" -p tcp --dport "$PORT" -j ACCEPT
      ok "iptables: inserted ACCEPT at position $REJECT_LINE, before the REJECT"
    else
      run iptables -I INPUT 1 -p tcp --dport "$PORT" -j ACCEPT
      ok "iptables: inserted ACCEPT at the top of INPUT"
    fi
    if command -v netfilter-persistent >/dev/null 2>&1; then
      run netfilter-persistent save && ok "iptables rules persisted"
    elif [[ -f /etc/sysconfig/iptables ]] && command -v service >/dev/null 2>&1; then
      run service iptables save && ok "iptables rules persisted"
    else
      warn "could not persist iptables rules - they will be lost on reboot"
      warn "install iptables-persistent to make this permanent"
    fi
  fi
fi
warn "if this machine sits behind a cloud firewall or security list, open ${PORT}/tcp there too"

# -------------------------------------------------------------------- service
step "Installing the systemd service"
HAVE_SYSTEMD=0
if [[ -d /run/systemd/system ]]; then
  sed -e "s#/root/Malformed-MCP#${ROOT_DIR}#g" \
      -e "s#/usr/bin/node#$(command -v node)#g" \
      "$ROOT_DIR/malformed-mcp.service" > "/etc/systemd/system/${SERVICE}.service"
  run systemctl daemon-reload
  run systemctl enable "$SERVICE"
  ok "service ${SERVICE} installed and enabled"
  install_mcp_units
  HAVE_SYSTEMD=1
else
  warn "systemd not available - you will have to start it yourself"
fi

# ------------------------------------------------------------------ first run
step "Resetting the panel password"
# Every run replaces the password and prints the new one below. That makes a
# lost password a non-event: there is nothing to recover, only to replace by
# running this script again. The app generates and hashes it, so this script
# never holds a credential long enough to leak one into the log.
PANEL_PASSWORD_RAW="$(node -e '
  import("./dist/panel/auth.js").then(async (m) => {
    await m.loadPanel();
    const next = m.generatePassword(20);
    await m.changePassword(next);
    console.log("PANEL_PASSWORD::" + next);
  }).catch((e) => { console.error(e); process.exit(1); });
' 2>>"$LOG")" || die "could not reset the panel password"
PANEL_PASSWORD="$(echo "$PANEL_PASSWORD_RAW" | grep -E '^PANEL_PASSWORD::' | tail -n 1 | sed 's/^PANEL_PASSWORD:://' || true)"

# A blank value here would print an empty password and lock you out silently,
# which is worse than failing the install.
[[ -n "$PANEL_PASSWORD" ]] || die "the panel password generator returned nothing"
ok "new panel password generated (20 characters) - shown at the end"

# ---------------------------------------------------------------------- start
step "Starting Malformed-MCP"
if [[ $HAVE_SYSTEMD -eq 1 ]]; then
  run systemctl restart "$SERVICE"
  sleep 3
  systemctl is-active --quiet "$SERVICE" || {
    journalctl -u "$SERVICE" -n 40 --no-pager >> "$LOG" 2>&1 || true
    die "service failed to start - check: journalctl -u ${SERVICE} -n 50"
  }
  ok "service is running"
  start_mcp_units
else
  ( setsid node dist/index.js >> runtime/logs/stdout.log 2>&1 & )
  sleep 3
  ok "started in the background"
fi

# Once a certificate has been issued, this same port speaks TLS and nothing
# else. A plain HTTP probe then gets "Empty reply from server" and the install
# reports a dead server that is in fact perfectly healthy, so try both schemes
# and accept whichever answers.
HEALTHY=0
LOCAL_SCHEME=""
for _ in $(seq 1 15); do
  if curl -fsS -k --max-time 2 "https://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    HEALTHY=1; LOCAL_SCHEME=https; break
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    HEALTHY=1; LOCAL_SCHEME=http; break
  fi
  sleep 1
done
[[ $HEALTHY -eq 1 ]] || die "the server never answered on port ${PORT} over http or https"
ok "health check passed (${LOCAL_SCHEME})"

# ----------------------------------------------------------------------- cert
SCHEME="${LOCAL_SCHEME:-http}"
HOST="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
CERT_NOTE=""

# A certificate from an earlier run is still in force. Without this the banner
# advertises http://<ip>, which does not work at all on a TLS-only port.
EXISTING_CERT_RAW="$(node -e '
  import("./dist/panel/cert.js").then((c) => {
    const cur = c.currentCert();
    if (cur && cur.domain) console.log("CERT_DOMAIN::" + cur.domain);
  }).catch(() => {});
' 2>>"$LOG" || true)"
EXISTING_CERT_DOMAIN="$(echo "$EXISTING_CERT_RAW" | grep -E '^CERT_DOMAIN::' | tail -n 1 | sed 's/^CERT_DOMAIN:://' || true)"
if [[ -n "$EXISTING_CERT_DOMAIN" ]]; then SCHEME=https; HOST="$EXISTING_CERT_DOMAIN"; fi

if [[ $WANT_CERT -eq 1 && -z "$DOMAIN" && $ASSUME_YES -eq 0 && -t 0 ]]; then
  printf '\n  Domain for this server (blank to skip TLS): '
  read -r DOMAIN
fi

# Let's Encrypt rejects a contact whose domain part has no dot, and an account
# stuck on a bad one keeps failing every future issuance the same way - see
# ensureAccount() in cert.ts. Ask once, up front, rather than leaving it to
# whatever the panel happens to send later.
if [[ $WANT_CERT -eq 1 && -n "$DOMAIN" && -z "$EMAIL" && $ASSUME_YES -eq 0 && -t 0 ]]; then
  printf '  Contact email for the certificate (optional, blank is fine): '
  read -r EMAIL
fi

if [[ $WANT_CERT -eq 1 && -n "$DOMAIN" ]]; then
  step "Issuing a certificate for $DOMAIN"

  # Check if port 80 is occupied and force-free it
  PORT80_PID=""
  if command -v fuser >/dev/null 2>&1; then
    PORT80_PID="$(fuser 80/tcp 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    PORT80_PID="$(lsof -t -i:80 2>/dev/null || true)"
  elif command -v ss >/dev/null 2>&1; then
    PORT80_PID="$(ss -tulpn '( sport = :80 )' 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | tr '\n' ' ' || true)"
  fi

  if [[ -n "$PORT80_PID" ]]; then
    printf '  %s! Port 80 is occupied (PID: %s) — freeing port 80 for ACME challenge...%s\n' "$E" "$PORT80_PID" "$R"
  fi

  # Force free port 80
  FREE_EXECUTED=0
  if command -v fuser >/dev/null 2>&1; then
    fuser -k -9 80/tcp >/dev/null 2>&1 || true
    FREE_EXECUTED=1
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -i:80 2>/dev/null | xargs -r kill -9 2>/dev/null || true
    FREE_EXECUTED=1
  fi
  # Stop background webservers that may grab port 80
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop nginx >/dev/null 2>&1 || true
    systemctl stop apache2 >/dev/null 2>&1 || true
    systemctl stop httpd >/dev/null 2>&1 || true
  fi

  if [[ -n "$PORT80_PID" || $FREE_EXECUTED -eq 1 ]]; then
    ok "port 80 force-free command has been executed"
  fi
  # Ask the app, not acme.sh directly: it does the DNS pre-check first, then
  # tries HTTP-01, TLS-ALPN-01 and DNS-01 in turn, borrowing :80 and :443 for
  # only as long as the challenge takes.
  RESULT_RAW="$(node -e '
    const [domain, email] = process.argv.slice(1);
    import("./dist/panel/cert.js").then(async (c) => {
      const pre = await c.preflight(domain);
      if (!pre.ok) { console.log("PREFAIL::" + pre.detail); return; }
      const out = await c.issue(domain, email || undefined);
      console.log(out.ok ? "OK::" + out.method : "FAIL::" + (out.error || "issuance failed"));
    }).catch((e) => console.log("FAIL::" + e.message));
  ' "$DOMAIN" "$EMAIL" 2>>"$LOG")" || true

  RESULT="$(echo "$RESULT_RAW" | grep -E '^(OK|FAIL|PREFAIL)::' | tail -n 1 || true)"
  if [[ -z "$RESULT" ]]; then
    RESULT="FAIL::${RESULT_RAW}"
  fi

  case "$RESULT" in
    OK::*)
      ok "certificate issued via ${RESULT#OK::}"
      SCHEME=https; HOST="$DOMAIN"
      if [[ $HAVE_SYSTEMD -eq 1 ]]; then run systemctl restart "$SERVICE"; sleep 3; fi
      ok "restarted with TLS enabled"
      ;;
    PREFAIL::*)
      warn "skipped: ${RESULT#PREFAIL::}"
      CERT_NOTE="No certificate yet. Fix the DNS, then issue one from the Certificate page."
      ;;
    *)
      warn "certificate could not be issued: ${RESULT#FAIL::}"
      CERT_NOTE="No certificate yet. You can retry from the Certificate page."
      ;;
  esac
elif [[ "$SCHEME" == https ]]; then
  CERT_NOTE="Kept the existing certificate for ${HOST}."
else
  CERT_NOTE="No domain given, so the panel is served over plain HTTP."
fi

# --------------------------------------------------------------------- report
URL="${SCHEME}://${HOST}:${PORT}"

printf '\n'
printf '%s================================================================%s\n' "$G" "$R"
printf '%s   Malformed-MCP is installed and running%s\n' "$G" "$R"
printf '%s================================================================%s\n\n' "$G" "$R"

printf '  %sWeb panel%s      %s%s%s\n' "$B" "$R" "$C" "$URL" "$R"
printf '  %sMCP endpoint%s   %s/mcp\n\n' "$B" "$R" "$URL"

printf '  %sPassword%s       %s%s%s\n' "$B" "$R" "$Y" "$PANEL_PASSWORD" "$R"
printf '                 %sbrand new - any previous password stopped working just now%s\n' "$Y" "$R"
printf '                 %sthere is no username - this password is the only credential%s\n' "$Y" "$R"
printf '                 %sshown once - copy it now, or re-run this script for a new one%s\n' "$Y" "$R"

printf '\n  %sNext steps%s\n' "$B" "$R"
printf '    1. Open %s and sign in.\n' "$URL"
printf '    2. Paste the password above - there is no username field.\n'
printf '    3. Add a GitHub account on the Profiles page - paste a token, nothing else.\n'
printf '    4. Give each agent that profile own MCP token; it can only ever see that account.\n'
if [[ -n "$CERT_NOTE" ]]; then printf '\n  %sTLS%s   %s\n' "$Y" "$R" "$CERT_NOTE"; fi

printf '\n  %sManage%s   systemctl {status,restart,stop} %s\n' "$B" "$R" "$SERVICE"
printf '  %sLogs%s     journalctl -u %s -f\n' "$B" "$R" "$SERVICE"
printf '  %sFolder%s   %s   (everything lives here)\n\n' "$B" "$R" "$ROOT_DIR"

trap - ERR
