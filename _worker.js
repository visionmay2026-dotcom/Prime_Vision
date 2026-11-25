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
 if(p.startsWith('/api/admin/acc/'))return acc(req,env,p,u);
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

// Accounting module (separate section): simple entries + payments, no tax assumptions.
let accReady=false;
async function accSetup(db){if(accReady)return;await db.batch([db.prepare('CREATE TABLE IF NOT EXISTS acc_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,date TEXT,type TEXT,party TEXT,description TEXT,amount REAL,paid REAL DEFAULT 0,method TEXT,notes TEXT,created TEXT)'),db.prepare('CREATE TABLE IF NOT EXISTS acc_payments(id INTEGER PRIMARY KEY AUTOINCREMENT,entry_id INTEGER,date TEXT,amount REAL,method TEXT,created TEXT)')]);for(const s of['ALTER TABLE acc_entries ADD COLUMN vat REAL DEFAULT 0','ALTER TABLE acc_entries ADD COLUMN vat_rate REAL DEFAULT 0','ALTER TABLE acc_payments ADD COLUMN bank_id INTEGER DEFAULT 0']){try{await db.prepare(s).run()}catch(e){}}
 await db.batch([db.prepare('CREATE TABLE IF NOT EXISTS acc_banks(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,account_no TEXT,opening REAL DEFAULT 0,created TEXT)'),db.prepare('CREATE TABLE IF NOT EXISTS acc_banktx(id INTEGER PRIMARY KEY AUTOINCREMENT,date TEXT,kind TEXT,bank_id INTEGER,to_bank_id INTEGER DEFAULT 0,amount REAL,description TEXT,created TEXT)'),db.prepare('CREATE TABLE IF NOT EXISTS acc_custody(id INTEGER PRIMARY KEY AUTOINCREMENT,person TEXT,notes TEXT,created TEXT)'),db.prepare('CREATE TABLE IF NOT EXISTS acc_custx(id INTEGER PRIMARY KEY AUTOINCREMENT,custody_id INTEGER,date TEXT,kind TEXT,amount REAL,description TEXT,bank_id INTEGER DEFAULT 0,created TEXT)')]);
 accReady=true}
