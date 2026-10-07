'use strict';
/* nbm — 导航 + 服务器监控。MODE=panel(默认,完整面板) / MODE=agent(探针,只提供 /api/stats) */
const http=require('http'),https=require('https'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const MODE=(process.env.MODE||'panel').toLowerCase()==='agent'?'agent':'panel';
const PORT=+process.env.PORT||8060,TOKEN=process.env.TOKEN||'',DISK_PATH=process.env.DISK_PATH||'/';
const DATA=process.env.DATA_DIR||path.join(__dirname,'data'),PUB=path.join(__dirname,'public');
const SPASS=process.env.SSH_PASS||process.env.PANEL_PASS||'';   // 面板本身不再登录;只有点 SSH 时才要这个密码(沿用旧的 PANEL_PASS 也行)
const rd=f=>{try{return fs.readFileSync(f,'utf8')}catch{return''}};
const num=(v,lo,hi,d)=>{v=+v;return Number.isFinite(v)?Math.min(hi,Math.max(lo,v)):d};
const pct=o=>o&&o.total?100*o.used/o.total:0;

/* ================= 本机采集 ================= */
let prevCpu=null,prevNet=null,prevT=0;const snap={cpu:0,net:{rx:0,tx:0,rxs:0,txs:0}};
function cpuTimes(){const l=rd('/proc/stat').split('\n')[0].split(/\s+/).slice(1).map(Number);return{idle:(l[3]||0)+(l[4]||0),total:l.reduce((a,b)=>a+(b||0),0)}}
function netBytes(){let rx=0,tx=0;rd('/proc/net/dev').split('\n').slice(2).forEach(x=>{const m=x.trim().match(/^([^:]+):\s*(.*)$/);if(!m)return;if(m[1]==='lo'||/^(docker|veth|br-|virbr|cni|flannel|cali)/.test(m[1]))return;const v=m[2].split(/\s+/).map(Number);rx+=v[0]||0;tx+=v[8]||0});return{rx,tx}}
function sample(){const t=Date.now(),c=cpuTimes(),n=netBytes();
 if(prevCpu){const dt=c.total-prevCpu.total,di=c.idle-prevCpu.idle;if(dt>0)snap.cpu=Math.max(0,Math.min(100,100*(1-di/dt)))}
 if(prevNet&&t>prevT){const s=(t-prevT)/1000;snap.net.rxs=Math.max(0,(n.rx-prevNet.rx)/s);snap.net.txs=Math.max(0,(n.tx-prevNet.tx)/s)}
 snap.net.rx=n.rx;snap.net.tx=n.tx;prevCpu=c;prevNet=n;prevT=t}
const meminfo=()=>{const o={};rd('/proc/meminfo').split('\n').forEach(l=>{const m=l.match(/^(\w+):\s+(\d+)/);if(m)o[m[1]]=+m[2]*1024});return o};
let osn='';const osName=()=>{if(osn)return osn;const f=fs.existsSync('/host/etc/os-release')?'/host/etc/os-release':'/etc/os-release';const m=rd(f).match(/^PRETTY_NAME="?([^"\n]+)"?/m);return osn=m?m[1]:os.type()+' '+os.release()};
/* 公网 IP:向外部服务查询并缓存(每 10 分钟刷新一次,失败 1 分钟后重试) */
let pubIp='',pubT=0;
const IPSRC=['https://4.ipw.cn','https://api.ipify.org','https://ipv4.icanhazip.com','https://ifconfig.me/ip'];
function getIp(u){return new Promise(ok=>{try{const r=(u.startsWith('https')?https:http).get(u,{timeout:4000,headers:{'user-agent':'curl/8'}},res=>{let b='';res.on('data',d=>{if(b.length<200)b+=d});res.on('end',()=>{b=b.trim();ok(/^[\d.]{7,15}$|^[0-9a-f:]{3,45}$/i.test(b)?b:'')})});r.on('timeout',()=>r.destroy());r.on('error',()=>ok(''))}catch{ok('')}})}
async function refreshIp(){pubT=Date.now();for(const u of IPSRC){const ip=await getIp(u);if(ip){pubIp=ip;return}}pubT=Date.now()-540000}
function pubTick(){if(Date.now()-pubT>=600000)refreshIp()}
pubTick();setInterval(pubTick,60000);
function localStats(){
 const mi=meminfo(),mt=mi.MemTotal||os.totalmem(),ma=mi.MemAvailable!=null?mi.MemAvailable:os.freemem(),st=mi.SwapTotal||0;
 let disk={used:0,total:0};try{const s=fs.statfsSync(DISK_PATH);disk={total:s.blocks*s.bsize,used:(s.blocks-s.bfree)*s.bsize}}catch{}
 const cp=os.cpus()||[];
 return{host:os.hostname(),os:osName(),kernel:os.release(),arch:os.arch(),cores:cp.length||1,cpuModel:((cp[0]||{}).model||'—').trim(),
  uptime:+rd('/proc/uptime').split(' ')[0]||os.uptime(),load:os.loadavg(),cpu:snap.cpu,mem:{used:mt-ma,total:mt},
  swap:{used:st-(mi.SwapFree||0),total:st},disk,net:{...snap.net},pub:pubIp,t:Date.now()}}

/* ================= HTTP 工具 ================= */
function rq(u,o={}){return new Promise((ok,no)=>{let url;try{url=new URL(u)}catch{return no(new Error('地址格式不对'))}
 if(!/^https?:$/.test(url.protocol))return no(new Error('地址要以 http:// 或 https:// 开头'));
 const lib=url.protocol==='https:'?https:http,t0=Date.now();
 const r=lib.request(url,{method:o.method||'GET',headers:o.headers||{},timeout:o.timeout||5000,rejectUnauthorized:!o.insecure,agent:false},res=>{
  if(o.headersOnly){res.destroy();return ok({status:res.statusCode,ms:Date.now()-t0})}
  const ch=[];let n=0;res.on('data',d=>{n+=d.length;if(n<=2e6)ch.push(d)});res.on('end',()=>ok({status:res.statusCode,body:Buffer.concat(ch).toString('utf8'),ms:Date.now()-t0}));res.on('error',no)});
 r.on('timeout',()=>r.destroy(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})));r.on('error',no);if(o.body)r.write(o.body);r.end()})}
