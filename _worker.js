// Prime Vision: Cloudflare Pages worker. Needs D1 binding DB and variable ADMIN_PASSWORD.
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
async function sign(env,msg){const k=await crypto.subtle.importKey('raw',enc.encode('pv|'+env.ADMIN_PASSWORD),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,enc.encode(msg)))}
const eq=(a,b)=>{if(a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);return r===0};
async function authed(req,env){const t=(req.headers.get('authorization')||'').replace('Bearer ','');const [exp,sig]=t.split('.');if(!exp||!sig||+exp<Date.now())return false;return eq(sig,await sign(env,exp))}
const now=()=>new Date().toISOString();
const cap=(v,n)=>String(v==null?'':v).slice(0,n);
const TABLES={products:['name','category','brand','price','stock','description','image','active'],customers:['name','type','phone','city','notes'],orders:['customer_id','customer_name','items','total','status','notes'],requests:['status','notes']};
export default{async fetch(req,env){
 const u=new URL(req.url);const p=u.pathname;
 if(!p.startsWith('/api/'))return env.ASSETS.fetch(req);
 if(!env.DB||!env.ADMIN_PASSWORD)return J({error:'not configured'},503);
 try{
 if(p==='/api/products'&&req.method==='GET'){const r=await env.DB.prepare('SELECT id,name,category,brand,price,stock,description,image FROM products WHERE active=1 ORDER BY id DESC LIMIT 200').all();return J(r.results)}
 if(p==='/api/request'&&req.method==='POST'){const b=await req.json();if(!cap(b.name,100)||!cap(b.phone,30))return J({error:'missing'},400);
  await env.DB.prepare('INSERT INTO requests(name,type,product,qty,phone,notes,status,created) VALUES(?,?,?,?,?,?,?,?)').bind(cap(b.name,100),cap(b.type,40),cap(b.product,80),cap(b.qty,20),cap(b.phone,30),cap(b.notes,500),'جديد',now()).run();return J({ok:true})}
 if(p==='/api/login'&&req.method==='POST'){const b=await req.json();const ok=eq(cap(b.password,200),String(env.ADMIN_PASSWORD));if(!ok)return J({error:'bad'},401);const exp=String(Date.now()+12*3600e3);return J({token:exp+'.'+await sign(env,exp)})}
 if(!await authed(req,env))return J({error:'auth'},401);
 const m=p.match(/^\/api\/admin\/(products|customers|orders|requests)(?:\/(\d+))?$/);
 if(p==='/api/admin/stats'){const q=async s=>(await env.DB.prepare(s).first()).n;return J({products:await q('SELECT COUNT(*) n FROM products'),lowStock:await q('SELECT COUNT(*) n FROM products WHERE stock<=3 AND active=1'),customers:await q('SELECT COUNT(*) n FROM customers'),newRequests:await q("SELECT COUNT(*) n FROM requests WHERE status='جديد'"),openOrders:await q("SELECT COUNT(*) n FROM orders WHERE status NOT IN ('مكتمل','ملغي')"),sales:await q("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status='مكتمل'")})}
 if(p==='/api/admin/export'){const o={};for(const t of['products','customers','orders','requests'])o[t]=(await env.DB.prepare('SELECT * FROM '+t).all()).results;return J(o)}
 if(!m)return J({error:'nf'},404);
 const t=m[1],id=m[2],cols=TABLES[t];
 if(req.method==='GET'&&!id){const r=await env.DB.prepare('SELECT * FROM '+t+' ORDER BY id DESC LIMIT 500').all();return J(r.results)}
 if(req.method==='POST'&&!id&&t!=='requests'){const b=await req.json();const vals=cols.map(c=>c==='price'||c==='total'||c==='stock'||c==='active'||c==='customer_id'?Number(b[c]??(c==='active'?1:0)):(c==='status'&&!b[c]?'جديد':cap(b[c],c==='items'||c==='description'||c==='image'?(c==='image'?600000:4000):300)));
  const extra=t==='products'?['updated']:['created'];const r=await env.DB.prepare(`INSERT INTO ${t}(${cols.concat(extra).join(',')}) VALUES(${cols.concat(extra).map(()=>'?').join(',')})`).bind(...vals,now()).run();return J({id:r.meta.last_row_id})}
 if(req.method==='PUT'&&id){const b=await req.json();const sets=[],vals=[];for(const c of cols)if(c in b){sets.push(c+'=?');vals.push(c==='price'||c==='total'||c==='stock'||c==='active'||c==='customer_id'?Number(b[c]):cap(b[c],c==='image'?600000:4000))}
  if(!sets.length)return J({error:'empty'},400);if(t==='products'){sets.push('updated=?');vals.push(now())}await env.DB.prepare(`UPDATE ${t} SET ${sets.join(',')} WHERE id=?`).bind(...vals,Number(id)).run();return J({ok:true})}
 if(req.method==='DELETE'&&id){await env.DB.prepare(`DELETE FROM ${t} WHERE id=?`).bind(Number(id)).run();return J({ok:true})}
 return J({error:'method'},405);
 }catch(e){return J({error:'server',detail:String(e.message||e).slice(0,200)},500)}
}}
