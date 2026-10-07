'use strict';
/* nbm 探针:只提供 /api/stats,单文件,无依赖。 */
const MODE='agent';
const http=require('http'),https=require('https'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const PORT=+process.env.PORT||8060,TOKEN=process.env.TOKEN||'',DISK_PATH=process.env.DISK_PATH||'/';
const DATA=process.env.DATA_DIR||path.join(__dirname,'data'),PUB=path.join(__dirname,'public');
const PUSER=process.env.PANEL_USER||'admin',PPASS=process.env.PANEL_PASS||'';
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

sample();setInterval(sample,5000);setTimeout(sample,1500);
const json=(res,c,o)=>{const b=JSON.stringify(o);res.writeHead(c,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(b)};
const eq=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
function statsRoute(req,res){
 if(!TOKEN||TOKEN==='change-me')return json(res,403,{error:'服务端没有设置 TOKEN'});
 const t=req.headers['x-token']||(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!t||!eq(t,TOKEN))return json(res,401,{error:'TOKEN 不正确'});
 json(res,200,localStats())}
{
 http.createServer((req,res)=>{const p=new URL(req.url,'http://x').pathname;
  if(p==='/api/stats')return statsRoute(req,res);
  if(p==='/healthz'){res.writeHead(200);return res.end('ok')}
  json(res,404,{error:'这是 nbm 探针,只提供 /api/stats'})}).listen(PORT,()=>console.log(`nbm agent :${PORT}${TOKEN&&TOKEN!=='change-me'?'':'  (警告: 还没有设置 TOKEN)'}`));
  }

