/**
 * Panel routing.
 *
 * Mounted on the same Express app as /mcp, so the interface and the endpoint
 * share one port and one process. Page routes redirect to /login; /api routes
 * answer 401 as JSON, because a fetch() should not be handed a login page.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { config } from "../config.js";
import { audit } from "../logger.js";
import {
  SESSION_COOKIE,
  changePassword,
  issueSession,
  mustChangePassword,
  readCookie,
  validSession,
  verifyLogin,
} from "./auth.js";
import { loginPage, page, escapeHtml } from "./ui.js";
import { allProfiles } from "../github/store.js";
import { githubApiRouter } from "./github.js";
import { settingsRouter, restartPending } from "./settings.js";
import { preflight, issue, completeDns, currentCert } from "./cert.js";
import { mcpServers, clientConfigJson } from "./mcp-config.js";
import { listServerTools, checkUpdate, applyUpdate } from "./mcp-admin.js";
import { execFile } from "node:child_process";

function authed(req: Request): boolean {
  return validSession(readCookie(req.header("cookie"), SESSION_COOKIE));
}

function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (authed(req)) {
    next();
    return;
  }
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  res.redirect(302, "/login");
}

export function panelRouter(): Router {
  const r = Router();

  /**
   * The panel must never answer for the MCP endpoint.
   *
   * This router is mounted at "/" and ends in a session guard, so without this
   * escape an unauthenticated POST /mcp was redirected to /login - a 302 with
   * an HTML body, which an MCP client cannot make sense of. next("router")
   * leaves this router entirely and lets the real /mcp handlers run.
   */
  r.use((req, _res, next) => {
    if (req.path === "/mcp" || req.path.startsWith("/mcp/") || req.path === "/health") {
      next("router");
      return;
    }
    next();
  });

  r.get("/login", (req, res) => {
    if (authed(req)) {
      res.redirect(302, "/");
      return;
    }
    res.type("html").send(loginPage());
  });

  r.post("/api/login", (req, res) => {
    const { password } = (req.body ?? {}) as Record<string, string>;
    if (!verifyLogin(String(password ?? ""))) {
      audit("panel_login_failed", { ip: req.ip });
      res.status(401).json({ error: "Incorrect password." });
      return;
    }
    audit("panel_login", { ip: req.ip });
    res.cookie(SESSION_COOKIE, issueSession(), {
      httpOnly: true,
      sameSite: "lax",
      // The signed token has no server-side expiry at zero. A long-lived cookie
      // keeps that login across browser restarts (browsers may apply their own cap).
      maxAge:
        config.panel.sessionHours === 0 ? 10 * 365 * 24 * 3_600_000 : config.panel.sessionHours * 3_600_000,
      // Set only when TLS is actually in use: a Secure cookie over plain HTTP
      // is discarded, which would lock the operator out of an IP-only setup.
      secure: req.protocol === "https",
      path: "/",
    });
    res.json({ ok: true, next: mustChangePassword() ? "/account" : "/" });
  });

  r.get("/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    audit("panel_logout", { ip: req.ip });
    res.redirect(302, "/login");
  });

  r.use(requireSession);

  // Everything past this point requires a signed-in browser session.
  r.use(githubApiRouter());
  r.use(settingsRouter());

  // --- certificates ---------------------------------------------------------
  r.get("/api/cert", (_req, res) => {
    res.json({ current: currentCert() });
  });

  r.post("/api/cert/preflight", async (req, res) => {
    const domain = String((req.body ?? {}).domain ?? "")
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      res.status(400).json({ error: "That does not look like a domain name." });
      return;
    }
    try {
      res.json(await preflight(domain));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  r.post("/api/cert/issue", async (req, res) => {
    const domain = String((req.body ?? {}).domain ?? "")
      .trim()
      .toLowerCase();
    const email = String((req.body ?? {}).email ?? "").trim() || undefined;
    const force = (req.body ?? {}).force === true;
    // "force" skips the DNS pre-check; "renew" passes --force to acme.sh, which
    // are different things and were worth separating.
    const renew = (req.body ?? {}).renew === true;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      res.status(400).json({ error: "That does not look like a domain name." });
      return;
    }
    // The pre-check is not advisory: issuing against an unpointed domain only
    // spends a rate limit. "force" exists for DNS-01, which needs no A record.
    const check = await preflight(domain).catch(() => null);
    if (check && !check.ok && !force) {
      res.status(409).json({ error: check.detail, reason: check.reason, preflight: check });
      return;
    }
    try {
      res.json(await issue(domain, email, renew));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  r.post("/api/cert/complete-dns", async (req, res) => {
    const domain = String((req.body ?? {}).domain ?? "")
      .trim()
      .toLowerCase();
    try {
      res.json(await completeDns(domain));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // --- integrated MCP servers ----------------------------------------------
  // The unified client configuration this host advertises. Read-only in the
  // panel; the tokens shown are placeholders and carry no real credential.
  r.get("/api/mcp-config", (_req, res) => {
    res.type("application/json").send(clientConfigJson());
  });

  // Live reachability of each configured MCP server, polled by /mcp-config.
  r.get("/api/mcp-status", async (_req, res) => {
    const probe = async (s: (typeof mcpServers)[number]) => {
      if (s.transport === "http") {
        if (s.key === "malformed-mcp") return { key: s.key, state: "up" as const };
        if (s.url) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2500);
          try {
            await fetch(s.url, { method: "GET", signal: ctrl.signal });
            return { key: s.key, state: "up" as const };
          } catch {
            return { key: s.key, state: "down" as const };
          } finally {
            clearTimeout(timer);
          }
        }
      }
      if (s.service) {
        const isUp = await new Promise<boolean>((resolve) => {
          execFile("systemctl", ["is-active", "--quiet", s.service!], (err) => {
            resolve(!err);
          });
        });
        if (isUp) return { key: s.key, state: "up" as const };
      }
      const needle =
        (s.args ?? []).find((a) => a.includes("mcp") || a.includes("server-")) ??
        s.command ??
        s.key;
      const running = await new Promise<boolean>((resolve) => {
        execFile("pgrep", ["-f", needle], (err, stdout) => {
          resolve(!err && stdout.trim().length > 0);
        });
      });
      return { key: s.key, state: running ? ("up" as const) : ("down" as const) };
    };
    const results = await Promise.all(mcpServers.map(probe));
    res.type("application/json").send(JSON.stringify(results));
  });

  r.get("/api/mcp-tools", async (req, res) => {
    const key = String(req.query.key ?? "");
    const entry = mcpServers.find((s) => s.key === key);
    if (!entry) {
      res.status(404).json({ error: "No such server." });
      return;
    }
    const force = req.query.force === "1";
    res.json(await listServerTools(entry, force));
  });

  r.get("/api/mcp-updates", async (_req, res) => {
    res.json(await Promise.all(mcpServers.map((s) => checkUpdate(s))));
  });

  r.post("/api/mcp-update", async (req, res) => {
    const key = String((req.body ?? {}).key ?? "");
    const entry = mcpServers.find((s) => s.key === key);
    if (!entry) {
      res.status(404).json({ error: "No such server." });
      return;
    }
    audit("mcp_update_requested", { key });
    const result = await applyUpdate(entry);
    res.status(result.ok ? 200 : 500).json(result);
  });

  r.get("/mcp-config", (_req, res) => {
    const cards = mcpServers
      .map((s) => {
        const target =
          s.transport === "http"
            ? s.url ?? ""
            : `${s.command ?? ""} ${(s.args ?? []).join(" ")}`.trim();
        const key = escapeHtml(s.key);
        const service = s.service
          ? `<span class="sub" style="margin:0">service <code>${escapeHtml(s.service)}</code></span>`
          : "";
        return `<div class="card" data-server="${key}">
          <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px">
            <div>
              <div class="row" style="gap:10px">
                <h2 style="margin:0">${key}</h2>
                <span class="badge unknown" data-status="${key}">checking...</span>
                <span class="badge unknown" data-upd="${key}">updates...</span>
              </div>
              <p class="sub" style="margin:6px 0 0">${escapeHtml(s.note)}</p>
            </div>
            <div class="row">
              <button class="btn-sm" onclick="toggleTools('${key}')">Toggle tools</button>
              <button class="btn-sm btn-ghost" data-updbtn="${key}" onclick="updateServer('${key}')" style="display:none">Update</button>
            </div>
          </div>
          <div class="row" style="gap:16px;margin-top:10px">
            <span class="sub" style="margin:0">transport <code>${escapeHtml(s.transport)}</code></span>
            <span class="sub" style="margin:0">target <code>${escapeHtml(target)}</code></span>
            ${service}
          </div>
          <div class="msg" data-updmsg="${key}"></div>
          <div data-tools="${key}" style="margin-top:12px"></div>
        </div>`;
      })
      .join("");

    res.type("html").send(
      page(
        "MCP Servers",
        "/mcp-config",
        `<h1>MCP Servers</h1>
        <p class="sub">The MCP servers this host builds and wires together. Live status, each server's tools, and one-click updates. Bearer tokens shown are placeholders - issue real ones from <a href="/profiles">GitHub Profiles</a> or runtime/token.txt.</p>
        ${cards}
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center">
            <h2 style="margin:0">Client configuration</h2>
            <button class="btn-sm" onclick="copycfg()">Copy JSON</button>
          </div>
          <div id="cfgmsg" class="msg"></div>
          <pre class="cfg" id="cfg">${escapeHtml(clientConfigJson())}</pre>
        </div>
        <script>
        const ESC=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        async function refreshStatus(){
          try{const r=await fetch('/api/mcp-status');const list=await r.json();
            for(const it of list){const el=document.querySelector('[data-status="'+it.key+'"]');if(!el)continue;
              el.className='badge '+(it.state==='up'?'up':(it.state==='down'?'down':'unknown'));
              el.textContent=it.state==='up'?'running':(it.state==='down'?'stopped':'unknown');}
          }catch(e){}
        }
        async function refreshUpdates(){
          try{const r=await fetch('/api/mcp-updates');const list=await r.json();
            for(const u of list){
              const b=document.querySelector('[data-upd="'+u.key+'"]');
              const btn=document.querySelector('[data-updbtn="'+u.key+'"]');
              if(b){
                if(u.error){b.className='badge unknown';b.textContent='update check failed';}
                else if(u.updateAvailable){b.className='badge down';b.textContent='update available'+(u.latest?' -> '+u.latest:'');}
                else if(u.kind==='self'){b.className='badge unknown';b.textContent='managed by deploy';}
                else{b.className='badge up';b.textContent='up to date'+(u.latest?' ('+u.latest+')':'');}
              }
              if(btn){btn.style.display=(u.kind==='self')?'none':'';btn.title=u.note||'';}
            }
          }catch(e){}
        }
        async function fillTools(key,box){
          box.innerHTML='<p class="sub" style="margin:0">Loading tools\u2026</p>';
          try{const r=await fetch('/api/mcp-tools?key='+encodeURIComponent(key));const d=await r.json();
            if(d.error){box.innerHTML='<p class="sub" style="margin:0">Could not list tools: '+ESC(d.error)+'</p>';return;}
            const tools=d.tools||[];
            if(!tools.length){box.innerHTML='<p class="sub" style="margin:0">No tools reported.</p>';return;}
            const rows=tools.map(t=>'<tr><td><code>'+ESC(t.name)+'</code></td><td>'+ESC(t.description||'')+'</td></tr>').join('');
            box.innerHTML='<div class="sub" style="margin:0 0 8px">'+tools.length+' tools</div>'+
              '<table class="mcp"><thead><tr><th>Tool</th><th>Description</th></tr></thead><tbody>'+rows+'</tbody></table>';
          }catch(e){box.innerHTML='<p class="sub" style="margin:0">Could not reach the server.</p>';}
        }
        async function toggleTools(key){
          const box=document.querySelector('[data-tools="'+key+'"]');
          if(!box)return;
          if(box.style.display!=='none'){box.style.display='none';return;}
          box.style.display='block';await fillTools(key,box);
        }
        async function loadAllTools(){
          const boxes=document.querySelectorAll('[data-tools]');
          for(const box of boxes){box.style.display='block';await fillTools(box.getAttribute('data-tools'),box);}
        }
        async function updateServer(key){
          if(!confirm('Update '+key+' now? This pulls the latest version and restarts the service.'))return;
          const m=document.querySelector('[data-updmsg="'+key+'"]');
          if(m){m.className='msg good show';m.textContent='Updating '+key+'... this can take a minute.';}
          try{const r=await fetch('/api/mcp-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key})});
            const d=await r.json().catch(()=>({}));
            if(m){
              if(r.ok&&d.ok){m.className='msg good show';m.innerHTML='Updated '+ESC(key)+'.<pre class="cfg" style="margin-top:10px">'+ESC(d.log||'')+'</pre>';}
              else{m.className='msg err show';m.innerHTML='Update failed.<pre class="cfg" style="margin-top:10px">'+ESC((d&&d.log)||(d&&d.error)||'')+'</pre>';}
            }
            refreshStatus();refreshUpdates();
          }catch(e){if(m){m.className='msg err show';m.textContent='Could not reach the server to update.';}}
        }
        async function copycfg(){
          const t=document.getElementById('cfg').textContent;
          const m=document.getElementById('cfgmsg');
          try{await navigator.clipboard.writeText(t);m.textContent='Copied to clipboard.';m.className='msg good show';}
          catch(e){m.textContent='Copy failed - select the text and copy manually.';m.className='msg err show';}
        }
        refreshStatus();refreshUpdates();loadAllTools();setInterval(refreshStatus,10000);
        </script>`,
      ),
    );
  });

  r.get("/", (_req, res) => {
    const profiles = allProfiles();
    const cert = currentCert();
    const warning = mustChangePassword()
      ? `<div class="msg err show">This account still uses the password generated at install time. 
         <a href="/account">Change it now</a>.</div>`
      : "";
    const pending = restartPending()
      ? `<div class="msg err show">Settings have been saved that are not yet running.
         <a href="/settings">Restart to apply them</a>.</div>`
      : "";

    res.type("html").send(
      page(
        "Dashboard",
        "/",
        `${warning}${pending}
        <h1>Dashboard</h1>
        <p class="sub">Malformed-MCP is serving the panel and the MCP endpoint on one port.</p>
        <div class="card"><div class="grid">
          <div class="stat"><div class="k">Status</div><div class="v ok">Running</div></div>
          <div class="stat"><div class="k">Version</div><div class="v">${escapeHtml(config.version)}</div></div>
          <div class="stat"><div class="k">Listening on</div><div class="v">${config.bind}:${config.port}</div></div>
          <div class="stat"><div class="k">MCP endpoint</div><div class="v">/mcp</div></div>
          <div class="stat"><div class="k">GitHub profiles</div><div class="v">${profiles.length}</div></div>
          <div class="stat"><div class="k">Uptime</div><div class="v">${Math.round(process.uptime())}s</div></div>
          <div class="stat"><div class="k">MCP servers</div><div class="v"><a href="/mcp-config">${mcpServers.length}</a></div></div>
          <div class="stat"><div class="k">TLS</div><div class="v">${cert ? escapeHtml(cert.domain) : "off"}</div></div>
          <div class="stat"><div class="k">Read-only</div><div class="v">${config.readOnly ? "on" : "off"}</div></div>
        </div></div>`,
      ),
    );
  });

  r.get("/account", (_req, res) => {
    const notice = mustChangePassword()
      ? `<div class="msg err show">You are still using the generated install password.</div>`
      : "";
    res.type("html").send(
      page(
        "Account",
        "/account",
        `${notice}
        <h1>Account</h1>
        <p class="sub">This panel has one password and no username. Change it here.</p>
        <div class="card" style="max-width:460px">
          <div id="msg" class="msg"></div>
          <div class="field"><label for="cur">Current password</label>
            <input id="cur" type="password" autocomplete="current-password"></div>
          <div class="field"><label for="nw">New password</label>
            <input id="nw" type="password" autocomplete="new-password"></div>
          <div class="field"><label for="cf">Confirm new password</label>
            <input id="cf" type="password" autocomplete="new-password"></div>
          <button id="save">Save changes</button>
        </div>
        <script>
        const m=document.getElementById('msg');
        function say(t,good){m.textContent=t;m.className='msg show '+(good?'good':'err');}
        document.getElementById('save').addEventListener('click',async()=>{
          if(nw.value!==cf.value){say('The new passwords do not match.');return;}
          const r=await fetch('/api/account',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({current:cur.value,next:nw.value})});
          const d=await r.json().catch(()=>({}));
          if(r.ok){say('Saved. Sign in again with the new password.',true);
            setTimeout(()=>location.href='/logout',1400);}
          else say(d.error||'Could not save.');
        });
        </script>`,
      ),
    );
  });

  r.post("/api/account", (req, res) => {
    const { current, next } = (req.body ?? {}) as Record<string, string>;
    if (!verifyLogin(String(current ?? ""))) {
      res.status(403).json({ error: "Current password is incorrect." });
      return;
    }
    const wanted = String(next ?? "");
    if (wanted.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters." });
      return;
    }
    changePassword(wanted);
    audit("panel_password_changed", { ip: req.ip });
    res.json({ ok: true });
  });

  r.get("/profiles", (_req, res) => {
    res.type("html").send(
      page(
        "GitHub Profiles",
        "/profiles",
        `<h1>GitHub Profiles</h1>
        <p class="sub">Add an account with a personal access token. Everything else — login, name,
        repositories — is read from the token. Each profile gets its own MCP token that can only
        ever act as that account.</p>

        <div class="card">
          <h2>Endpoints</h2>
          <p class="sub" style="margin:0 0 12px">Point your agent at the MCP URL and authenticate with
          the token of whichever profile below it should act as.</p>
          <div id="endmsg" class="msg"></div>
          <div class="field"><label for="mcpurl">MCP endpoint URL</label>
            <div class="row">
              <input id="mcpurl" readonly onclick="this.select()" style="flex:1">
              <button class="btn-sm btn-ghost" onclick="copyfield('mcpurl','MCP endpoint URL','endmsg')">Copy</button>
            </div></div>
          <div class="field"><label for="healthurl">Health check URL</label>
            <div class="row">
              <input id="healthurl" readonly onclick="this.select()" style="flex:1">
              <button class="btn-sm btn-ghost" onclick="copyfield('healthurl','Health check URL','endmsg')">Copy</button>
            </div></div>
          <p class="sub" style="margin:12px 0 0">The health URL needs no token, so it is the quickest way
          to prove the server is reachable from wherever your agent runs.</p>
        </div>

        <div class="card">
          <h2>Add a profile</h2>
          <div id="addmsg" class="msg"></div>
          <div class="field"><label for="tok">GitHub personal access token</label>
            <input id="tok" type="password" placeholder="ghp_... or github_pat_..." autocomplete="off"></div>
          <div class="field"><label for="drepo">Default repository (optional)</label>
            <input id="drepo" placeholder="owner/name"></div>
          <button id="add">Add profile</button>
        </div>

        <div id="list"></div>

        <script>
        const listEl=document.getElementById('list'), addmsg=document.getElementById('addmsg');
        const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        function say(el,t,good){el.textContent=t;el.className='msg show '+(good?'good':'err');}
        const endmsg=document.getElementById('endmsg');

        // Built from location.origin rather than rendered server-side, so the
        // URL you copy is always the one that actually reached this page -
        // right scheme, right host, right port - instead of whatever the
        // configured public host happens to say.
        document.getElementById('mcpurl').value=location.origin+'/mcp';
        document.getElementById('healthurl').value=location.origin+'/health';

        async function copyfield(id,label,msgId){
          const el=document.getElementById(id);
          const box=document.getElementById(msgId)||addmsg;
          el.select();
          // navigator.clipboard needs a secure context and permission, neither
          // guaranteed. Selecting the text first means the manual fallback is
          // one keystroke rather than a dead button.
          try{ await navigator.clipboard.writeText(el.value); say(box,label+' copied to the clipboard.',true); }
          catch(e){ say(box,label+' selected \u2014 press Ctrl+C to copy it.',true); }
        }

        async function load(){
          listEl.innerHTML='<div class="card"><p class="sub" style="margin:0">Loading profiles\u2026</p></div>';
          let r,d;
          try{ r=await fetch('/api/profiles',{cache:'no-store'}); d=await r.json(); }
          catch(e){ listEl.innerHTML='<div class="msg err show">Could not reach the server to list profiles.</div>'; return; }
          // An expired session used to fall through to "No profiles yet.", which
          // reads as an empty account rather than a sign-in problem. The two have
          // to look different or the operator debugs the wrong thing entirely.
          if(r.status===401){
            listEl.innerHTML='<div class="msg err show">Your session has expired. <a href="/login">Sign in again</a>.</div>'; return; }
          if(!r.ok){
            listEl.innerHTML='<div class="msg err show">'+esc((d&&d.error)||('The server answered '+r.status+'.'))+'</div>'; return; }
          if(!d.profiles||!d.profiles.length){
            listEl.innerHTML='<div class="card"><p class="sub" style="margin:0">No profiles yet.</p></div>';return;}
          listEl.innerHTML=d.profiles.map(p=>\`
            <div class="card">
              <div class="row" style="justify-content:space-between">
                <div><h2 style="margin:0">\${esc(p.name)} <span class="sub">@\${esc(p.login)}</span></h2>
                  <div class="sub" style="margin:4px 0 0">\${esc(p.type||'User')} &middot; workspace: profiles/\${esc(p.workspace)}</div></div>
                <div class="row">
                  <button class="btn-sm" onclick="repos('\${esc(p.login)}')">Repositories</button>
                  <button class="btn-sm btn-ghost" onclick="rotate('\${esc(p.login)}')">Rotate token</button>
                  <button class="btn-sm btn-danger" onclick="del('\${esc(p.login)}')">Remove</button>
                </div>
              </div>
              <div class="field" style="margin-top:14px"><label>MCP token for this account</label>
                <div class="row">
                  <input id="mcp-\${esc(p.login)}" readonly value="\${esc(p.mcpToken)}" onclick="this.select()" style="flex:1">
                  <button class="btn-sm btn-ghost" onclick="copytok('\${esc(p.login)}')">Copy</button>
                </div></div>
              <div class="field"><label>Default repository</label>
                <div class="row">
                  <input id="repo-\${esc(p.login)}" value="\${esc(p.repo||'')}" placeholder="owner/name" style="flex:1">
                  <button class="btn-sm" onclick="saverepo('\${esc(p.login)}')">Save</button>
                </div></div>
              <div id="repos-\${esc(p.login)}"></div>
            </div>\`).join('');
        }

        document.getElementById('add').addEventListener('click',async()=>{
          const btn=document.getElementById('add'); btn.disabled=true;
          const r=await fetch('/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({token:tok.value,repo:drepo.value})});
          const d=await r.json().catch(()=>({})); btn.disabled=false;
          if(r.ok){say(addmsg,'Added @'+d.login+'.',true);tok.value='';drepo.value='';load();}
          else say(addmsg,d.error||'Could not add that token.');
        });

        async function copytok(login){
          await copyfield('mcp-'+login,'MCP token for @'+login,'addmsg');
        }
        async function saverepo(login){
          const repo=document.getElementById('repo-'+login).value.trim();
          const r=await fetch('/api/profiles/'+encodeURIComponent(login)+'/repo',{method:'POST',
            headers:{'Content-Type':'application/json'},body:JSON.stringify({repo})});
          const d=await r.json().catch(()=>({}));
          if(r.ok) say(addmsg,'Default repository saved for @'+login+'.',true);
          else say(addmsg,d.error||'Could not save that repository.');
        }
        async function del(login){
          if(!confirm('Remove @'+login+'? Cloned working trees are kept on disk.'))return;
          await fetch('/api/profiles/'+encodeURIComponent(login),{method:'DELETE'}); load();
        }
        async function rotate(login){
          if(!confirm('Rotate the MCP token for @'+login+'? Agents using the old one stop working.'))return;
          await fetch('/api/profiles/'+encodeURIComponent(login)+'/rotate',{method:'POST'}); load();
        }
        async function repos(login){
          const box=document.getElementById('repos-'+login);
          box.innerHTML='<p class="sub">Loading repositories…</p>';
          const r=await fetch('/api/profiles/'+encodeURIComponent(login)+'/repos');
          const d=await r.json();
          if(!r.ok){box.innerHTML='<div class="msg err show">'+esc(d.error)+'</div>';return;}
          box.innerHTML='<div class="grid" style="margin-top:8px">'+d.repos.map(x=>\`
            <div class="stat">
              <div class="v" style="font-size:14px">\${esc(x.name)} \${x.private?'<span class="sub">private</span>':''}</div>
              <div class="k" style="margin:6px 0">\${x.cloned?'<span class="ok">cloned</span>':'not cloned'}</div>
              <div class="row">
                \${x.cloned
                  ? \`<button class="btn-sm btn-ghost" onclick="ren('\${login}','\${esc(x.name)}')">Rename</button>\`+
                    \`<button class="btn-sm btn-danger" onclick="delwork('\${login}','\${esc(x.name)}')">Delete</button>\`
                  : \`<button class="btn-sm" onclick="clone('\${login}','\${esc(x.name)}','\${esc(x.cloneUrl)}',this)">Clone</button>\`}
              </div>
            </div>\`).join('')+'</div>';
        }
        async function clone(login,repo,url,btn){
          if(btn){btn.disabled=true;btn.textContent='Cloning...';}
          const r=await fetch('/api/profiles/'+encodeURIComponent(login)+'/clone',{method:'POST',
            headers:{'Content-Type':'application/json'},body:JSON.stringify({repo,cloneUrl:url})});
          const d=await r.json().catch(()=>({}));
          if(!r.ok)alert(d.error||'Clone failed'); repos(login);
        }
        async function ren(login,repo){
          const to=prompt('New name for this working tree:',repo); if(!to)return;
          const r=await fetch('/api/profiles/'+encodeURIComponent(login)+'/rename',{method:'POST',
            headers:{'Content-Type':'application/json'},body:JSON.stringify({from:repo,to})});
          const d=await r.json().catch(()=>({})); if(!r.ok)alert(d.error||'Rename failed'); repos(login);
        }
        async function delwork(login,repo){
          if(!confirm('Delete the working tree for '+repo+'? Uncommitted work is lost.'))return;
          await fetch('/api/profiles/'+encodeURIComponent(login)+'/work/'+encodeURIComponent(repo),{method:'DELETE'});
          repos(login);
        }
        load();
        </script>`,
      ),
    );
  });

  r.get("/settings", (_req, res) => {
    res.type("html").send(
      page(
        "Settings",
        "/settings",
        `<h1>Settings</h1>
        <p class="sub">Changes are written immediately but only take effect after a restart,
        so the server never runs on a half-applied configuration.</p>
        <div id="banner" class="msg"></div>
        <div id="cats"></div>
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <div><h2 style="margin:0">Apply changes</h2>
              <div class="sub" style="margin:4px 0 0">Restarting drops open MCP sessions.</div></div>
            <div class="row">
              <button id="save">Save</button>
              <button id="restart" class="btn-danger">Restart now</button>
            </div>
          </div>
        </div>

        <script>
        const cats=document.getElementById('cats'), banner=document.getElementById('banner');
        const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        let dirty={};

        function say(t,good){banner.textContent=t;banner.className='msg show '+(good?'good':'err');}

        function control(f){
          const id='f_'+f.key.replace(/\\./g,'_');
          const v=f.saved;
          if(f.type==='boolean')
            return '<select id="'+id+'" data-key="'+f.key+'"><option value="true"'+(v?' selected':'')+
                   '>Enabled</option><option value="false"'+(!v?' selected':'')+'>Disabled</option></select>';
          if(f.type==='choice')
            return '<select id="'+id+'" data-key="'+f.key+'">'+f.choices.map(c=>
                   '<option'+(c===v?' selected':'')+'>'+esc(c)+'</option>').join('')+'</select>';
          if(f.type==='list')
            return '<input id="'+id+'" data-key="'+f.key+'" value="'+esc((v||[]).join(', '))+
                   '" placeholder="comma separated">';
          return '<input id="'+id+'" data-key="'+f.key+'" value="'+esc(v)+'"'+
                 (f.type==='number'?' type="number"':'')+'>';
        }

        async function load(){
          cats.innerHTML='<div class="card"><p class="sub" style="margin:0">Loading settings...</p></div>';
          let r,d;
          try{ r=await fetch('/api/settings',{cache:'no-store'}); d=await r.json(); }
          catch(e){ cats.innerHTML='<div class="msg err show">Could not reach the server to load settings.</div>'; return; }
          if(r.status===401){
            cats.innerHTML='<div class="msg err show">Your session has expired. <a href="/login">Sign in again</a>.</div>'; return; }
          if(!r.ok||!d.categories){
            cats.innerHTML='<div class="msg err show">'+esc((d&&d.error)||('The server answered '+r.status+'.'))+'</div>'; return; }
          if(d.restartPending) say('Saved settings are waiting for a restart.');
          cats.innerHTML=d.categories.map(c=>
            '<div class="card"><h2>'+esc(c.name)+'</h2><p class="sub">'+esc(c.blurb)+'</p>'+
            c.fields.map(f=>'<div class="field"><label for="f_'+f.key.replace(/\\./g,'_')+'">'+
              esc(f.label)+(f.changed?' <span class="warn">(pending restart)</span>':'')+'</label>'+
              control(f)+(f.help?'<div class="sub" style="margin:5px 0 0;font-size:12px">'+esc(f.help)+'</div>':'')+
              '</div>').join('')+'</div>').join('');
          cats.querySelectorAll('[data-key]').forEach(el=>
            el.addEventListener('change',()=>{dirty[el.dataset.key]=el.value;}));
        }

        document.getElementById('save').addEventListener('click',async()=>{
          if(!Object.keys(dirty).length){say('Nothing changed.',true);return;}
          const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify(dirty)});
          const d=await r.json().catch(()=>({}));
          if(!r.ok){say(d.error||'Could not save.');return;}
          dirty={}; say(d.note||'Saved.',true); load();
        });

        document.getElementById('restart').addEventListener('click',async()=>{
          if(!confirm('Restart Malformed-MCP now? Open MCP sessions will be dropped.'))return;
          await fetch('/api/restart',{method:'POST'});
          say('Restarting… this page will reload shortly.',true);
          let tries=0;
          const poll=setInterval(async()=>{
            tries++;
            try{ const h=await fetch('/health',{cache:'no-store'});
                 if(h.ok){clearInterval(poll);location.reload();} }catch(e){}
            if(tries>40){clearInterval(poll);say('Server did not come back. Check: systemctl status malformed-mcp');}
          },1500);
        });

        load();
        </script>`,
      ),
    );
  });

  r.get("/certificate", (_req, res) => {
    const cert = currentCert();
    res.type("html").send(
      page(
        "Certificate",
        "/certificate",
        `<h1>Certificate</h1>
        <p class="sub">Issues a Let's Encrypt certificate and serves the panel over HTTPS on the
        same port. Ports 80 and 443 do not need to be free — they are borrowed only for the few
        seconds the challenge takes, then handed straight back.</p>

        <div class="card">
          <h2>Current</h2>
          <div id="curbox">${
            cert
              ? `<div class="grid">
                   <div class="stat"><div class="k">Domain</div><div class="v">${escapeHtml(cert.domain)}</div></div>
                   <div class="stat"><div class="k">Method</div><div class="v">${escapeHtml(cert.method)}</div></div>
                   <div class="stat"><div class="k">Issued</div><div class="v">${escapeHtml(cert.issuedAt.slice(0, 10))}</div></div>
                 </div>`
              : `<p class="sub" style="margin:0">No certificate yet. The panel is being served over plain HTTP.</p>`
          }</div>
        </div>

        <div class="card">
          <h2>Issue a certificate</h2>
          <div id="msg" class="msg"></div>
          <div class="field"><label for="dom">Domain</label>
            <input id="dom" placeholder="mcp.example.com" value="${escapeHtml(cert?.domain ?? "")}"></div>
          <div class="field"><label for="em">Contact email (optional)</label>
            <input id="em" placeholder="you@example.com"></div>
          <div class="row">
            <button id="check" class="btn-ghost">Check DNS</button>
            <button id="go">Issue certificate</button>
          </div>
          <div id="dnsbox"></div>
        </div>

        <script>
        const msg=document.getElementById('msg'), dnsbox=document.getElementById('dnsbox');
        const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        function say(t,good){msg.innerHTML=t;msg.className='msg show '+(good?'good':'err');}
        const post=(u,b)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});

        document.getElementById('check').addEventListener('click',async()=>{
          say('Checking DNS\u2026',true);
          try{
            const r=await post('/api/cert/preflight',{domain:dom.value});
            const d=await r.json().catch(()=>({}));
            say(esc(d.detail||d.error||('The server answered '+r.status+'.')), d.ok);
          }catch(e){ say('Could not reach the server to check DNS.'); }
        });

        document.getElementById('go').addEventListener('click',async()=>{
          const btn=document.getElementById('go'); btn.disabled=true;
          say('Issuing\u2026 this can take a minute. Do not close this page.',true);
          // Whatever happens - a rejected response, a dropped connection, a
          // body that is not JSON - the button has to come back, or the page
          // is left with no way to try again short of a reload.
          try{
            const r=await post('/api/cert/issue',{domain:dom.value,email:em.value});
            const d=await r.json().catch(()=>({error:'The server answered '+r.status+'.'}));
            if(r.status===409){
              say(esc(d.error)+'<br><br><button class="btn-sm" onclick="force()">Issue anyway using DNS-01</button>');
              return;
            }
            render(d);
          }catch(e){
            say('Could not reach the server, so nothing was issued.');
          }finally{
            btn.disabled=false;
          }
        });

        window.force=async()=>{
          say('Issuing via DNS-01\u2026',true);
          const r=await post('/api/cert/issue',{domain:dom.value,email:em.value,force:true});
          render(await r.json());
        };

        // The Current card is re-read from /api/cert rather than reloaded with
        // the page: an issuance that just succeeded should be visible without
        // the operator wondering whether a refresh would lose anything.
        async function refreshCurrent(){
          try{
            const r=await fetch('/api/cert');
            const c=(await r.json()).current;
            document.getElementById('curbox').innerHTML = c
              ? '<div class="grid">'+
                '<div class="stat"><div class="k">Domain</div><div class="v">'+esc(c.domain)+'</div></div>'+
                '<div class="stat"><div class="k">Method</div><div class="v">'+esc(c.method)+'</div></div>'+
                '<div class="stat"><div class="k">Issued</div><div class="v">'+esc(String(c.issuedAt).slice(0,10))+'</div></div>'+
                '</div>'
              : '<p class="sub" style="margin:0">No certificate yet. The panel is being served over plain HTTP.</p>';
            if(c&&c.domain&&!dom.value) dom.value=c.domain;
          }catch(e){/* the card keeps its previous contents */}
        }

        function render(d){
          if(d.ok){
            refreshCurrent();
            if(d.reused){
              say('Nothing to do \u2014 the certificate for '+esc(d.domain)+' is still valid'+
                  (d.expiresAt?' until '+esc(d.expiresAt):'')+', and has been reinstalled.'+
                  '<br><br><button class="btn-sm" onclick="renew()">Force renewal anyway</button>',true);
            } else {
              say('Certificate issued via '+esc(d.method)+'. Restart to serve HTTPS: '+
                  '<a href="/settings">go to Settings</a>.',true);
            }
            dnsbox.innerHTML=''; return;
          }
          const tried=(d.attempts||[]).map(a=>'<li>'+esc(a.method)+': '+(a.ok?'ok':esc(a.error||'failed'))+'</li>').join('');
          say(esc(d.error||'Issuance failed.')+(tried?'<ul style="margin:8px 0 0 18px">'+tried+'</ul>':''));
          if(d.dnsChallenge){
            dnsbox.innerHTML='<div class="card" style="margin-top:16px"><h2>Publish this TXT record</h2>'+
              '<div class="field"><label>Name</label><input readonly value="'+esc(d.dnsChallenge.record)+'" onclick="this.select()"></div>'+
              '<div class="field"><label>Value</label><input readonly value="'+esc(d.dnsChallenge.value)+'" onclick="this.select()"></div>'+
              '<button onclick="finish()">I have published it \u2014 continue</button></div>';
          }
        }

        window.renew=async()=>{
          say('Forcing renewal\u2026 this can take a minute.',true);
          const r=await post('/api/cert/issue',{domain:dom.value,email:em.value,renew:true});
          render(await r.json());
        };

        window.finish=async()=>{
          say('Verifying the TXT record\u2026',true);
          const r=await post('/api/cert/complete-dns',{domain:dom.value});
          render(await r.json());
        };
        </script>`,
      ),
    );
  });

  return r;
}