const em=e=>{const c=e.code||'',m=e.message||'';return c==='ECONNREFUSED'?'连接被拒绝(对方没运行或端口没放行)':c==='ETIMEDOUT'?'连接超时':c==='ENOTFOUND'||c==='EAI_AGAIN'?'域名解析失败':c==='ECONNRESET'?'连接被重置':/certificate|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(c+m)?'证书不受信任(可勾选允许自签名证书)':m||c||'未知错误'};
async function fetchStats(url,token){
 let o;try{o=await rq(url.replace(/\/+$/,'')+'/api/stats',{headers:{'x-token':token||''},timeout:4000})}catch(e){throw new Error(em(e))}
 if(o.status===401)throw new Error('TOKEN 不正确 (401)');
 if(o.status===403)throw new Error('对方没有设置 TOKEN (403)');
 if(o.status===404)throw new Error('对方不是 nbm 或版本太旧 (404)');
 if(o.status!==200)throw new Error('HTTP '+o.status);
 let j;try{j=JSON.parse(o.body)}catch{throw new Error('返回的不是 nbm 数据')}
 if(typeof j.cpu!=='number'||!j.mem)throw new Error('返回的不是 nbm 数据');
 return{stats:j,ms:o.ms}}

/* ================= 探针模式 ================= */
sample();setInterval(sample,5000);setTimeout(sample,1500);
const json=(res,c,o)=>{const b=JSON.stringify(o);res.writeHead(c,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(b)};
const eq=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
function statsRoute(req,res){
 if(!TOKEN||TOKEN==='change-me')return json(res,403,{error:'服务端没有设置 TOKEN'});
 const t=req.headers['x-token']||(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!t||!eq(t,TOKEN))return json(res,401,{error:'TOKEN 不正确'});
 json(res,200,localStats())}
if(MODE==='agent'){
 http.createServer((req,res)=>{const p=new URL(req.url,'http://x').pathname;
  if(p==='/api/stats')return statsRoute(req,res);
  if(p==='/healthz'){res.writeHead(200);return res.end('ok')}
  json(res,404,{error:'这是 nbm 探针,只提供 /api/stats'})}).listen(PORT,()=>console.log(`nbm agent :${PORT}${TOKEN&&TOKEN!=='change-me'?'':'  (警告: 还没有设置 TOKEN)'}`));
  return;}   // 探针到此结束,不加载面板

/* ================= 面板:配置 ================= */
let WSS=null,SSH2=null;
try{const{WebSocketServer}=require('ws');WSS=new WebSocketServer({noServer:true,maxPayload:1<<20})}catch(e){console.log('[nbm] 未安装 ws,网页 SSH 不可用:',e.message)}
try{SSH2=require('ssh2')}catch(e){console.log('[nbm] 未安装 ssh2,网页 SSH 不可用:',e.message)}
fs.mkdirSync(path.join(DATA,'custom'),{recursive:true});
for(const f of['index.js','index.css'])if(!fs.existsSync(path.join(DATA,'custom',f)))fs.writeFileSync(path.join(DATA,'custom',f),'');
const CF=path.join(DATA,'config.json'),HF=path.join(DATA,'history.json'),AF=path.join(DATA,'alerts.json');
const save=(f,o)=>{try{fs.writeFileSync(f+'.tmp',JSON.stringify(o));fs.renameSync(f+'.tmp',f)}catch(e){console.error('写入失败',f,e.message)}};
const load=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const DEF={title:'NBM',accent:'#5b8cff',blur:16,opacity:.42,interval:12,bgList:[],mode:'dark',bgType:'photo',grad:'sky',geo:'',showWeather:true,weatherCity:'',favicon:'',
 servers:[{id:'local',name:'本机',url:'',token:''}],sites:[],
 bookmarks:[{folder:'示例',items:[{name:'GitHub',url:'https://github.com'},{name:'Docker Hub',url:'https://hub.docker.com'}]}],
 ntfy:{enabled:true,url:'https://ntfy.8010252.xyz/notice',token:'',failAfter:2,recover:true,cpu:90,mem:90,disk:90,sustain:3}};
let CFG=Object.assign({},DEF,load(CF,{}));CFG.ntfy=Object.assign({},DEF.ntfy,CFG.ntfy||{});
if(!Array.isArray(CFG.servers)||!CFG.servers.length)CFG.servers=DEF.servers;
const S=(v,n)=>String(v==null?'':v).slice(0,n).trim(),A=v=>Array.isArray(v)?v:[];
const sshState=()=>!SPASS?'nopass':(!WSS||!SSH2)?'nodeps':'';
const pubSsh=x=>x&&x.enabled?{enabled:true,host:x.host||'',port:x.port||22,user:x.user||'root',auth:x.auth||'password',hasSecret:!!(x.password||x.key),hasPass:!!x.passphrase}:{enabled:false};
const pubCfg=c=>({...c,sshReady:sshState(),servers:c.servers.map(s=>({id:s.id,name:s.name,url:s.url,link:s.link||'',ip:s.ip||'',ssh:pubSsh(s.ssh),hasToken:!!s.token})),ntfy:{...c.ntfy,token:'',hasToken:!!c.ntfy.token}});
function cleanSsh(x,o,name){
 if(!x||!x.enabled)return{enabled:false};
 o=o&&o.enabled?o:{};
 const host=S(x.host,200);if(host&&!/^[\w.\-:\[\]]+$/.test(host))throw new Error(`服务器「${name}」的 SSH 地址格式不对`);
 const auth=x.auth==='key'?'key':x.auth==='ask'?'ask':'password',user=S(x.user,64)||'root';
 if(!/^[\w.\-@]+$/.test(user))throw new Error(`服务器「${name}」的 SSH 用户名格式不对`);
 const r={enabled:true,host,port:Math.round(num(x.port,1,65535,22)),user,auth,password:'',key:'',passphrase:''};
 if(auth==='password'){r.password=x.password?String(x.password).slice(0,300):(o.auth==='password'?o.password||'':'');
  if(!r.password)throw new Error(`服务器「${name}」的 SSH 需要填密码,或选择"每次连接时输入密码"`)}
 if(auth==='key'){const k=x.key?String(x.key).replace(/\r\n/g,'\n').trim():'';r.key=k?k+'\n':(o.auth==='key'?o.key||'':'');
  if(!r.key)throw new Error(`服务器「${name}」的 SSH 需要填私钥`);if(r.key.length>20000)throw new Error('私钥太长');
  r.passphrase=x.passphrase?String(x.passphrase).slice(0,300):(o.auth==='key'?o.passphrase||'':'')}
 return r}
function cleanGeo(v){const t=S(v,40);if(!t)return'';const m=t.replace(/[,，;；\s]+/g,',').split(',').map(Number);if(m.length!==2||m.some(x=>!isFinite(x))||Math.abs(m[0])>90||Math.abs(m[1])>180)throw new Error('经纬度格式不对,应该像 32.97,117.19(纬度,经度)');return m[0]+','+m[1]}
function clean(inp,old){
 if(!inp||typeof inp!=='object')throw new Error('配置格式不对');
 const c={title:S(inp.title,20)||'NBM',accent:/^#[0-9a-f]{6}$/i.test(inp.accent)?inp.accent:DEF.accent,blur:num(inp.blur,0,40,16),opacity:num(inp.opacity,.1,.9,.42),interval:num(inp.interval,4,3600,12),
  bgList:A(inp.bgList).map(x=>S(x,600)).filter(Boolean).slice(0,50),
     mode:['light','dark','sun','system'].includes(inp.mode)?inp.mode:(old.mode||'dark'),bgType:inp.bgType==='grad'?'grad':'photo',
     grad:['sky','aurora','sunset','sakura','ocean','lavender','graphite'].includes(inp.grad)?inp.grad:(old.grad||'sky'),geo:cleanGeo(inp.geo),showWeather:inp.showWeather!==false,weatherCity:S(inp.weatherCity,40)};
 if(typeof inp.favicon==='string'&&(inp.favicon===''||(/^data:image\//.test(inp.favicon)&&inp.favicon.length<=400000)))c.favicon=inp.favicon;else c.favicon=old.favicon||'';
 const seen=new Set();
 c.servers=A(inp.servers).map(s=>{
  if(!s||!/^[\w-]{1,40}$/.test(s.id||''))throw new Error('服务器 id 不合法');if(seen.has(s.id))throw new Error('服务器 id 重复');seen.add(s.id);
  const url=S(s.url,300).replace(/\/+$/,'');if(url&&!/^https?:\/\//.test(url))throw new Error('服务器地址要以 http:// 开头');
  const name=S(s.name,40);if(!name)throw new Error('服务器名称不能为空');
  const o=old.servers.find(x=>x.id===s.id);const token=s.token?S(s.token,200):(o?o.token:'');
  if(url&&!token)throw new Error(`服务器「${name}」需要 TOKEN`);const l0=S(s.link,500),link=l0&&!/^https?:\/\//i.test(l0)?'http://'+l0:l0;
  const ip=S(s.ip,64);if(ip&&!/^[0-9a-f.:]{3,45}$/i.test(ip))throw new Error(`服务器「${name}」的公网 IP 格式不对`);
  return{id:s.id,name,url,link,ip,ssh:cleanSsh(s.ssh,o&&o.ssh,name),token:url?token:''}}).slice(0,50);
 c.sites=A(inp.sites).map(w=>{
  const url=S(w.url,500);if(!/^https?:\/\//.test(url))throw new Error('网站地址要以 http:// 或 https:// 开头');
  return{id:/^[\w-]{1,40}$/.test(w.id||'')?w.id:'w'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),name:S(w.name,60),url,tag:S(w.tag,30),icon:S(w.icon,600),check:!!w.check,insecure:!!w.insecure}}).slice(0,300);
 c.bookmarks=A(inp.bookmarks).map(f=>({folder:S(f.folder,40)||'未命名',items:A(f.items).map(i=>({name:S(i.name,60),url:S(i.url,600),pin:!!i.pin,dev:i.dev==='pc'||i.dev==='mobile'?i.dev:''})).filter(i=>i.url).slice(0,100)})).slice(0,30);
 const n=inp.ntfy||{},on=old.ntfy;
 c.ntfy={enabled:!!n.enabled,url:S(n.url,300),token:n.token?S(n.token,300):on.token||'',failAfter:Math.round(num(n.failAfter,1,20,2)),recover:!!n.recover,
  cpu:num(n.cpu,0,100,0),mem:num(n.mem,0,100,0),disk:num(n.disk,0,100,0),sustain:Math.round(num(n.sustain,1,120,3))};
 if(c.ntfy.url&&!/^https?:\/\/[^/]+\/[^/]+/.test(c.ntfy.url))throw new Error('ntfy 地址要带主题,例如 https://ntfy.sh/mytopic');
 return c}

/* ================= 运行状态 ================= */
/* 历史记录:兼容旧版/异常格式(如 {hist:[...],beats:[...]}),统一成「每个 key 一个按时间排序的数组」 */
function normHist(h){const out={};if(!h||typeof h!=='object'||Array.isArray(h))return out;
 for(const[k,v]of Object.entries(h)){const a=Array.isArray(v)?v:(v&&Array.isArray(v.hist)?v.hist:[]);
  out[k]=a.filter(p=>p&&typeof p==='object'&&Number.isFinite(p.t)).map(p=>p.ok!=null?p:{...p,ok:p.u?1:0}).sort((x,y)=>x.t-y.t)}
 return out}
const SV=new Map(),ST=new Map();let H=normHist(load(HF,{})),ALERTS=load(AF,[]),dirty=true;if(!Array.isArray(ALERTS))ALERTS=[];
const push=(a,v,n=60)=>{a.push(v);if(a.length>n)a.splice(0,a.length-n)};
function rec(k,p){if(!Array.isArray(H[k]))H[k]=[];H[k].push(p);const a=H[k],cut=Date.now()-864e5;while(a.length&&a[0].t<cut)a.shift();dirty=true}
function up24(k){const a=Array.isArray(H[k])?H[k]:[];return a.length?Math.round(10000*a.filter(p=>p.ok).length/a.length)/100:null}
function reconcile(){
 const ids=new Set(CFG.servers.map(s=>s.id)),wid=new Set(CFG.sites.filter(s=>s.check).map(s=>s.id));
 CFG.servers.forEach(s=>{if(!SV.has(s.id))SV.set(s.id,{up:null,err:'',ms:0,since:Date.now(),stats:null,h:{cpu:[],mem:[],rx:[],tx:[]},hb:[],lastRec:0,busy:false})});
 CFG.sites.forEach(s=>{if(!ST.has(s.id))ST.set(s.id,{up:null,err:'',ms:0,since:Date.now(),spark:[],last:0,busy:false})});
 for(const k of[...SV.keys()])if(!ids.has(k))SV.delete(k);
 for(const k of[...ST.keys()])if(!CFG.sites.some(s=>s.id===k))ST.delete(k);
 for(const k of Object.keys(H)){const id=k.slice(2);if(k[0]==='s'?!ids.has(id):!wid.has(id)){delete H[k];dirty=true}}
 for(const k of[...AV.keys()]){const id=k.slice(2);if(k[0]==='s'?!ids.has(id):!wid.has(id))AV.delete(k)}
 for(const k of[...RS.keys()])if(!ids.has(k.split(':')[0]))RS.delete(k)}
const setUp=(r,v)=>{if(r.up!==v){r.up=v;r.since=Date.now()}};

/* ================= ntfy 告警 ================= */
const AV=new Map(),RS=new Map();
const TTL={down:'🔴',up:'🟢',warn:'🟠',ok:'🟢'},LBL={down:'离线',up:'已恢复',warn:'资源告警',ok:'资源恢复'};
async function sendNtfy(url,token,title,msg,prio){
 const u=new URL(url),topic=u.pathname.replace(/^\/+|\/+$/g,'');
 const h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;
 const o=await rq(u.origin+'/',{method:'POST',headers:h,body:JSON.stringify({topic,title,message:msg,priority:prio||3}),timeout:8000});
 if(o.status<200||o.status>=300)throw new Error('ntfy 返回 HTTP '+o.status+(o.body?' '+o.body.slice(0,80):''))}
function notify(type,target,msg){
 const a={t:Date.now(),type,target,msg,sent:null};ALERTS.unshift(a);if(ALERTS.length>200)ALERTS.length=200;
 const n=CFG.ntfy;
 if(!n.enabled||!n.url){a.sent=false;a.err='ntfy 已关闭';return save(AF,ALERTS)}
 if((type==='up'||type==='ok')&&!n.recover){a.sent=false;a.err='未开启恢复通知';return save(AF,ALERTS)}
 sendNtfy(n.url,n.token,`${TTL[type]} ${target} ${LBL[type]}`,msg,type==='down'?4:3).then(()=>{a.sent=true},e=>{a.sent=false;a.err=em(e)}).finally(()=>save(AF,ALERTS))}
function avail(key,target,ok,need,detail){
 let a=AV.get(key);if(!a)AV.set(key,a={f:0,d:false});
 if(ok){a.f=0;if(a.d){a.d=false;notify('up',target,'已恢复在线')}}
 else{a.f++;if(!a.d&&a.f>=need){a.d=true;notify('down',target,'离线:'+detail)}}}
function resources(id,name,t){
 const n=CFG.ntfy,now=Date.now();
 for(const[k,lab,v]of[['cpu','CPU',t.cpu],['mem','内存',pct(t.mem)],['disk','磁盘',pct(t.disk)]]){
  const th=n[k]||0,key=id+':'+k;let r=RS.get(key);if(!r)RS.set(key,r={since:0,w:false});
  const over=th>0&&v>=th,clear=!th||v<th-5;
  if(over){if(!r.since)r.since=now;if(!r.w&&now-r.since>=n.sustain*60000){r.w=true;notify('warn',name,`${lab} 已达 ${v.toFixed(0)}%(告警线 ${th}%,持续 ${n.sustain} 分钟)`)}}
  else if(clear||!r.w){r.since=0;if(r.w){r.w=false;notify('ok',name,`${lab} 已恢复到 ${v.toFixed(0)}%`)}}}}

/* ================= 轮询 ================= */
async function pollServer(s,r){
 if(r.busy)return;r.busy=true;const now=Date.now();let t=null,ms=0,ok=false;
 /* 第一步:只判断"采集成功与否"。后面的记录/告警出错不能算成离线,否则会在同一次检测里多出一个红格 */
 try{if(!s.url)t=localStats();else{const o=await fetchStats(s.url,s.token);t=o.stats;ms=o.ms}ok=true}
 catch(e){r.err=e.message}
 try{
  if(ok){r.stats=t;r.ms=ms;r.err='';setUp(r,true);const m=pct(t.mem);
   push(r.h.cpu,t.cpu);push(r.h.mem,m);push(r.h.rx,t.net.rxs);push(r.h.tx,t.net.txs);push(r.hb,[1,ms]);
   if(now-r.lastRec>=30000){r.lastRec=now;rec('s:'+s.id,{t:now,ok:1,ms,cpu:+t.cpu.toFixed(1),mem:+m.toFixed(1),rx:Math.round(t.net.rxs),tx:Math.round(t.net.txs)})}
   resources(s.id,s.name,t)}
  else{setUp(r,false);push(r.hb,[0,0]);if(now-r.lastRec>=30000){r.lastRec=now;rec('s:'+s.id,{t:now,ok:0})}}}
 catch(e){console.error('[nbm] 记录/告警出错(不影响在线判断):',e&&e.stack||e)}
 avail('s:'+s.id,s.name,ok,Math.max(CFG.ntfy.failAfter,3),r.err);r.busy=false}
async function pollSite(s,r){
 r.busy=true;r.last=Date.now();let ok=false;
 try{const o=await rq(s.url,{timeout:8000,insecure:s.insecure,headersOnly:true,headers:{'user-agent':'nbm-monitor','accept':'*/*'}});
  ok=o.status<500;r.ms=o.ms;r.err=ok?'':'HTTP '+o.status;if(ok)push(r.spark,o.ms,30)}
 catch(e){r.err=em(e)}
 setUp(r,ok);rec('w:'+s.id,ok?{t:r.last,ok:1,ms:r.ms}:{t:r.last,ok:0});
 avail('w:'+s.id,s.name,ok,CFG.ntfy.failAfter,r.err);r.busy=false}
function tick(){const now=Date.now();
 for(const s of CFG.servers){const r=SV.get(s.id);if(r)pollServer(s,r)}
 for(const s of CFG.sites){if(!s.check)continue;const r=ST.get(s.id);if(r&&!r.busy&&now-r.last>=30000)pollSite(s,r)}}
reconcile();setInterval(tick,5000);setTimeout(tick,800);
setInterval(()=>{if(dirty){dirty=false;save(HF,H)}},60000);
const bye=()=>{save(HF,H);save(AF,ALERTS);process.exit(0)};process.on('SIGTERM',bye);process.on('SIGINT',bye);

/* ================= 接口 ================= */
function state(){
 return{servers:CFG.servers.map(s=>{const r=SV.get(s.id)||{};return{id:s.id,name:s.name,url:s.url,remote:!!s.url,up:r.up==null?null:r.up,err:r.err||'',ms:r.ms||0,since:r.since||Date.now(),stats:r.stats||null,h:r.h||{cpu:[],mem:[],rx:[],tx:[]},hb:r.hb||[],up24:up24('s:'+s.id)}}),
  sites:CFG.sites.map(s=>{const r=ST.get(s.id)||{};return{id:s.id,name:s.name,url:s.url,tag:s.tag,icon:s.icon,check:s.check,up:s.check&&r.up!=null?r.up:null,ms:r.ms||0,err:r.err||'',up24:s.check?up24('w:'+s.id):null,spark:s.check?r.spark||[]:[]}}),
  alerts:ALERTS.slice(0,50)}}
function hist(key,range){
 const cut=Date.now()-({'1h':36e5,'6h':216e5,'24h':864e5}[range]||36e5);
 const a=(Array.isArray(H[key])?H[key]:[]).filter(p=>p.t>=cut&&p.ok&&p.cpu!=null),step=Math.ceil(a.length/180)||1,out=[];
 for(let i=0;i<a.length;i+=step){const g=a.slice(i,i+step),av=k=>g.reduce((s,p)=>s+p[k],0)/g.length;out.push({t:g[g.length-1].t,cpu:av('cpu'),mem:av('mem'),rx:av('rx'),tx:av('tx')})}
 return out}
/* ================= 天气(open-meteo,免 key) ================= */
const WX={geo:process.env.WX_GEO||'https://geocoding-api.open-meteo.com/v1/search',api:process.env.WX_API||'https://api.open-meteo.com/v1/forecast',
 ip:process.env.WX_IP||'https://ipwho.is/',nom:process.env.WX_NOM||'https://nominatim.openstreetmap.org/search'};
const WC=new Map();
async function jget(u){const o=await rq(u,{timeout:7000,headers:{'user-agent':'nbm-panel (weather)','accept-language':'zh-CN'}});if(o.status!==200)throw new Error('HTTP '+o.status);return JSON.parse(o.body)}
/* "安徽省蚌埠市怀远县" -> ['怀远','蚌埠','安徽'](从最具体的开始) */
function cnParts(s){
 const out=[];
 String(s).split(/[\s,,、\/·]+/).filter(Boolean).forEach(p=>p.replace(/(特别行政区|自治区|自治州|地区|省|市|县|区|旗|盟)/g,'$1 ').split(' ').filter(Boolean).forEach(t=>{
  const m=t.match(/^(.{2,}?)(特别行政区|自治区|自治州|地区|省|市|县|区|旗|盟)$/);out.push(m?m[1]:t)}));
 return out.reverse()}
async function geoFind(city){
 const toks=cnParts(city);let loose=null;
 for(const name of toks){
  let rs=[];try{rs=((await jget(WX.geo+'?name='+encodeURIComponent(name)+'&count=10&language=zh&format=json')).results)||[]}catch{}
  if(!rs.length)continue;
  const others=toks.filter(x=>x!==name),sc=r=>{const t=[r.admin1,r.admin2,r.admin3,r.admin4,r.country].filter(Boolean).join('|');return others.filter(o=>t.includes(o)).length};
  rs.sort((x,y)=>sc(y)-sc(x));const r=rs[0];
  if(!loose)loose={name:r.name,lat:r.latitude,lon:r.longitude};
  if(!others.length||sc(r)>0)return{name:r.name,lat:r.latitude,lon:r.longitude}}
 /* 兜底:OpenStreetMap 能直接识别完整地址 */
 try{const g=await jget(WX.nom+'?q='+encodeURIComponent(city)+'&format=jsonv2&limit=1&accept-language=zh-CN'),r=g&&g[0];
  if(r)return{name:r.name||String(r.display_name||'').split(',')[0].trim()||city,lat:+r.lat,lon:+r.lon}}catch{}
 return loose}
const privIp=ip=>!ip||/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fe80|fc|fd)/i.test(ip);
async function weather(city,ip){
 const key=city||('auto:'+(privIp(ip)?'':ip)),c=WC.get(key);
 if(c&&Date.now()-c.t<(c.err?6e4:12e5)){if(c.err)throw new Error(c.err);return c.v}
 try{let loc;
  if(city){loc=await geoFind(city);if(!loc)throw new Error('找不到「'+city+'」,试试只写「怀远」或「蚌埠」')}
  else{const g=await jget(WX.ip+(privIp(ip)?'':ip)+'?lang=zh-CN');if(g.success===false||typeof g.latitude!=='number')throw new Error('自动定位失败,请在设置里填城市');loc={name:g.city||g.region||'',lat:g.latitude,lon:g.longitude}}
  const w=await jget(WX.api+`?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset&timezone=auto&forecast_days=7`);
  const cu=w.current||{},d=w.daily||{};
  const days=(d.time||[]).map((t,i)=>({date:t,code:(d.weather_code||[])[i],hi:(d.temperature_2m_max||[])[i],lo:(d.temperature_2m_min||[])[i],rain:(d.precipitation_probability_max||[])[i],wind:(d.wind_speed_10m_max||[])[i],rise:String((d.sunrise||[])[i]||'').slice(11,16),set:String((d.sunset||[])[i]||'').slice(11,16)}));
  const v={city:loc.name,days,lat:loc.lat,lon:loc.lon,temp:cu.temperature_2m,feels:cu.apparent_temperature,hum:cu.relative_humidity_2m,wind:cu.wind_speed_10m,code:cu.weather_code,day:cu.is_day!==0,hi:(d.temperature_2m_max||[])[0],lo:(d.temperature_2m_min||[])[0],rain:(d.precipitation_probability_max||[])[0],t:Date.now()};
  if(typeof v.temp!=='number')throw new Error('天气数据异常');
  WC.set(key,{t:Date.now(),v});return v}
 catch(e){const m=e.code?em(e):e.message;WC.set(key,{t:Date.now(),err:m});throw new Error(m)}}
/* ================= 书签:自动获取网站标题 ================= */
async function pageTitle(u){
 let url;try{url=new URL(/^https?:\/\//i.test(u)?u:'https://'+u)}catch{throw new Error('地址格式不对')}
 if(!/^https?:$/.test(url.protocol))throw new Error('地址格式不对');
 const o=await rq(url.href,{timeout:6000,insecure:true,headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36','accept':'text/html','accept-language':'zh-CN,zh;q=0.9'}});
 const m=o.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
 let t=m?m[1].replace(/\s+/g,' ').trim():'';
 t=t.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ');
 if(t.includes('\ufffd'))t='';
 const seg=t.split(/\s+[-–—|·]\s+|[_|｜]/).map(x=>x.trim()).filter(Boolean);
 if(seg.length>1&&seg[0].length>=2)t=seg[0];
 return{title:t.slice(0,40)}}
let bing={t:0,l:[]};
async function bingList(){
 if(bing.l.length&&Date.now()-bing.t<216e5)return bing.l;
 try{const o=await rq('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN',{timeout:6000});
  bing={t:Date.now(),l:JSON.parse(o.body).images.map(i=>'https://www.bing.com'+i.urlbase+'_1920x1080.jpg')}}
 catch{bing.t=Date.now()-216e5+3e5}
 return bing.l}
const body=req=>new Promise((ok,no)=>{const c=[];let n=0;req.on('data',d=>{n+=d.length;if(n>1.6e6){no(new Error('内容太大'));req.destroy()}else c.push(d)});req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(c).toString()||'{}'))}catch{no(new Error('JSON 格式不对'))}});req.on('error',no)});
const CUS=f=>path.join(DATA,'custom',f);

/* ================= 网页 SSH(ws + ssh2) ================= */
const{StringDecoder}=require('string_decoder');
const HK=path.join(DATA,'ssh_hosts.json');let HKS=load(HK,{}),SSHN=0;
/* SSH 解锁:面板本身不用登录,但点 SSH 时必须输入密码;通过后拿到临时令牌(8 小时有效,面板重启后失效) */
const SSHTK=new Map(),SSHFAIL=new Map(),TKTTL=8*36e5;
const cip=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim().replace(/^::ffff:/,'');
const tkOk=t=>{t=String(t||'');const e=SSHTK.get(t);if(!e)return false;if(e<Date.now()){SSHTK.delete(t);return false}return true};
function sshUnlock(req,pw){
 const ip=cip(req),f=SSHFAIL.get(ip)||{n:0,t:0};
 if(f.n>=5&&Date.now()-f.t<6e5)throw new Error('密码错误次数太多,请 10 分钟后再试');
 if(f.n>=5)f.n=0;
 if(!SPASS||!pw||!eq(pw,SPASS)){f.n++;f.t=Date.now();SSHFAIL.set(ip,f);throw new Error('密码不对')}
 SSHFAIL.delete(ip);const tk=crypto.randomBytes(24).toString('hex'),now=Date.now();
 for(const[k,v]of SSHTK)if(v<now)SSHTK.delete(k);SSHTK.set(tk,now+TKTTL);return tk}
const originOk=req=>{const o=req.headers.origin;if(!o)return false;try{const h=new URL(o).host;return h===req.headers.host||h===req.headers['x-forwarded-host']}catch{return false}};
const sshErr=e=>{const m=String(e&&e.message||e),c=e&&e.code||'';
 if(/All configured authentication methods failed|Authentication failure/i.test(m))return'认证失败:用户名、密码或私钥不对(或对方不允许密码登录/root 登录)';
 if(/Timed out while waiting for handshake|ETIMEDOUT/i.test(m+c))return'连接超时:地址、端口不对,或对方防火墙没放行 SSH 端口';
 if(/ECONNREFUSED/.test(m+c))return'连接被拒绝:对方没有运行 SSH 服务,或端口不对';
 if(/ENOTFOUND|EAI_AGAIN/.test(m+c))return'域名解析失败';
 if(/Cannot parse privateKey|Unsupported key format|passphrase/i.test(m))return'私钥无法读取(格式不对,或需要/填错了私钥口令)';
 return em(e)||m};
function sshSession(ws,id){
 const sv=CFG.servers.find(x=>x.id===id),sh=sv&&sv.ssh;
 const say=(t,m)=>{try{ws.send(JSON.stringify({t,m}))}catch{}};
 if(!sh||!sh.enabled){say('err','这台服务器没有启用 SSH');return ws.close()}
 if(SSHN>=8){say('err','同时打开的 SSH 会话太多了(上限 8 个)');return ws.close()}
 let conn=null,stream=null,started=false,alive=true;const dec=new StringDecoder('utf8');SSHN++;
 const done=()=>{if(!alive)return;alive=false;SSHN--;try{stream&&stream.close()}catch{}try{conn&&conn.end()}catch{}try{ws.close()}catch{}};
 ws.on('close',done);ws.on('error',done);
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}
  if(m.t==='open'&&!started){if(!tkOk(m.tk)){say('auth','需要先输入 SSH 密码');return done()}started=true;start(m)}
  else if(m.t==='d'&&stream)stream.write(String(m.d));
  else if(m.t==='r'&&stream)stream.setWindow(Math.round(num(m.r,2,500,24)),Math.round(num(m.c,2,500,80)),0,0)});
 function start(m){
  const host=sh.host||(sv.url?new URL(sv.url).hostname:'127.0.0.1'),port=sh.port||22,key=id+'|'+host+':'+port;
  const pw=sh.auth==='ask'?String(m.pw||'').slice(0,300):sh.password;
  const o={host,port,username:sh.user||'root',readyTimeout:12000,keepaliveInterval:15000,hostHash:'sha256',tryKeyboard:sh.auth!=='key',
   hostVerifier:h=>{const old=HKS[key];
    if(!old){HKS[key]=h;save(HK,HKS);say('info','首次连接,已记住这台机器的指纹 SHA256:'+h.slice(0,16)+'…');return true}
    if(old===h)return true;
    say('err','⚠ 主机指纹和上次不一样!可能是重装了系统,也可能被中间人攻击。已拒绝连接。确认无误后,在这台服务器的「编辑」里勾选「重新信任主机指纹」并保存,再连接。');return false}};
  if(sh.auth==='key'){o.privateKey=sh.key;if(sh.passphrase)o.passphrase=sh.passphrase}else o.password=pw;
  conn=new SSH2.Client();
  conn.on('keyboard-interactive',(n,i,l,prompts,finish)=>finish(prompts.map(()=>pw||'')));
  conn.on('ready',()=>{
   conn.shell({term:'xterm-256color',cols:Math.round(num(m.cols,2,500,80)),rows:Math.round(num(m.rows,2,500,24))},(err,st)=>{
    if(err){say('err','打开终端失败:'+err.message);return done()}
    stream=st;say('ready','');
    st.on('data',d=>{try{ws.send(JSON.stringify({t:'d',m:dec.write(d)}))}catch{}});
    st.stderr&&st.stderr.on('data',d=>{try{ws.send(JSON.stringify({t:'d',m:dec.write(d)}))}catch{}});
    st.on('close',()=>{say('exit','');done()})})});
  conn.on('error',e=>{say('err',sshErr(e));done()});
  conn.on('close',()=>{if(alive){say('exit','');done()}});
  try{conn.connect(o)}catch(e){say('err',sshErr(e));done()}}}

