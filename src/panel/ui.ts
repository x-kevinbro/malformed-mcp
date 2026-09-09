/**
 * The panel's markup and styling.
 *
 * Rendered as strings rather than through a framework: the panel is a handful
 * of pages, and adding a build step for React would mean the folder could no
 * longer be run straight from a checkout - which is the one property this
 * server is meant to keep.
 *
 * The palette follows the 3x-ui panel: near-black background, raised cards a
 * shade lighter, and a cyan/teal accent for anything interactive.
 */
import { config } from "../config.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{
  --bg:#0b0e14; --bg-2:#11151d; --card:#151a24; --card-2:#1b212d;
  --line:#232b39; --text:#e6edf3; --muted:#8b98ab;
  --accent:#22d3ee; --accent-2:#2ee6a8; --danger:#f8617a; --warn:#f0b232;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg); color:var(--text); min-height:100vh; display:flex; flex-direction:column;
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,sans-serif;
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

header.topbar{
  display:flex;align-items:center;gap:16px;padding:0 22px;height:56px;
  background:var(--bg-2);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;
}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px}
.brand .mark{
  background:linear-gradient(135deg,var(--accent-2),var(--accent));
  -webkit-background-clip:text;background-clip:text;color:transparent;font-size:19px;font-weight:800;
}
nav.tabs{display:flex;gap:4px;margin-left:auto;flex-wrap:wrap}
nav.tabs a{
  color:var(--muted);padding:7px 13px;border-radius:7px;font-weight:500;
}
nav.tabs a:hover{background:var(--card);color:var(--text);text-decoration:none}
nav.tabs a.on{background:rgba(34,211,238,.12);color:var(--accent)}

main{flex:1;width:100%;max-width:1080px;margin:0 auto;padding:26px 22px 40px}
h1{font-size:21px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 14px;color:var(--text)}
.sub{color:var(--muted);margin:0 0 22px}

.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
.stat{background:var(--card-2);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stat .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.6px}
.stat .v{font-size:19px;font-weight:650;margin-top:5px;word-break:break-all}
.ok{color:var(--accent-2)} .bad{color:var(--danger)} .warn{color:var(--warn)}

label{display:block;margin:0 0 6px;color:var(--muted);font-size:13px}
input,select,textarea{
  width:100%;background:var(--bg);border:1px solid var(--line);color:var(--text);
  border-radius:8px;padding:10px 12px;font-size:14px;font-family:inherit;
}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
.field{margin-bottom:15px}

button,.btn{
  background:var(--accent);color:#04212a;border:0;border-radius:8px;
  padding:10px 17px;font-size:14px;font-weight:650;cursor:pointer;font-family:inherit;
  transition:filter .15s ease,transform .09s ease,box-shadow .15s ease,opacity .15s ease;
}
button:hover,.btn:hover{filter:brightness(1.09);text-decoration:none;transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.35)}
button:active,.btn:active{transform:translateY(1px) scale(.985);filter:brightness(.95);box-shadow:none}
button:focus-visible,.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;filter:none}

/* A button that started a request spins until that request settles. Declared
   here, and driven by the fetch wrapper below, so a button added later cannot
   end up with no feedback because someone forgot to wire it up. */
