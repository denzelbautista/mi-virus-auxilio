import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {client,start} from './helpers.js';
import {Store} from '../server/store.js';
import {newGame} from '../shared/game.js';

const temp=()=>mkdtempSync(`${tmpdir()}/virus-access-`);
async function api(server,path,data,authorized=true,extra={}){
  const res=await fetch(`${server.base}/api/${path}`,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':'application/json'}),...(authorized?{cookie:server.cookie}:{}),...extra},body:data===undefined?undefined:JSON.stringify(data)});
  return {status:res.status,body:await res.json(),headers:res.headers};
}
async function fixture(t,env={}){
  const dir=temp();let server=await start(`${dir}/rooms.json`,300000,env);const clients=[];
  t.after(async()=>{clients.forEach(c=>c.ws.terminate());await server.stop();});
  return {dir,get server(){return server;},async restart(){await server.stop();server=await start(`${dir}/rooms.json`,300000,env);},async connect(){const c=client(`ws://127.0.0.1:${server.port}`);clients.push(c);await once(c.ws,'open');return c;}};
}
async function issue(s,kind='limited',maxRooms=1,expiresAt=Date.now()+3600000){const result=await api(s,'admin/codes',{kind,maxRooms,expiresAt,label:'Prueba'});assert.equal(result.status,201);return result.body.codes[0];}
async function redeem(s,code){const result=await api(s,'access',{code},false);assert.equal(result.status,200,result.body.error);return result.body.token;}
async function state(c,msg){const wait=c.next(m=>m.type==='state');c.send(msg);return await wait;}
async function denied(c,msg,pattern){const wait=c.next(m=>m.type==='error');c.send(msg);assert.match((await wait).message,pattern);}
async function leave(c){const wait=c.next(m=>m.type==='left');c.send({type:'leave'});await wait;}

test('Admin API: authenticated access, origin protection, validation, private files and safe responses',async t=>{
  const f=await fixture(t),s=f.server;
  assert.equal((await api(s,'admin/overview',undefined,false)).status,401);
  assert.equal((await api(s,'admin/codes',{kind:'full',expiresAt:Date.now()+100000},false)).status,401);
  assert.equal((await api(s,'admin/login',{password:'wrong'},false)).status,401);
  assert.equal((await api(s,'admin/codes',{},true,{origin:'https://evil.example'})).status,403);
  assert.equal((await api(s,'admin/codes',{kind:'limited',maxRooms:3,expiresAt:Date.now()+10000})).status,400);
  assert.equal((await api(s,'admin/codes',{kind:'full',expiresAt:Date.now()-1})).status,400);
  assert.equal((await api(s,'admin/rooms',{capacity:9,expiresAt:Date.now()+10000,maxGames:2})).status,400);
  for(const path of ['/data/virus.sqlite','/data/admin-password.txt','/server/store.js','/data/rooms.json'])assert.equal((await fetch(s.base+path)).status,404);
  const c=await f.connect();await denied(c,{type:'create',name:'Sin acceso',accessToken:null},/código de acceso/);
  const code=await issue(s,'full');const overview=(await api(s,'admin/overview')).body;
  assert.equal(JSON.stringify(overview).includes(code.code),false);assert.equal(JSON.stringify(overview).includes('secret_hash'),false);
  assert.equal((await api(s,'admin/logout',{})).status,200);assert.equal((await api(s,'admin/overview')).status,401);
});

test('Admin rooms: 2–8 seats, individual codes, fixed destination, single occupant and no guest bypass',async t=>{
  const f=await fixture(t),s=f.server;let pair;
  for(let capacity=2;capacity<=8;capacity++){
    const r=await api(s,'admin/rooms',{name:`Grupo ${capacity}`,capacity,maxGames:2,expiresAt:Date.now()+3600000});
    assert.equal(r.status,201);assert.equal(r.body.codes.length,capacity);assert.equal(new Set(r.body.codes.map(c=>c.code)).size,capacity);assert.equal(r.body.room.maxGames,2);
    if(capacity===2)pair=r.body;
  }
  const a=await f.connect(),b=await f.connect(),intruder=await f.connect(),token=await redeem(s,pair.codes[0].code),tokenAgain=await redeem(s,pair.codes[0].code);
  await denied(a,{type:'create',name:'Ana',accessToken:token},/asignada/);
  await denied(a,{type:'practice',name:'Ana',accessToken:token},/asignada/);
  await denied(a,{type:'join',code:(await api(s,'admin/overview')).body.rooms.find(r=>r.code!==pair.room.code).code,name:'Ana',accessToken:token},/individuales/);
  const joined=await state(a,{type:'join',code:pair.room.code,name:'Ana',accessToken:token});assert.equal(joined.hostId,joined.meId);
  await denied(b,{type:'join',code:pair.room.code,name:'Duplicado',accessToken:tokenAgain},/ya tiene un jugador/);
  const limited=await redeem(s,(await issue(s)).code);
  await denied(intruder,{type:'join',code:pair.room.code,name:'Intruso',accessToken:limited},/individuales/);
  const token2=await redeem(s,pair.codes[1].code);await state(b,{type:'join',code:pair.room.code,name:'Beto',accessToken:token2});
  await state(a,{type:'sync'});
  const started=await state(a,{type:'start',version:a.state().version});assert.equal(started.game.players.length,2);
  assert.equal('accessId' in started.members[0],false);assert.equal('token' in started.members[0],false);
  const o=(await api(s,'admin/overview')).body;assert.equal(o.rooms.filter(r=>r.status==='playing').length,1);assert.ok(!JSON.stringify(o).includes('hand'));
});

test('Temporal code quota is global, durable and never refunded by closing or restarting rooms',async t=>{
  const f=await fixture(t);const code=await issue(f.server,'limited',2),one=await redeem(f.server,code.code),two=await redeem(f.server,code.code);
  let a=await f.connect(),b=await f.connect();
  const r1=await state(a,{type:'create',name:'Ana',accessToken:one,maxPlayers:2});
  await state(b,{type:'join',name:'Beto',code:r1.code,accessToken:two});
  await leave(b);await leave(a);
  const r2=await state(b,{type:'create',name:'Beto',accessToken:two,maxPlayers:2});assert.notEqual(r1.code,r2.code);await leave(b);
  await denied(a,{type:'create',name:'Ana',accessToken:one},/límite/);
  assert.equal((await api(f.server,'admin/overview')).body.codes.find(c=>c.id===code.id).usedRooms,2);
  await f.restart();a=await f.connect();await denied(a,{type:'create',name:'Ana',accessToken:one},/límite/);
  const info=await api(f.server,'access',{token:one},false);assert.deepEqual(info.body.access.rooms,[r1.code,r2.code]);
});

test('A one-room code can rejoin that room; failed admissions consume no quota; full access creates many rooms',async t=>{
  const f=await fixture(t),a=await f.connect(),b=await f.connect(),c=await f.connect();
  const token=await redeem(f.server,(await issue(f.server,'limited',1)).code);
  await denied(b,{type:'join',code:'XXXXXX',name:'Beto',accessToken:token},/encontramos/);
  const r=await state(a,{type:'create',name:'Ana',maxPlayers:2});
  await state(c,{type:'join',name:'Cris',code:r.code});
  await denied(b,{type:'join',code:r.code,name:'Beto',accessToken:token},/llena/);
  assert.equal((await api(f.server,'access',{token},false)).body.access.rooms.length,0);
  await leave(c);await state(b,{type:'join',code:r.code,name:'Beto',accessToken:token});await leave(b);
  await state(b,{type:'join',code:r.code,name:'Beto',accessToken:token});await leave(b);
  await denied(b,{type:'create',name:'Beto',accessToken:token},/límite/);
  for(let i=0;i<5;i++){await state(c,{type:'create',name:'Cris',maxPlayers:2});await leave(c);}
});

test('Revocation and expiration block new admissions but let an existing match finish and reconnect',async t=>{
  const f=await fixture(t),s=f.server,code=await issue(s,'limited',1),token=await redeem(s,code.code),a=await f.connect(),b=await f.connect();
  const room=await state(a,{type:'create',name:'Ana',accessToken:token,maxPlayers:2});await state(b,{type:'join',name:'Beto',code:room.code});await state(a,{type:'sync'});await state(a,{type:'start',version:a.state().version});
  assert.equal((await api(s,'admin/codes/revoke',{id:code.id})).status,200);
  await state(a,{type:'action',version:a.state().version,action:{type:'discard',cardIds:[a.state().game.hand[0].id]}});
  const old=a.session();a.ws.close();const returned=await f.connect();const restored=await state(returned,{...old,type:'resume'});assert.equal(restored.meId,a.state().meId);
  assert.equal((await api(s,'access',{token},false)).status,400);
  const expiry=await issue(s,'limited',1);const expToken=await redeem(s,expiry.code),db=new Store(`${f.dir}/virus.sqlite`);db.db.prepare('UPDATE codes SET expires_at=? WHERE id=?').run(Date.now()-1,expiry.id);db.close();
  const c=await f.connect();await denied(c,{type:'create',name:'Vencido',accessToken:expToken},/vencido/);
  assert.equal((await api(s,'access',{code:expiry.code},false)).status,400);
});

function seeded(dir,{status='playing',maxGames=null,count=3,auto=false}={}){
  const db=new Store(`${dir}/virus.sqlite`),access=db.issue({kind:'full',label:'Fixture',expiresAt:Date.now()+3600000});db.close();
  const members=Array.from({length:count},(_,i)=>({id:`p${i}`,name:`Jugador ${i}`,token:`private-${i}`,connected:false,bot:false,accessId:access.id,...(auto?{autopilot:true,autoTurns:i===0?14:0}:{})}));
  const game=newGame(members,()=>.4);
  // A legal, card-conserving position one organ away from a win.
  game.deck.push(...game.players.flatMap(p=>p.hand.splice(0)));
  const take=(type,color)=>game.deck.splice(game.deck.findIndex(c=>c.type===type&&c.color===color),1)[0];
  game.players[0].body=['red','blue','green'].map(color=>({card:take('organ',color),attachments:[]}));
  game.players[0].hand=[take('organ','yellow'),...game.deck.splice(0,2)];
  for(const p of game.players.slice(1))p.hand=game.deck.splice(0,3);
  if(status==='finished'){game.players[0].body.push({card:game.players[0].hand.shift(),attachments:[]});game.winnerId='p0';game.sequence=1;}
  const room={id:'seed-id',code:'SEED22',name:'Sala de prueba',capacity:count,members,hostId:'p0',status,game,version:0,history:[],practice:false,updatedAt:Date.now(),createdAt:Date.now(),matchNumber:1,matchId:'seed-match',startedAt:Date.now()-5000,maxGames};
  writeFileSync(`${dir}/rooms.json`,JSON.stringify([room]));return room;
}
async function seededServer(t,opts,env={}){
  const dir=temp(),room=seeded(dir,opts),server=await start(`${dir}/rooms.json`,300000,env),clients=[];
  t.after(async()=>{clients.forEach(c=>c.ws.terminate());await server.stop();});
  for(const m of room.members){const c=client(`ws://127.0.0.1:${server.port}`);clients.push(c);await once(c.ws,'open');await state(c,{type:'resume',code:room.code,token:m.token});}
  for(const c of clients)await state(c,{type:'sync'});
  return {dir,server,room,clients};
}

test('Match monitoring records final duration and winner once, and history survives restart',async t=>{
  const f=await seededServer(t,{}),[a]=f.clients;
  const overview=(await api(f.server,'admin/overview')).body;assert.equal(overview.rooms[0].status,'playing');assert.ok(overview.rooms[0].durationMs>=5000);
  const action=a.state().game.actions.find(x=>x.cardId===a.state().game.hand.find(c=>c.type==='organ'&&c.color==='yellow').id);
  await state(a,{type:'action',version:a.state().version,action:{type:'play',key:action.key}});
  assert.equal(a.state().status,'finished');const history=(await api(f.server,'admin/history')).body.matches;assert.equal(history.length,1);assert.equal(history[0].winnerName,'Jugador 0');assert.equal(history[0].result,'victory');assert.ok(history[0].durationMs>=5000);assert.equal(history[0].players.length,3);
  await state(a,{type:'sync'});assert.equal((await api(f.server,'admin/history')).body.matches.length,1);
  await f.server.stop();const restarted=await start(`${f.dir}/rooms.json`);t.after(()=>restarted.stop());assert.equal((await api(restarted,'admin/history')).body.matches[0].durationMs,history[0].durationMs);
});

test('Any player can request rematch; votes are required, duplicate requests do not reset timer, excluded players detach',async t=>{
  const f=await seededServer(t,{status:'finished'}),[a,b,c]=f.clients;
  await state(b,{type:'rematch'});const proposal=b.state().rematch;assert.ok(proposal.deadline-Date.now()>89000);assert.equal(proposal.votes.p1,'yes');
  await denied(c,{type:'rematch'},/pendiente/);assert.equal(c.state().rematch.id,proposal.id);
  await state(a,{type:'rematchVote',rematchId:proposal.id,accept:true});assert.equal(a.state().status,'finished');
  const excluded=c.next(m=>m.type==='rematchExcluded');const started=a.next(m=>m.type==='state'&&m.status==='playing');c.send({type:'rematchVote',rematchId:proposal.id,accept:false});await excluded;await started;
  assert.equal(a.state().game.players.length,2);assert.equal(a.state().matchNumber,2);assert.equal(a.state().game.deckSize,68);
  await state(c,{type:'create',name:'Otra sala'});
});

test('Rematch deadline starts with available confirmations; included-game cap is enforced',async t=>{
  const f=await seededServer(t,{status:'finished',maxGames:2},{REMATCH_TIMEOUT_MS:'350'}),[a,b,c]=f.clients;
  await state(a,{type:'rematch'});const proposal=a.state().rematch;await state(b,{type:'rematchVote',rematchId:proposal.id,accept:true});
  const excluded=c.next(m=>m.type==='rematchExcluded');await a.next(m=>m.type==='state'&&m.status==='playing');await excluded;assert.equal(a.state().game.players.length,2);
  const dir=temp();seeded(dir,{status:'finished',maxGames:1});const server=await start(`${dir}/rooms.json`),x=client(`ws://127.0.0.1:${server.port}`);t.after(async()=>{x.ws.terminate();await server.stop();});await once(x.ws,'open');await state(x,{type:'resume',code:'SEED22',token:'private-0'});await denied(x,{type:'rematch'},/partidas incluidas/);
});

test('Pilot default is 25 seconds, private snapshots hide counters, takeover and 15-turn elimination work',async t=>{
  const f=await seededServer(t,{},{}),[a,b]=f.clients;
  assert.ok(a.state().turnDeadline-Date.now()>24000);assert.equal(b.state().turnDeadline,null);assert.equal('autopilot' in b.state().members.find(m=>m.id==='p0'),false);
  await denied(a,{type:'takeover'},/no está activo/);
  const e=await seededServer(t,{auto:true},{AUTO_DELAY_MS:'80'}),[x,y]=e.clients;
  // p0 reaches its fifteenth automatic turn and returns all hand/body cards.
  const eliminated=y.state().game.players.length===2?y.state():await y.next(m=>m.type==='state'&&m.game?.players.length===2);
  assert.ok(!eliminated.game.players.some(p=>p.id==='p0'));assert.equal(eliminated.game.lastEvent.returnedCount,6);
  assert.equal(eliminated.hostId,'p1');assert.ok(!JSON.stringify(eliminated.members).includes('private-'));
  const ownNotice=x.messages.find(m=>m.type==='eliminated')||await x.next(m=>m.type==='eliminated');assert.match(ownNotice.message,/15 turnos/);assert.ok(!eliminated.game.lastEvent.text.includes('piloto'));
  await state(x,{type:'create',name:'Nueva oportunidad'});
});

test('Simultaneous redemptions cannot spend the same final room slot twice',async t=>{
  const f=await fixture(t),code=await issue(f.server,'limited',1),tokens=await Promise.all([redeem(f.server,code.code),redeem(f.server,code.code)]),clients=await Promise.all([f.connect(),f.connect()]);
  const results=clients.map(c=>c.next(m=>m.type==='state'||m.type==='error'));
  clients.forEach((c,i)=>c.send({type:'create',name:`Jugador ${i}`,accessToken:tokens[i]}));
  const replies=await Promise.all(results);assert.equal(replies.filter(r=>r.type==='state').length,1);assert.match(replies.find(r=>r.type==='error').message,/límite/);
  const o=(await api(f.server,'admin/overview')).body;assert.equal(o.rooms.length,1);assert.equal(o.codes.find(c=>c.id===code.id).usedRooms,1);
});

test('An expired participant cannot start a rematch; unanswered rematches cancel without two confirmations',async t=>{
  const f=await seededServer(t,{status:'finished'},{REMATCH_TIMEOUT_MS:'250'}),[a,b]=f.clients;
  const db=new Store(`${f.dir}/virus.sqlite`);db.db.prepare('UPDATE codes SET expires_at=? WHERE id=?').run(Date.now()-1,f.room.members[0].accessId);db.close();
  await denied(a,{type:'rematch'},/vencido/);
  const other=await seededServer(t,{status:'finished'},{REMATCH_TIMEOUT_MS:'250'}),[x]=other.clients;
  await state(x,{type:'rematch'});const canceled=await x.next(m=>m.type==='state'&&m.rematch?.status==='cancelled');assert.equal(canceled.status,'finished');assert.match(canceled.rematch.message,/dos jugadores/);
});

test('Full codes allow repeated rematches; match history has one record per game',async t=>{
  const f=await seededServer(t,{status:'finished',count:2}),[a,b]=f.clients;
  // Seed two completed games across restarts to verify the unlimited entitlement,
  // with each proposal still requiring both players to opt in.
  await state(a,{type:'rematch'});let p=a.state().rematch;
  const playing=a.next(m=>m.type==='state'&&m.status==='playing');await state(b,{type:'rematchVote',rematchId:p.id,accept:true});await playing;
  assert.equal(a.state().matchNumber,2);assert.equal(a.state().maxGames,null);
  await f.server.stop();
  const saved=JSON.parse(readFileSync(`${f.dir}/rooms.json`,'utf8')),r=saved[0];r.status='finished';r.game.winnerId='p0';writeFileSync(`${f.dir}/rooms.json`,JSON.stringify(saved));
  const restarted=await start(`${f.dir}/rooms.json`),clients=[];t.after(async()=>{clients.forEach(c=>c.ws.terminate());await restarted.stop();});
  for(const m of r.members){const c=client(`ws://127.0.0.1:${restarted.port}`);clients.push(c);await once(c.ws,'open');await state(c,{type:'resume',code:r.code,token:m.token});}
  const [x,y]=clients;await state(y,{type:'rematch'});p=y.state().rematch;const again=y.next(m=>m.type==='state'&&m.status==='playing');await state(x,{type:'rematchVote',rematchId:p.id,accept:true});await again;assert.equal(y.state().matchNumber,3);
  const history=(await api(restarted,'admin/history')).body.matches;assert.equal(history.length,2);assert.deepEqual(history.map(m=>m.number).sort(),[1,2]);
});

test('SQLite migration preserves real dates and does not invent legacy match durations',()=>{
  const dir=temp(),db=new Store(`${dir}/virus.sqlite`),g=newGame([{id:'a',name:'Ana'},{id:'b',name:'Beto'}],()=>.4),old={id:'old-room',code:'OLD222',name:'Antigua',status:'finished',game:{...g,winnerId:'a'},updatedAt:1};
  const live={id:'live-room',code:'LIVE22',name:'En curso',status:'playing',game:g,updatedAt:1};
  db.recover(new Map([['OLD222',old],['LIVE22',live]]));assert.equal(db.history().length,0);assert.ok(live.startedAt>=Date.now()-1000);assert.equal(old.matchId,undefined);
  db.recover(new Map());const history=db.history();assert.equal(history.length,1);assert.equal(history[0].result,'interrupted');assert.ok(history[0].durationMs<1000);db.close();
});

test('Admin can reveal encrypted active codes after restart; public and expired access cannot reveal secrets',async t=>{
  const f=await fixture(t),s=f.server,code=await issue(s,'full');
  const unauthorized=await api(s,'admin/codes/reveal',{ids:[code.id]},false);assert.equal(unauthorized.status,401);assert.ok(!JSON.stringify(unauthorized.body).includes(code.code));
  assert.equal((await api(s,'admin/codes/reveal',{ids:[code.id]},true,{origin:'https://evil.example'})).status,403);
  assert.equal((await api(s,'admin/codes/reveal',{ids:[]})).status,400);
  const response=await api(s,'admin/codes/reveal',{ids:[code.id]});assert.equal(response.status,200);assert.equal(response.body.codes[0].code,code.code);assert.equal(response.headers.get('cache-control'),'no-store');
  const overview=(await api(s,'admin/overview')).body;assert.equal(overview.codes.find(c=>c.id===code.id).canReveal,1);assert.ok(!JSON.stringify(overview).includes(code.code));
  const db=new Store(`${f.dir}/virus.sqlite`),encrypted=db.db.prepare('SELECT encrypted FROM code_secrets WHERE code_id=?').get(code.id).encrypted;db.close();assert.ok(!encrypted.includes(code.code));
  await f.restart();assert.equal((await api(f.server,'admin/codes/reveal',{ids:[code.id]})).body.codes[0].code,code.code);
  await api(f.server,'admin/codes/revoke',{id:code.id});assert.equal((await api(f.server,'admin/codes/reveal',{ids:[code.id]})).status,400);
  const expired=await issue(f.server),local=new Store(`${f.dir}/virus.sqlite`);local.db.prepare('UPDATE codes SET expires_at=? WHERE id=?').run(Date.now()-1,expired.id);local.close();assert.equal((await api(f.server,'admin/codes/reveal',{ids:[expired.id]})).status,400);
  assert.equal((await fetch(f.server.base+'/data/access-code.key')).status,404);
});

test('Room code popup can retrieve all eight original individual codes without exposing them in overview',async t=>{
  const f=await fixture(t),created=(await api(f.server,'admin/rooms',{capacity:8,name:'Grupo grande',maxGames:2,expiresAt:Date.now()+3600000})).body;
  const result=await api(f.server,'admin/codes/reveal',{ids:created.codes.map(c=>c.id)});assert.equal(result.status,200);assert.deepEqual(result.body.codes.map(c=>c.code),created.codes.map(c=>c.code));assert.ok(result.body.codes.every(c=>c.roomCode===created.room.code));
  assert.equal((await api(f.server,'admin/codes/reveal',{ids:Array(9).fill(created.codes[0].id)})).status,400);
  assert.ok(!JSON.stringify((await api(f.server,'admin/overview')).body).includes(created.codes[0].code));
});

test('Legacy copies preserve original codes, active sessions and the same cumulative room quota',async t=>{
  const f=await fixture(t),code=await issue(f.server),originalToken=await redeem(f.server,code.code),a=await f.connect();
  const room=await state(a,{type:'create',name:'Ana',accessToken:originalToken});
  const db=new Store(`${f.dir}/virus.sqlite`);db.db.prepare('DELETE FROM code_secrets WHERE code_id=?').run(code.id);db.close();
  assert.equal((await api(f.server,'admin/codes/reveal',{ids:[code.id]})).body.codes[0].code,null);
  assert.equal((await api(f.server,'admin/codes/recover',{id:code.id},false)).status,401);
  const recovered=(await api(f.server,'admin/codes/recover',{id:code.id})).body.codes[0];assert.notEqual(recovered.code,code.code);assert.equal(recovered.id,code.id);assert.equal(recovered.expiresAt,code.expiresAt);
  assert.equal((await api(f.server,'admin/codes/recover',{id:code.id})).body.codes[0].code,recovered.code);
  const copyToken=await redeem(f.server,recovered.code),oldToken=await redeem(f.server,code.code);
  for(const token of [originalToken,copyToken,oldToken])assert.deepEqual((await api(f.server,'access',{token},false)).body.access.rooms,[room.code]);
  await leave(a);const b=await f.connect();for(const token of [oldToken,copyToken])await denied(b,{type:'create',name:'Beto',accessToken:token},/límite/);
  await f.restart();assert.equal((await api(f.server,'admin/codes/reveal',{ids:[code.id]})).body.codes[0].code,recovered.code);
  await api(f.server,'admin/codes/revoke',{id:code.id});for(const secret of [recovered.code,code.code])assert.equal((await api(f.server,'access',{code:secret},false)).status,400);
});

test('Legacy saved plaintext can be imported without changing the original entitlement',()=>{
  const dir=temp();let db=new Store(`${dir}/virus.sqlite`);const c=db.issue({kind:'full',label:'Anterior',expiresAt:Date.now()+3600000});db.db.prepare('DELETE FROM code_secrets WHERE code_id=?').run(c.id);db.close();
  writeFileSync(`${dir}/accesos-locales.txt`,c.code,{mode:0o600});db=new Store(`${dir}/virus.sqlite`);assert.equal(db.reveal([c.id])[0].code,c.code);assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM code_aliases').get().n,0);db.close();
});

test('Revoking an individual room blocks every seat and session durably without affecting other access',async t=>{
  const f=await fixture(t),s=f.server,expiresAt=Date.now()+3600000;
  const group=(await api(s,'admin/rooms',{capacity:8,name:'Revocar grupo',maxGames:2,expiresAt})).body;
  const other=(await api(s,'admin/rooms',{capacity:2,name:'Conservar',maxGames:2,expiresAt})).body;
  const full=await issue(s,'full'),limited=await issue(s),tokens=await Promise.all(group.codes.map(c=>redeem(s,c.code)));
  const request={id:group.codes[0].id};
  assert.equal((await api(s,'admin/codes/revoke-room',request,false)).status,401);
  assert.equal((await api(s,'admin/codes/revoke-room',request,true,{origin:'https://evil.example'})).status,403);
  for(const id of [null,[], 'missing',full.id,limited.id])assert.equal((await api(s,'admin/codes/revoke-room',{id})).status,400);
  const a=await f.connect(),b=await f.connect();
  await state(a,{type:'join',name:'Ana',code:group.room.code,accessToken:tokens[0]});
  await state(b,{type:'join',name:'Beto',code:group.room.code,accessToken:tokens[1]});
  await state(a,{type:'sync'});await state(a,{type:'start',version:a.state().version});
  await api(s,'admin/codes/revoke',{id:group.codes[7].id});
  const db=new Store(`${f.dir}/virus.sqlite`);db.db.prepare('UPDATE codes SET expires_at=? WHERE id=?').run(Date.now()-1,group.codes[6].id);db.close();
  const result=await api(s,'admin/codes/revoke-room',request);assert.equal(result.status,200);assert.equal(result.body.revoked,7);
  const rows=(await api(s,'admin/overview')).body.codes;assert.ok(rows.filter(c=>c.roomCode===group.room.code).every(c=>c.revokedAt));
  assert.ok(rows.filter(c=>c.roomCode===other.room.code||[full.id,limited.id].includes(c.id)).every(c=>!c.revokedAt));
  for(let i=0;i<group.codes.length;i++){
    assert.equal((await api(s,'access',{code:group.codes[i].code},false)).status,400);
    assert.equal((await api(s,'access',{token:tokens[i]},false)).status,400);
  }
  await state(a,{type:'action',version:a.state().version,action:{type:'discard',cardIds:[a.state().game.hand[0].id]}});
  const session=a.session();a.ws.close();const returned=await f.connect();assert.equal((await state(returned,{...session,type:'resume'})).meId,a.state().meId);
  assert.equal((await api(s,'admin/codes/revoke-room',request)).status,400);
  await f.restart();for(const c of group.codes)assert.equal((await api(f.server,'access',{code:c.code},false)).status,400);
  assert.equal((await api(f.server,'access',{code:other.codes[0].code},false)).status,200);
});

test('Active code cards receive current states of assigned and shared rooms without exposing player secrets',async t=>{
  const f=await fixture(t),s=f.server;
  const group=(await api(s,'admin/rooms',{capacity:2,name:'Sala individual',maxGames:2,expiresAt:Date.now()+3600000})).body;
  const unused=await issue(s,'full'),shared=await issue(s,'limited',2),token=await redeem(s,shared.code),a=await f.connect(),b=await f.connect(),c=await f.connect();
  const first=await state(a,{type:'create',name:'Ana',accessToken:token,maxPlayers:2});
  await state(b,{type:'join',name:'Beto',code:first.code});await state(a,{type:'sync'});await state(a,{type:'start',version:a.state().version});
  const second=await state(c,{type:'create',name:'Cris',accessToken:token,maxPlayers:2});
  const overview=(await api(s,'admin/overview')).body;
  assert.deepEqual(overview.codes.find(c=>c.id===group.codes[0].id).rooms,[{code:group.room.code,name:'Sala individual',status:'lobby'}]);
  assert.deepEqual(overview.codes.find(c=>c.id===unused.id).rooms,[]);
  const states=overview.codes.find(c=>c.id===shared.id).rooms;assert.equal(states.find(r=>r.code===first.code).status,'playing');assert.equal(states.find(r=>r.code===second.code).status,'lobby');
  assert.ok(!JSON.stringify(overview).includes(token));assert.ok(!JSON.stringify(overview).includes(shared.code));
  await leave(c);assert.equal((await api(s,'admin/overview')).body.codes.find(c=>c.id===shared.id).rooms.length,1);
});