const VAT_RATE=17;const r2=x=>Math.round(x*100)/100;const dOk=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)?d:now().slice(0,10);
async function acc(req,env,p,u){const db=env.DB;await accSetup(db);const sub=p.slice('/api/admin/acc/'.length);
 if(sub==='entries'&&req.method==='GET'){const r=await db.prepare('SELECT * FROM acc_entries ORDER BY date DESC,id DESC LIMIT 2000').all();return J(r.results)}
 if(sub==='payments'&&req.method==='GET'){const r=await db.prepare('SELECT p.id,p.entry_id,p.date,p.amount,p.method,p.bank_id,e.type,e.party,e.description FROM acc_payments p JOIN acc_entries e ON e.id=p.entry_id ORDER BY p.date ASC,p.id ASC LIMIT 5000').all();return J(r.results)}
 if(sub==='entries'&&req.method==='POST'){const b=await req.json();const type=String(b.type);if(!['sale','purchase','expense'].includes(type))return J({error:'type'},400);const base=Number(b.amount);if(!(base>0))return J({error:'amount'},400);const useVat=type!=='expense'&&(b.vat_on==1||b.vat_on===true);const vat=useVat?r2(base*VAT_RATE/100):0;const amount=r2(base+vat);let paid=b.paid==='full'?amount:Number(b.paid||0);if(!(paid>=0))paid=0;if(paid>amount)paid=amount;const date=dOk(b.date);const bank=Number(b.bank_id)||0;
  const r=await db.prepare('INSERT INTO acc_entries(date,type,party,description,amount,paid,method,notes,created,vat,vat_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(date,type,cap(b.party,100),cap(b.description,300),amount,paid,cap(b.method,40),cap(b.notes,500),now(),vat,useVat?VAT_RATE:0).run();const id=r.meta.last_row_id;
  if(paid>0)await db.prepare('INSERT INTO acc_payments(entry_id,date,amount,method,created,bank_id) VALUES(?,?,?,?,?,?)').bind(id,date,paid,cap(b.method,40),now(),bank).run();return J({id,amount,vat})}
 if(sub==='pay'&&req.method==='POST'){const b=await req.json();const id=Number(b.entry_id);const e=await db.prepare('SELECT amount,paid FROM acc_entries WHERE id=?').bind(id).first();if(!e)return J({error:'nf'},404);const rem=e.amount-e.paid;const a=Number(b.amount);if(!(a>0)||a>rem+1e-9)return J({error:'amount',remaining:rem},400);const date=/^\d{4}-\d{2}-\d{2}$/.test(b.date)?b.date:now().slice(0,10);
  await db.batch([db.prepare('INSERT INTO acc_payments(entry_id,date,amount,method,created,bank_id) VALUES(?,?,?,?,?,?)').bind(id,date,a,cap(b.method,40),now(),Number(b.bank_id)||0),db.prepare('UPDATE acc_entries SET paid=paid+? WHERE id=?').bind(a,id)]);return J({ok:true})}
 const m=sub.match(/^entries\/(\d+)$/);if(m&&req.method==='DELETE'){const id=Number(m[1]);await db.batch([db.prepare('DELETE FROM acc_payments WHERE entry_id=?').bind(id),db.prepare('DELETE FROM acc_entries WHERE id=?').bind(id)]);return J({ok:true})}

 // banks
 if(sub==='banks'&&req.method==='GET')return J((await db.prepare('SELECT * FROM acc_banks ORDER BY id').all()).results);
 if(sub==='banks'&&req.method==='POST'){const b=await req.json();if(!cap(b.name,100))return J({error:'name'},400);const r=await db.prepare('INSERT INTO acc_banks(name,account_no,opening,created) VALUES(?,?,?,?)').bind(cap(b.name,100),cap(b.account_no,60),Number(b.opening)||0,now()).run();return J({id:r.meta.last_row_id})}
 let mm=sub.match(/^banks\/(\d+)$/);if(mm&&req.method==='DELETE'){const id=Number(mm[1]);const n=(await db.prepare('SELECT (SELECT COUNT(*) FROM acc_banktx WHERE bank_id=?1 OR to_bank_id=?1)+(SELECT COUNT(*) FROM acc_payments WHERE bank_id=?1)+(SELECT COUNT(*) FROM acc_custx WHERE bank_id=?1) n').bind(id).first()).n;if(n>0)return J({error:'used'},409);await db.prepare('DELETE FROM acc_banks WHERE id=?').bind(id).run();return J({ok:true})}
 if(sub==='banktx'&&req.method==='GET')return J((await db.prepare('SELECT * FROM acc_banktx ORDER BY date DESC,id DESC LIMIT 3000').all()).results);
 if(sub==='banktx'&&req.method==='POST'){const b=await req.json();const kind=String(b.kind);if(!['deposit','withdraw','transfer'].includes(kind))return J({error:'kind'},400);const amt=Number(b.amount);if(!(amt>0))return J({error:'amount'},400);const bid=Number(b.bank_id),to=kind==='transfer'?Number(b.to_bank_id):0;if(!bid||(kind==='transfer'&&(!to||to===bid)))return J({error:'bank'},400);
  const r=await db.prepare('INSERT INTO acc_banktx(date,kind,bank_id,to_bank_id,amount,description,created) VALUES(?,?,?,?,?,?,?)').bind(dOk(b.date),kind,bid,to,amt,cap(b.description,300),now()).run();return J({id:r.meta.last_row_id})}
 mm=sub.match(/^banktx\/(\d+)$/);if(mm&&req.method==='DELETE'){await db.prepare('DELETE FROM acc_banktx WHERE id=?').bind(Number(mm[1])).run();return J({ok:true})}
 // custody (petty cash per person)
 if(sub==='custody'&&req.method==='GET')return J((await db.prepare('SELECT * FROM acc_custody ORDER BY id').all()).results);
 if(sub==='custody'&&req.method==='POST'){const b=await req.json();if(!cap(b.person,100))return J({error:'name'},400);const r=await db.prepare('INSERT INTO acc_custody(person,notes,created) VALUES(?,?,?)').bind(cap(b.person,100),cap(b.notes,300),now()).run();return J({id:r.meta.last_row_id})}
 mm=sub.match(/^custody\/(\d+)$/);if(mm&&req.method==='DELETE'){const id=Number(mm[1]);const n=(await db.prepare('SELECT COUNT(*) n FROM acc_custx WHERE custody_id=?').bind(id).first()).n;if(n>0)return J({error:'used'},409);await db.prepare('DELETE FROM acc_custody WHERE id=?').bind(id).run();return J({ok:true})}
 if(sub==='custx'&&req.method==='GET')return J((await db.prepare('SELECT * FROM acc_custx ORDER BY date DESC,id DESC LIMIT 3000').all()).results);
 if(sub==='custx'&&req.method==='POST'){const b=await req.json();const kind=String(b.kind);if(!['advance','expense','return'].includes(kind))return J({error:'kind'},400);const amt=Number(b.amount);if(!(amt>0))return J({error:'amount'},400);const cid=Number(b.custody_id);if(!await db.prepare('SELECT id FROM acc_custody WHERE id=?').bind(cid).first())return J({error:'nf'},404);
  const bank=kind==='expense'?0:Number(b.bank_id)||0;const r=await db.prepare('INSERT INTO acc_custx(custody_id,date,kind,amount,description,bank_id,created) VALUES(?,?,?,?,?,?,?)').bind(cid,dOk(b.date),kind,amt,cap(b.description,300),bank,now()).run();return J({id:r.meta.last_row_id})}
 mm=sub.match(/^custx\/(\d+)$/);if(mm&&req.method==='DELETE'){await db.prepare('DELETE FROM acc_custx WHERE id=?').bind(Number(mm[1])).run();return J({ok:true})}
 return J({error:'nf'},404)}