button.is-busy{opacity:.9;cursor:progress;pointer-events:none}
button.is-busy::after{
  content:"";display:inline-block;width:11px;height:11px;margin-left:8px;vertical-align:-1px;
  border:2px solid currentColor;border-right-color:transparent;border-radius:50%;
  animation:spin .6s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.btn-ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.btn-danger{background:var(--danger);color:#2a0710}
.btn-sm{padding:6px 11px;font-size:13px}
.row{display:flex;gap:9px;flex-wrap:wrap;align-items:center}

.msg{padding:11px 14px;border-radius:8px;margin-bottom:16px;display:none}
.msg.show{display:block}
.msg.err{background:rgba(248,97,122,.12);border:1px solid rgba(248,97,122,.4);color:#ffbac5}
.msg.good{background:rgba(46,230,168,.1);border:1px solid rgba(46,230,168,.35);color:#9dffd8}

footer.credit{
  border-top:1px solid var(--line);background:var(--bg-2);
  padding:16px 22px;text-align:center;color:var(--muted);font-size:13px;
}
footer.credit .by{
  background:linear-gradient(135deg,var(--accent-2),var(--accent));
  -webkit-background-clip:text;background-clip:text;color:transparent;font-weight:700;
}

.login-wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
.login-card{width:100%;max-width:390px}
.login-head{text-align:center;margin-bottom:22px}
.login-head .mark{font-size:30px;font-weight:800;
  background:linear-gradient(135deg,var(--accent-2),var(--accent));
  -webkit-background-clip:text;background-clip:text;color:transparent}

/* Motion. Everything here is feedback for something the operator just did:
   nothing loops, nothing moves on its own, and it all collapses to nothing
   when the operating system asks for reduced motion. */
nav.tabs a{transition:background .15s ease,color .15s ease}
input,select,textarea{transition:border-color .15s ease,box-shadow .15s ease}
input:focus,select:focus,textarea:focus{box-shadow:0 0 0 3px rgba(34,211,238,.12)}
.card,.stat{transition:border-color .18s ease,transform .18s ease}
.stat:hover{border-color:#2c3646}
.msg.show{animation:msg-in .22s ease both}
@keyframes msg-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
main{animation:fade-in .25s ease both}
@keyframes fade-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
}

table.mcp{width:100%;border-collapse:collapse;font-size:13px}
table.mcp th,table.mcp td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
table.mcp th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
table.mcp td code{color:var(--accent)}
pre.cfg{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto;margin:12px 0 0;font-size:12.5px;line-height:1.5}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.badge.up{color:#7ee787;border-color:#2ea04366;background:#2ea04322}
.badge.down{color:#ff7b72;border-color:#f8514966;background:#f8514922}
.badge.unknown{color:var(--muted)}
`;

/**
 * Button feedback, applied once for the whole panel.
 *
 * Every handler here does the same thing - fetch, await, redraw - and a slow
 * call was indistinguishable from a dead one. Rather than edit every handler,
 * the click is remembered and window.fetch is wrapped: whichever button began
 * a request wears a spinner until that request settles, however it settles.
 * Pointer events are dropped rather than setting `disabled`, so the handlers
 * that manage `disabled` themselves are not fought over.
 */
const BUSY_SCRIPT = `<script>
(function(){
  var pending=null;
  document.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('button'):null;
    if(!b||b.disabled)return;
    pending=b;
    setTimeout(function(){if(pending===b)pending=null;},0);
  },true);
  var real=window.fetch.bind(window);
  window.fetch=function(){
    var b=pending; pending=null;
    if(!b||b.dataset.busy)return real.apply(null,arguments);
    b.dataset.busy='1'; b.classList.add('is-busy');
    var done=function(){delete b.dataset.busy;b.classList.remove('is-busy');};
    return real.apply(null,arguments).then(function(r){done();return r;},function(e){done();throw e;});
  };
})();
<\/script>`;

const TABS: Array<[string, string]> = [
  ["/", "Dashboard"],
  ["/profiles", "GitHub Profiles"],
  ["/mcp-config", "MCP Servers"],
  ["/settings", "Settings"],
  ["/certificate", "Certificate"],
  ["/account", "Account"],
];

/** Every page ends with the credit, so no page can be shipped without it. */
function footer(): string {
  return `<footer class="credit">${escapeHtml(config.serverName)} v${escapeHtml(
    config.version,
  )} &middot; <span class="by">${escapeHtml(config.panel.credit)}</span></footer>`;
}

export function page(title: string, active: string, body: string): string {
  const tabs = TABS.map(
    ([href, label]) => `<a href="${href}"${href === active ? ' class="on"' : ""}>${escapeHtml(label)}</a>`,
  ).join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} &middot; Malformed-MCP</title>
<style>${STYLE}</style>
</head><body>
<header class="topbar">
  <div class="brand"><span class="mark">MALFORMED</span><span>MCP</span></div>
  <nav class="tabs">${tabs}<a href="/logout">Sign out</a></nav>
</header>
<main>${body}</main>
${footer()}
${BUSY_SCRIPT}
</body></html>`;
}

/** The login screen carries the same credit, before anyone has authenticated. */
export function loginPage(notice?: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in &middot; Malformed-MCP</title>
<style>${STYLE}</style>
</head><body>
<div class="login-wrap"><div class="login-card">
  <div class="login-head">
    <div class="mark">MALFORMED-MCP</div>
    <div class="sub" style="margin:6px 0 0">Control panel</div>
  </div>
  <div class="card">
    <div id="msg" class="msg err"></div>
    ${notice ? `<div class="msg good show">${escapeHtml(notice)}</div>` : ""}
    <form id="f" autocomplete="on">
      <div class="field"><label for="p">Password</label>
        <input id="p" name="password" type="password" autocomplete="current-password" autofocus required></div>
      <button type="submit" style="width:100%">Sign in</button>
    </form>
  </div>
</div></div>
${footer()}
<script>
const f=document.getElementById('f'),m=document.getElementById('msg');
f.addEventListener('submit',async(e)=>{
  e.preventDefault(); m.classList.remove('show');
  const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({password:p.value})});
  const d=await r.json().catch(()=>({}));
  if(r.ok){location.href=d.next||'/';return;}
  m.textContent=d.error||'Sign in failed'; m.classList.add('show');
});
</script>
${BUSY_SCRIPT}
</body></html>`;
}