const SRV=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://x'),p=u.pathname,m=req.method==='HEAD'?'GET':req.method;
 try{
  if(p==='/api/stats')return statsRoute(req,res);
  if(p==='/healthz'){res.writeHead(200);return res.end('ok')}
  if(p==='/install.sh'&&m==='GET'){
   const host=String(req.headers.host||''),proto=req.headers['x-forwarded-proto']==='https'?'https':'http';
   if(!/^[\w.\-:\[\]]+$/.test(host)){res.writeHead(400);return res.end('bad host')}
   res.writeHead(200,{'Content-Type':'text/x-shellscript; charset=utf-8','Cache-Control':'no-cache'});
   return res.end(fs.readFileSync(path.join(__dirname,'install.sh'),'utf8').replace(/__PANEL__/g,proto+'://'+host))}
  if(p==='/agent.js'&&m==='GET'){res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-cache'});return res.end(fs.readFileSync(path.join(__dirname,'agent.js')))}
  if(m==='GET'&&/^\/vendor\/(xterm\.js|xterm\.css|addon-fit\.js)$/.test(p)){const f=path.basename(p);res.writeHead(200,{'Content-Type':f.endsWith('css')?'text/css; charset=utf-8':'application/javascript; charset=utf-8','Cache-Control':'public, max-age=86400'});return res.end(fs.readFileSync(path.join(PUB,'vendor',f)))}
  if(m==='GET'&&(p==='/'||p==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});return res.end(fs.readFileSync(path.join(PUB,'index.html')))}
  if(m==='GET'&&(p==='/custom/index.js'||p==='/custom/index.css')){res.writeHead(200,{'Content-Type':p.endsWith('js')?'application/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-cache'});return res.end(rd(CUS(path.basename(p))))}
  if(p==='/api/ssh/unlock'&&m==='POST'){const b=await body(req);return json(res,200,{token:sshUnlock(req,String(b.pw||''))})}
  if(p==='/api/state'&&m==='GET')return json(res,200,state());
  if(p==='/api/config'){
   if(m==='GET')return json(res,200,pubCfg(CFG));
   if(m==='PUT'){const inp=await body(req);CFG=clean(inp,CFG);
    for(const x of A(inp.servers))if(x&&x.ssh&&x.ssh.resetKey)for(const k of Object.keys(HKS))if(k.startsWith(x.id+'|'))delete HKS[k];
    save(HK,HKS);save(CF,CFG);reconcile();tick();return json(res,200,pubCfg(CFG))}}
  if(p==='/api/custom'){
   if(m==='GET')return json(res,200,{js:rd(CUS('index.js')),css:rd(CUS('index.css'))});
   if(m==='PUT'){const b=await body(req);const js=String(b.js||''),css=String(b.css||'');if(js.length>2e5||css.length>2e5)throw new Error('代码太长(上限 200KB)');
    fs.writeFileSync(CUS('index.js'),js);fs.writeFileSync(CUS('index.css'),css);return json(res,200,{ok:true})}}
  if(p==='/api/history'&&m==='GET')return json(res,200,hist(u.searchParams.get('key')||'',u.searchParams.get('range')||'1h'));
  if(p==='/api/servers/test'&&m==='POST'){
   const b=await body(req);let tok=b.token;if(!tok&&b.id){const o=CFG.servers.find(x=>x.id===b.id);tok=o&&o.token}
   try{const o=await fetchStats(S(b.url,300),tok);return json(res,200,{ok:true,host:o.stats.host,ms:o.ms})}catch(e){return json(res,200,{ok:false,error:e.message})}}
  if(p==='/api/ntfy/test'&&m==='POST'){
   const b=await body(req),url=S(b.url,300)||CFG.ntfy.url,tok=b.token||CFG.ntfy.token;
   if(!/^https?:\/\/[^/]+\/[^/]+/.test(url))return json(res,200,{ok:false,error:'地址要带主题,例如 https://ntfy.sh/mytopic'});
   try{await sendNtfy(url,tok,'✅ NBM 测试通知','如果你在手机上看到这条消息,说明 ntfy 配置正确。',3);return json(res,200,{ok:true})}catch(e){return json(res,200,{ok:false,error:em(e)})}}
  if(p==='/api/alerts'){if(m==='GET')return json(res,200,ALERTS);if(m==='DELETE'){ALERTS=[];save(AF,ALERTS);return json(res,200,{ok:true})}}
  if(p==='/api/agent-cmd'&&m==='GET'){
   const t=u.searchParams.get('token')||'',pt=+u.searchParams.get('port')||8060,o=(u.searchParams.get('origin')||'').replace(/\/+$/,'');
   if(!/^[\w-]{8,100}$/.test(t))throw new Error('TOKEN 需要 8~100 位字母数字');
   if(pt<1||pt>65535)throw new Error('端口不合法');
   if(!/^https?:\/\/[\w.\-:\[\]]+$/.test(o))throw new Error('面板地址不合法');
   const get=`[ -s /a.js ] || node -e "fetch('${o}/agent.js').then(r=>r.text()).then(t=>require('fs').writeFileSync('/a.js',t))"; exec node /a.js`;
   const cmd=`docker run -d --name nbm-agent --restart unless-stopped --network host --memory 64m -e TOKEN=${t} -e PORT=${pt} -e DISK_PATH=/host -e TZ=Asia/Shanghai -v /:/host:ro node:20-alpine sh -c "${get.replace(/"/g,'\\"')}"`;
   const compose=`services:
  nbm-agent:
    image: node:20-alpine
    container_name: nbm-agent
    restart: unless-stopped
    network_mode: host
    mem_limit: 64m
    environment:
      - TOKEN=${t}
      - PORT=${pt}
      - DISK_PATH=/host
      - TZ=Asia/Shanghai
    volumes:
      - /:/host:ro
    command:
      - sh
      - -c
      - |
        ${get}
`;
   return json(res,200,{cmd,compose})}
  if(p==='/api/weather'&&m==='GET')return json(res,200,await weather(CFG.weatherCity,String((req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0]).trim().replace(/^::ffff:/,'')));
  if(p==='/api/title'&&m==='GET'){try{return json(res,200,await pageTitle(u.searchParams.get('url')||''))}catch(e){return json(res,200,{title:'',error:em(e)})}}
  if(p==='/api/bing'&&m==='GET')return json(res,200,await bingList());
  json(res,404,{error:'not found'})
 }catch(e){json(res,400,{error:e.message})}
}).listen(PORT,()=>console.log(`nbm panel :${PORT}${TOKEN&&TOKEN!=='change-me'?'':'  (提示: 未设置 TOKEN,其他面板无法拉取本机数据)'}${SPASS?'  [SSH 需要密码]':'  (提示: 未设置 SSH_PASS,网页 SSH 已禁用)'}`));
SRV.on('upgrade',(req,sock,head)=>{
 const u=new URL(req.url,'http://x');
 if(u.pathname!=='/api/ssh'||!WSS||!SSH2||!originOk(req)){sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return sock.destroy()}
 WSS.handleUpgrade(req,sock,head,ws=>sshSession(ws,u.searchParams.get('id')||''))});
