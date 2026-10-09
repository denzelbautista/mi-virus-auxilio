import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {resolve,dirname} from 'node:path';
import WebSocket from 'ws';
const accessTokens = new Map();
export function client(url){
  const ws=new WebSocket(url),messages=[],waiters=[];
  ws.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);for(const w of [...waiters])if(w.match(m)){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(m);}});
  const next=(match,timeout=6000)=>new Promise((resolve,reject)=>{const w={match,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(w),1);reject(new Error('Timed out waiting for server message'));},timeout)};waiters.push(w);});
  return {ws,messages,next,send(m){ws.send(JSON.stringify({accessToken:accessTokens.get(url),...m}));},state(){return messages.findLast(m=>m.type==='state');},session(){return messages.findLast(m=>m.type==='session');}};
}
export async function start(file,timeout=300_000,extraEnv={}){
  const child=spawn(process.execPath,['server/index.js'],{cwd:resolve('.'),env:{...process.env,PORT:'0',HOST:'127.0.0.1',STATE_FILE:file,DB_FILE:resolve(dirname(file),'virus.sqlite'),DISCONNECT_TIMEOUT_MS:String(timeout),MAX_PLAYERS:'8',ADMIN_PASSWORD:'test-admin-password-123',...extraEnv},stdio:['ignore','pipe','pipe']});
  let output='';const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start: '+output)),5000);child.stdout.on('data',raw=>{output+=raw;const m=output.match(/localhost:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});child.stderr.on('data',raw=>output+=raw);child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exited: '+code+' '+output));});});
  const base=`http://127.0.0.1:${port}`;
  const login=await fetch(`${base}/api/admin/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-admin-password-123'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const issued=await fetch(`${base}/api/admin/codes`,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify({kind:'full',label:'Network tests',expiresAt:Date.now()+3600000})}).then(r=>r.json());
  const access=await fetch(`${base}/api/access`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:issued.codes[0].code})}).then(r=>r.json());
  accessTokens.set(`ws://127.0.0.1:${port}`,access.token);
  return {child,port,base,cookie,accessToken:access.token,async stop(){if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await exited;}};
}
