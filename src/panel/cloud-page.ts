/** Private operator UI. Provider credentials never appear in rendered HTML. */
export function cloudPageContent(): string {
  return `<h1>Cloud Providers</h1>
        <p class="sub">Enter access tokens here, never in chat or MCP tool arguments. Credentials are
        stored on this server and attached only to requests to the configured provider API.
        Choose a preset (including Koyeb) or add a custom HTTPS API with Bearer or API-key/header auth.
        Use HTTPS or a trusted SSH tunnel. The credential file is permission-restricted, not encrypted at rest.</p>

        <div class="card">
          <h2>Add an account</h2>
          <div id="addmsg" class="msg"></div>
          <div class="field"><label for="prov">Provider</label>
            <select id="prov"></select></div>
          <div id="customfields" style="display:none">
            <div class="field"><label for="cid">Custom API id</label><input id="cid" placeholder="my-provider" autocomplete="off"></div>
            <div class="field"><label for="cname">Provider display name</label><input id="cname" placeholder="My provider"></div>
            <div class="field"><label for="cbase">HTTPS API base URL</label><input id="cbase" type="url" placeholder="https://api.example.com/v1" autocomplete="off">
              <p class="sub">Check the official API hostname before saving. This credential is bound to that exact HTTPS origin. Redirects are refused.</p></div>
            <div class="field"><label for="cauth">Authentication</label><select id="cauth"><option value="bearer">Bearer access token</option><option value="header">API key / custom authentication header</option></select></div>
            <div id="headerfields" style="display:none">
              <div class="field"><label for="cheader">Header name</label><input id="cheader" placeholder="X-API-Key" autocomplete="off"></div>
              <div class="field"><label for="cprefix">Header prefix (optional)</label><input id="cprefix" placeholder="Empty for a raw API key; Token or Basic if required" autocomplete="off"></div>
            </div>
            <p class="sub">Custom credentials are stored without a verification request. OAuth refresh flows and request-signing schemes need a dedicated integration; a token alone cannot implement those.</p>
          </div>
          <div class="field"><label for="aname">Account name (optional)</label>
            <input id="aname" placeholder="Read back from the provider when empty"></div>
          <div class="field" id="emailfield" style="display:none"><label for="aemail">Account email (global API key only)</label>
            <input id="aemail" placeholder="you@example.com" autocomplete="off"></div>
          <div class="field"><label id="toklabel" for="atok">API token</label>
            <input id="atok" type="password" autocomplete="new-password" spellcheck="false">
            <textarea id="asa" rows="6" autocomplete="off" spellcheck="false" style="display:none" placeholder='{"type":"service_account", ...}'></textarea>
            <p class="sub" style="margin:6px 0 0"><a id="tokurl" href="#" target="_blank" rel="noopener" style="display:none">Where to get this credential</a></p></div>
          <div class="field"><label class="row" style="gap:8px;margin:0"><input id="aro" type="checkbox" checked style="width:auto"> Read-only account (GET/HEAD requests only)</label></div>
          <button id="add">Add account</button>
        </div>

        <div id="list"></div>

        <script>
        const listEl=document.getElementById('list'), addmsg=document.getElementById('addmsg');
        const provSel=document.getElementById('prov'), tok=document.getElementById('atok'),
              sa=document.getElementById('asa'), toklabel=document.getElementById('toklabel'),
              tokurl=document.getElementById('tokurl'), emailfield=document.getElementById('emailfield');
        const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        function say(el,t,good){el.textContent=t;el.className='msg show '+(good?'good':'err');}
        let providers=[], accounts=[];

        function syncForm(){
          const custom=provSel.value==='custom';
          const p=providers.find(x=>x.id===provSel.value)||{tokenLabel:'Access token / API key'};
          document.getElementById('customfields').style.display=custom?'block':'none';
          toklabel.textContent=p.tokenLabel;
          sa.style.display=p.isServiceAccount?'block':'none';
          tok.style.display=p.isServiceAccount?'none':'block';
          emailfield.style.display=p.needsEmail?'block':'none';
          if(p.tokenUrl){tokurl.style.display='inline';tokurl.href=p.tokenUrl;}
          else tokurl.style.display='none';
        }
        provSel.addEventListener('change',()=>{tok.value='';sa.value='';document.getElementById('aemail').value='';syncForm();});
        document.getElementById('cauth').addEventListener('change',()=>{
          document.getElementById('headerfields').style.display=document.getElementById('cauth').value==='header'?'block':'none';
        });

        async function load(){
          let r,d;
          try{ r=await fetch('/api/cloud',{cache:'no-store'}); d=await r.json(); }
          catch(e){ listEl.innerHTML='<div class="msg err show">Could not reach the server to list accounts.</div>'; return; }
          if(r.status===401){
            listEl.innerHTML='<div class="msg err show">Your session has expired. <a href="/login">Sign in again</a>.</div>'; return; }
          if(!r.ok){
            listEl.innerHTML='<div class="msg err show">'+esc((d&&d.error)||('The server answered '+r.status+'.'))+'</div>'; return; }

          providers=d.providers||[]; accounts=d.accounts||[];
          if(!provSel.options.length){
            provSel.innerHTML=providers.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('')+'<option value="custom">Custom API (other provider)</option>';
            syncForm();
          }

          if(!accounts.length){
            listEl.innerHTML='<div class="card"><p class="sub" style="margin:0">No cloud accounts yet.</p></div>';return;}

          listEl.innerHTML=accounts.map((a,i)=>{
            const pname=(providers.find(p=>p.id===a.provider)||{}).name||a.provider;
            const badges=[a.isDefault?'<span class="badge up">default</span>':'',
              a.readOnly?'<span class="badge">read-only</span>':'<span class="badge up">writable</span>',
              a.verified?'':'<span class="badge unknown">unverified</span>'].filter(Boolean).join(' ');
            return \`<div class="card">
              <div class="row" style="justify-content:space-between">
                <div><h2 style="margin:0">\${esc(a.name)}</h2>
                  <div class="sub" style="margin:4px 0 0">\${esc(pname)} &middot; added \${esc(String(a.createdAt||'').slice(0,10))}</div>
                  <div class="row" style="margin-top:8px">\${badges}</div></div>
                <div class="row">
                  \${a.isDefault?'':\`<button class="btn-sm" onclick="makedefault(\${i})">Make default</button>\`}
                  <button class="btn-sm btn-ghost" onclick="setro(\${i})">\${a.readOnly?'Make writable':'Make read-only'}</button>
                  <button class="btn-sm btn-ghost" onclick="rotate(\${i})">Rotate token</button>
                  <button class="btn-sm btn-danger" onclick="del(\${i})">Remove</button>
                </div>
              </div>
              <div class="field" style="margin-top:14px"><label>MCP connection token (hidden)</label>
                <p class="sub">Copy only into your MCP client's credential field — never into chat.</p>
                <button class="btn-sm btn-ghost" onclick="copytok(\${i})">Copy MCP connection token</button>
              </div>
            </div>\`;
          }).join('');
        }

        async function copytok(i){
          try{
            const r=await fetch(urlFor(accounts[i])+'/mcp-token',{method:'POST'});
            if(!r.ok)throw new Error('Could not copy the MCP connection token.');
            const d=await r.json();
            await navigator.clipboard.writeText(d.mcpToken);
            say(addmsg,'MCP connection token copied. Paste only into your MCP client, not chat.',true);
          }catch(e){say(addmsg,'Could not copy. Use an HTTPS panel connection and allow clipboard access.');}
        }

        document.getElementById('add').addEventListener('click',async()=>{
          const p=providers.find(x=>x.id===provSel.value);
          const btn=document.getElementById('add'); btn.disabled=true;
          try{
            const r=await fetch('/api/cloud/accounts',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({provider:provSel.value,
                token:(p&&p.isServiceAccount?sa.value:tok.value),
                name:document.getElementById('aname').value,
                email:document.getElementById('aemail').value,
                readOnly:document.getElementById('aro').checked,
                custom:provSel.value==='custom'?{
                  id:document.getElementById('cid').value,name:document.getElementById('cname').value,
                  baseUrl:document.getElementById('cbase').value,auth:document.getElementById('cauth').value,
                  header:document.getElementById('cheader').value,prefix:document.getElementById('cprefix').value
                }:undefined})});
            const d=await r.json().catch(()=>({}));
            if(r.ok){
              say(addmsg,'Added '+d.name+(d.verified?' — credential verified.':' — stored without verification. Test a read-only API call before enabling writes.'),true);
              tok.value='';sa.value='';document.getElementById('aname').value='';document.getElementById('aemail').value='';
              // Include newly configured custom APIs in the provider dropdown.
              const selected=provSel.value; provSel.innerHTML=''; await load();
              if(selected!=='custom'){provSel.value=selected;syncForm();}
            }else say(addmsg,d.error||'Could not add that account.');
          }catch(e){say(addmsg,'Could not reach the server. No credential was returned.');}
          finally{btn.disabled=false;}
        });

        const urlFor=a=>'/api/cloud/accounts/'+encodeURIComponent(a.provider)+'/'+encodeURIComponent(a.slug);
        async function makedefault(i){ await fetch(urlFor(accounts[i])+'/default',{method:'POST'}); load(); }
        async function setro(i){
          const a=accounts[i];
          await fetch(urlFor(a)+'/readonly',{method:'POST',
            headers:{'Content-Type':'application/json'},body:JSON.stringify({readOnly:!a.readOnly})}); load();
        }
        async function rotate(i){
          if(!confirm('Rotate the MCP token for '+accounts[i].name+'? Agents using the old one stop working.'))return;
          await fetch(urlFor(accounts[i])+'/rotate',{method:'POST'}); load();
        }
        async function del(i){
          if(!confirm('Remove '+accounts[i].name+'? The provider credential and its MCP token are deleted.'))return;
          await fetch(urlFor(accounts[i]),{method:'DELETE'}); load();
        }
        load();
        </script>`;
}
