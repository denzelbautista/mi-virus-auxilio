import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { newGame } from '../shared/game.js';

function client(url){
  const ws=new WebSocket(url),messages=[],waiters=[];
  ws.on('message',raw=>{const m=JSON.parse(raw);messages.push(m);for(const w of [...waiters])if(w.match(m)){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(m);}});
  const next=(match,timeout=6000)=>new Promise((resolve,reject)=>{const w={match,resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(w),1);reject(new Error('Timed out waiting for server message'));},timeout)};waiters.push(w);});
  return {ws,messages,next,send(m){ws.send(JSON.stringify(m));},state(){return messages.findLast(m=>m.type==='state');},session(){return messages.findLast(m=>m.type==='session');}};
}
async function start(file,timeout=300_000,options={}){
  const child=spawn(process.execPath,['server/index.js'],{cwd:resolve('.'),env:{...process.env,PORT:'0',HOST:'127.0.0.1',STATE_FILE:file,DISCONNECT_TIMEOUT_MS:String(timeout),MAX_PLAYERS:'8',...options},stdio:['ignore','pipe','pipe']});
  let output='';const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start: '+output)),5000);child.stdout.on('data',raw=>{output+=raw;const m=output.match(/localhost:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});child.stderr.on('data',raw=>output+=raw);child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exited: '+code+' '+output));});});
  return {child,port,async stop(){if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await exited;}};
}

test('Real network: 4-player rooms, isolation, privacy, invalid moves, reconnection and restart',async t=>{
  const dir=mkdtempSync(`${tmpdir()}/virus-tests-`),file=`${dir}/rooms.json`,clients=[];
  let server=await start(file);t.after(async()=>{clients.forEach(c=>c.ws.terminate());await server.stop();});
  const connect=async()=>{const c=client(`ws://127.0.0.1:${server.port}`);clients.push(c);await once(c.ws,'open');return c;};
  const host=await connect();let waiting=host.next(m=>m.type==='state');host.send({type:'create',name:'Ana',roomName:'Sala A',maxPlayers:4});const a=await waiting;
  const guests=[];
  for(const name of ['Beto','Cris','Dani']){const c=await connect();waiting=c.next(m=>m.type==='state');c.send({type:'join',code:a.code,name});await waiting;guests.push(c);}
  assert.equal(host.state().members.length,4);assert.equal(new Set(host.state().members.map(p=>p.id)).size,4);
  const fifth=await connect();waiting=fifth.next(m=>m.type==='error');fifth.send({type:'join',code:a.code,name:'Extra'});assert.match((await waiting).message,/llena/);
  const other=await connect();waiting=other.next(m=>m.type==='state');other.send({type:'create',name:'Eva',roomName:'Sala B',maxPlayers:4});const b=await waiting;assert.notEqual(a.code,b.code);
  for(const name of ['Fede','Gio','Hugo']) { const otherGuest=await connect();waiting=otherGuest.next(m=>m.type==='state');otherGuest.send({type:'join',code:b.code,name});await waiting; }
  waiting=guests[0].next(m=>m.type==='error');guests[0].send({type:'start',version:guests[0].state().version});assert.match((await waiting).message,/anfitrión/);
  waiting=host.next(m=>m.type==='state'&&m.status==='playing');host.send({type:'start',version:host.state().version});await waiting;
  waiting=other.next(m=>m.type==='state'&&m.status==='playing');other.send({type:'start',version:other.state().version});await waiting;
  assert.equal(host.state().game.hand.length,3);assert.equal(host.state().game.deckCount,56);
  assert.ok(host.state().game.players.every(p=>!('hand'in p)));assert.ok(!('deck'in host.state().game));
  assert.equal(other.state().game.players.length,4);assert.equal(other.state().game.deckCount,56);
  const initialOther=JSON.stringify(other.state().game),before=host.state();
  waiting=guests[0].next(m=>m.type==='error');guests[0].send({type:'action',version:guests[0].state().version,action:{type:'discard',cardIds:guests[0].state().game.hand.map(c=>c.id)}});assert.match((await waiting).message,/turno/);assert.equal(host.state().version,before.version);
  waiting=host.next(m=>m.type==='error');host.send({type:'action',version:host.state().version-1,action:{type:'discard',cardIds:host.state().game.hand.map(c=>c.id)}});assert.match((await waiting).message,/actualizó/);
  const moved=host.next(m=>m.type==='state'&&m.game?.turnPlayerId!==before.meId);host.send({type:'action',version:host.state().version,action:{type:'discard',cardIds:[host.state().game.hand[0].id]}});await moved;
  assert.equal(JSON.stringify(other.state().game),initialOther,'Other room must not change');assert.equal(host.state().game.hand.length,3);assert.equal(host.state().game.discardCount,1);
  const oldSession=guests[0].session(),oldId=guests[0].state().meId,oldHand=guests[0].state().game.hand;
  const disconnected=host.next(m=>m.type==='state'&&!m.members.find(p=>p.id===oldId).connected);guests[0].ws.close();await disconnected;
  const restored=await connect();waiting=restored.next(m=>m.type==='state');restored.send({type:'resume',code:a.code,token:oldSession.token});const snapshot=await waiting;assert.equal(snapshot.meId,oldId);assert.deepEqual(snapshot.game.hand,oldHand);
  const intruder=await connect();waiting=intruder.next(m=>m.type==='sessionExpired');intruder.send({type:'resume',code:a.code,token:'not-the-token'});await waiting;
  const replacement=await connect();waiting=replacement.next(m=>m.type==='state');const replaced=once(restored.ws,'close');replacement.send({type:'resume',code:a.code,token:oldSession.token});await waiting;await replaced;
  const oldB=other.state().game,hostSession=host.session();
  await server.stop();server=await start(file);
  const afterRestart=await connect();waiting=afterRestart.next(m=>m.type==='state');afterRestart.send({type:'resume',code:a.code,token:hostSession.token});const restarted=await waiting;assert.equal(restarted.meId,hostSession?before.meId:null);assert.equal(restarted.game.round,before.game.round);assert.equal(restarted.game.hand.length,3);
  const saved=JSON.parse(readFileSync(file,'utf8'));assert.equal(saved.find(r=>r.code===b.code).game.deck.length,oldB.deckCount);assert.equal(saved.find(r=>r.code===a.code).members.length,4);
  const response=await fetch(`http://127.0.0.1:${server.port}/health`);assert.equal((await response.json()).ok,true);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/data/rooms.json`)).status,404);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/server/index.js`)).status,404);
});

test('Current turn waits during grace; after timeout the other player wins by abandonment',async t=>{
  const file=`${mkdtempSync(`${tmpdir()}/virus-offline-`)}/rooms.json`,server=await start(file,600),a=client(`ws://127.0.0.1:${server.port}`),b=client(`ws://127.0.0.1:${server.port}`);
  t.after(async()=>{a.ws.terminate();b.ws.terminate();await server.stop();});await Promise.all([once(a.ws,'open'),once(b.ws,'open')]);
  let waiting=a.next(m=>m.type==='state');a.send({type:'create',name:'Uno'});const r=await waiting;
  waiting=b.next(m=>m.type==='state');b.send({type:'join',name:'Dos',code:r.code});await waiting;
  waiting=a.next(m=>m.type==='state'&&m.status==='playing');a.send({type:'start',version:a.state().version});await waiting;
  const myId=a.state().meId,offline=b.next(m=>m.type==='state'&&m.members.some(m=>m.id===myId&&!m.connected)),win=b.next(m=>m.type==='state'&&m.status==='finished');
  a.ws.close();const paused=await offline;assert.equal(paused.game.turnPlayerId,myId);assert.equal(paused.game.lastEvent,null);assert.equal(paused.disconnectTimeoutMs,600);
  const next=await win;assert.equal(next.game.winnerId,next.meId);assert.equal(next.game.winnerReason,'abandonment');assert.equal(next.game.players.length,1);assert.equal(next.game.deckCount,65);assert.equal(next.hostId,next.meId);
  const expired=client(`ws://127.0.0.1:${server.port}`);t.after(()=>expired.ws.terminate());await once(expired.ws,'open');waiting=expired.next(m=>m.type==='eliminated');expired.send({type:'resume',code:r.code,token:a.session().token});assert.match((await waiting).message,/eliminado/);
});
test('Four-player timeout returns every card, migrates host, and advances exactly one seat',async t=>{
  const file=`${mkdtempSync(`${tmpdir()}/virus-elimination-`)}/rooms.json`,now=Date.now();
  const members=['a','b','c','d'].map(id=>({id,name:id,token:`private-${id}`,connected:id!=='a',bot:false,...(id==='a'?{offlineSince:now-600}:{})}));
  const g=newGame(members.map(({id,name})=>({id,name})),()=>.4);
  const take=(type,color)=>{const i=g.deck.findIndex(c=>c.type===type&&c.color===color);return g.deck.splice(i,1)[0];};
  g.players[0].body=[{card:take('organ','red'),attachments:[take('medicine','red'),take('medicine','red')]}];
  const before=g.deck.length;
  writeFileSync(file,JSON.stringify([{code:'TEST44',name:'Aislamiento',capacity:4,members,hostId:'a',status:'playing',game:g,version:0,history:[],practice:false,updatedAt:now}]));
  const server=await start(file,1600),clients=[];t.after(async()=>{clients.forEach(c=>c.ws.terminate());await server.stop();});
  for(const p of members.slice(1)){const c=client(`ws://127.0.0.1:${server.port}`);clients.push(c);await once(c.ws,'open');const state=c.next(m=>m.type==='state');c.send({type:'resume',code:'TEST44',token:p.token});await state;}
  const host=clients[0],changed=await host.next(m=>m.type==='state'&&m.game.players.length===3);
  assert.equal(changed.game.deckCount,before+6);assert.equal(changed.game.turnPlayerId,'b');assert.equal(changed.hostId,'b');assert.equal(changed.status,'playing');assert.equal(changed.game.lastEvent.returnedCount,6);assert.equal(changed.members.length,3);assert.equal(changed.game.players.some(p=>p.id==='a'),false);
  const saved=JSON.parse(readFileSync(file,'utf8'))[0];assert.equal(saved.members.find(p=>p.id==='a').eliminated,true);
  const cards=[...saved.game.deck,...saved.game.discard,...saved.game.players.flatMap(p=>[...p.hand,...p.body.flatMap(o=>[o.card,...o.attachments])])];assert.equal(cards.length,68);assert.equal(new Set(cards.map(c=>c.id)).size,68);
  const resuming=client(`ws://127.0.0.1:${server.port}`);clients.push(resuming);await once(resuming.ws,'open');const denied=resuming.next(m=>m.type==='eliminated');resuming.send({type:'resume',code:'TEST44',token:members[0].token});await denied;assert.equal(host.state().game.deckCount,before+6);
});
test('Reconnecting before the deadline cancels elimination and keeps the original hand',async t=>{
  const file=`${mkdtempSync(`${tmpdir()}/virus-reconnect-`)}/rooms.json`,server=await start(file,500),clients=[];
  t.after(async()=>{clients.forEach(c=>c.ws.terminate());await server.stop();});
  const connect=async()=>{const c=client(`ws://127.0.0.1:${server.port}`);clients.push(c);await once(c.ws,'open');return c;};
  const a=await connect();let wait=a.next(m=>m.type==='state');a.send({type:'create',name:'Ana'});await wait;
  const b=await connect();wait=b.next(m=>m.type==='state');b.send({type:'join',name:'Beto',code:a.state().code});await wait;
  wait=a.next(m=>m.type==='state'&&m.status==='playing');a.send({type:'start',version:a.state().version});await wait;
  const original=a.state(),token=a.session().token;wait=b.next(m=>m.type==='state'&&!m.members.find(p=>p.id===original.meId).connected);a.ws.close();await wait;
  const returned=await connect();wait=returned.next(m=>m.type==='state');returned.send({type:'resume',code:original.code,token});const restored=await wait;assert.deepEqual(restored.game.hand,original.game.hand);
  await new Promise(resolve=>setTimeout(resolve,650));assert.equal(returned.state().status,'playing');assert.equal(returned.state().game.players.length,2);assert.equal(returned.state().game.turnPlayerId,original.meId);
});
test('Restart restores legacy disconnected bots so a practice can continue',async t=>{
  const file=`${mkdtempSync(`${tmpdir()}/virus-bots-`)}/rooms.json`,now=Date.now();
  const members=['a','b','c','d'].map((id,i)=>({id,name:id,token:`private-${id}`,connected:false,bot:i>0,offlineSince:now}));
  const game=newGame(members.map(({id,name,bot})=>({id,name,bot})),()=>.4);game.turn=1;
  writeFileSync(file,JSON.stringify([{code:'BOT444',name:'Práctica',capacity:4,members,hostId:'a',status:'playing',game,version:0,history:[],practice:true,updatedAt:now}]));
  const server=await start(file),c=client(`ws://127.0.0.1:${server.port}`);t.after(async()=>{c.ws.terminate();await server.stop();});await once(c.ws,'open');
  let wait=c.next(m=>m.type==='state');c.send({type:'resume',code:'BOT444',token:'private-a'});const restored=await wait;assert.ok(restored.members.filter(m=>m.bot).every(m=>m.connected));
  const move=await c.next(m=>m.type==='state'&&m.game.lastEvent?.actorId==='b');assert.equal(move.game.turnPlayerId,'c');
});

test('Eight live clients: selectable capacity, full-room rejection, turn order, isolation and restart',async t=>{
  const file=`${mkdtempSync(`${tmpdir()}/virus-eight-`)}/rooms.json`,clients=[];
  let server=await start(file);t.after(async()=>{clients.forEach(c=>c.ws.terminate());await server.stop();});
  const connect=async()=>{const c=client(`ws://127.0.0.1:${server.port}`);clients.push(c);await once(c.ws,'open');return c;};
  const host=await connect();
  for(const maxPlayers of [9,1,3.5,'8']){const denied=host.next(m=>m.type==='error');host.send({type:'create',name:'Ana',maxPlayers});assert.match((await denied).message,/plazas/);}
  let waiting=host.next(m=>m.type==='state');host.send({type:'create',name:'Ana',maxPlayers:8});const room=await waiting;assert.equal(room.maxPlayers,8);
  const seats=[host];
  for(let i=1;i<8;i++){const c=await connect();waiting=c.next(m=>m.type==='state');c.send({type:'join',name:`Jugador ${i+1}`,code:room.code});await waiting;seats.push(c);}
  assert.equal(host.state().members.length,8);
  const ninth=await connect();waiting=ninth.next(m=>m.type==='error');ninth.send({type:'join',name:'Nueve',code:room.code});assert.match((await waiting).message,/llena/);
  const other=await connect();waiting=other.next(m=>m.type==='state');other.send({type:'create',name:'Eva',maxPlayers:2});const separate=await waiting;assert.equal(separate.maxPlayers,2);
  const otherGuest=await connect();waiting=otherGuest.next(m=>m.type==='state');otherGuest.send({type:'join',name:'Fede',code:separate.code});await waiting;
  waiting=other.next(m=>m.type==='state'&&m.status==='playing');other.send({type:'start',version:other.state().version});await waiting;const originalOther=JSON.stringify(other.state().game);
  waiting=host.next(m=>m.type==='state'&&m.members.length===8);host.send({type:'sync'});await waiting;
  const started=seats.map(c=>c.next(m=>m.type==='state'&&m.status==='playing'));host.send({type:'start',version:host.state().version});await Promise.all(started);
  assert.equal(host.state().game.deckSize,136);assert.equal(host.state().game.deckCount,112);assert.equal(host.state().game.startingPlayerCount,8);
  const ids=seats.map(c=>c.state().meId),allHands=seats.flatMap(c=>c.state().game.hand);
  assert.equal(new Set(allHands.map(c=>c.id)).size,24);assert.ok(seats.every(c=>c.state().game.hand.length===3&&c.state().game.players.every(p=>!('hand'in p))));
  for(let i=0;i<8;i++){
    const c=seats[i];assert.equal(c.state().game.turnPlayerId,ids[i]);
    const moves=seats.map(s=>s.next(m=>m.type==='state'&&m.game?.lastEvent?.sequence===i+1));
    c.send({type:'action',version:c.state().version,action:{type:'discard',cardIds:[c.state().game.hand[0].id]}});await Promise.all(moves);
    assert.equal(host.state().game.turnPlayerId,ids[(i+1)%8]);
  }
  assert.equal(host.state().game.round,2);assert.equal(JSON.stringify(other.state().game),originalOther);
  const old=seats[7],session=old.session(),hand=old.state().game.hand;
  waiting=host.next(m=>m.type==='state'&&!m.members.find(m=>m.id===ids[7]).connected);old.ws.close();await waiting;
  const restored=await connect();waiting=restored.next(m=>m.type==='state');restored.send({...session,type:'resume'});const resumed=await waiting;assert.equal(resumed.meId,ids[7]);assert.deepEqual(resumed.game.hand,hand);seats[7]=restored;
  const tokens=seats.map(c=>c.session()),state=host.state().game;await server.stop();server=await start(file);
  for(const [i,token] of tokens.entries()){const c=await connect();waiting=c.next(m=>m.type==='state');c.send({...token,type:'resume'});const view=await waiting;assert.equal(view.game.deckSize,136);assert.equal(view.game.turnPlayerId,state.turnPlayerId);assert.equal(view.meId,ids[i]);assert.equal(view.members.length,8);assert.equal(view.game.hand.length,3);}
  const saved=JSON.parse(readFileSync(file,'utf8')),g=saved.find(r=>r.code===room.code).game;
  const cards=[...g.deck,...g.discard,...g.players.flatMap(p=>[...p.hand,...p.body.flatMap(o=>[o.card,...o.attachments])])];assert.equal(cards.length,136);assert.equal(new Set(cards.map(c=>c.id)).size,136);
  assert.equal(saved.find(r=>r.code===separate.code).game.deckSize,68);
});
test('Practice supports seven distinct bots and defaults to eight places for API-created rooms',async t=>{
  const file=`${mkdtempSync(`${tmpdir()}/virus-eight-bots-`)}/rooms.json`,server=await start(file),c=client(`ws://127.0.0.1:${server.port}`);
  t.after(async()=>{c.ws.terminate();await server.stop();});await once(c.ws,'open');
  let wait=c.next(m=>m.type==='state');c.send({type:'create',name:'Ana'});assert.equal((await wait).maxPlayers,8);
  wait=c.next(m=>m.type==='left');c.send({type:'leave'});await wait;
  wait=c.next(m=>m.type==='state'&&m.status==='playing');c.send({type:'practice',name:'Ana',maxPlayers:8});const state=await wait;
  assert.equal(state.members.length,8);assert.equal(state.members.filter(p=>p.bot).length,7);assert.equal(new Set(state.members.map(p=>p.name)).size,8);assert.ok(state.members.every(p=>p.connected));assert.equal(state.game.deckSize,136);
});

function flowFixture(count=3,finished=false){
  const members=Array.from({length:count},(_,i)=>({id:`p${i}`,token:`private-${i}`,name:`Persona ${i+1}`,bot:false,connected:true}));
  const game=newGame(members.map(({id,name,bot})=>({id,name,bot})),()=>.4);
  if(finished)game.winnerId=members[0].id;
  return {code:'FLOW44',name:'Flujos',capacity:count,hostId:members[0].id,members,game,status:finished?'finished':'playing',history:[],version:0,practice:false,updatedAt:Date.now()};
}
async function flowClients(t,room,options={}){
  const file=`${mkdtempSync(`${tmpdir()}/virus-flow-`)}/rooms.json`;
  writeFileSync(file,JSON.stringify([room]));
  let server=await start(file,300_000,options);const clients=[];
  t.after(async()=>{clients.forEach(c=>c.ws.terminate());await server.stop();});
  const connect=async member=>{
    const c=client(`ws://127.0.0.1:${server.port}`);clients.push(c);await once(c.ws,'open');
    const next=c.next(m=>m.type==='state');c.send({type:'resume',code:room.code,token:member.token});await next;return c;
  };
  for(const member of room.members.filter(m=>!m.bot))await connect(member);
  return {file,clients,connect,async restart(){await server.stop();server=await start(file,300_000,options);}};
}
const ownMember=c=>c.state().members.find(m=>m.id===c.state().meId);

test('Idle turn has a fixed deadline, enters autopilot, and takeover resets its counter',async t=>{
  const {clients:[a,b]}=await flowClients(t,flowFixture(2),{TURN_TIMEOUT_MS:'300',AUTO_DELAY_MS:'2000'});
  const deadline=a.state().turnDeadline;assert.ok(deadline-Date.now()<=300);
  let next=a.next(m=>m.type==='state');a.send({type:'sync'});assert.equal((await next).turnDeadline,deadline);
  next=b.next(m=>m.type==='state');b.send({type:'sync'});await next;
  assert.equal(b.state().turnDeadline,null);assert.ok(!('autopilot' in b.state().members.find(m=>m.id===a.state().meId)));
  const auto=await a.next(m=>m.type==='state'&&m.members.find(p=>p.id===m.meId).autopilot);
  assert.equal(auto.autoTurnLimit,15);assert.equal(ownMember(a).autoTurns,0);assert.equal(auto.game.lastEvent,null);
  assert.equal(ownMember(b).autopilot,false);
  next=a.next(m=>m.type==='state'&&!m.members.find(p=>p.id===m.meId).autopilot);
  a.send({type:'takeover',version:0});const returned=await next;
  assert.equal(ownMember(a).autoTurns,0);assert.ok(returned.turnDeadline>Date.now());assert.ok(returned.turnDeadline-Date.now()<=300);
});

test('A valid human action leaves autopilot; invalid out-of-turn actions do not',async t=>{
  const room=flowFixture(2);for(const m of room.members){m.autopilot=true;m.autoTurns=7;}
  const {clients:[a,b]}=await flowClients(t,room,{AUTO_DELAY_MS:'2000'});
  let next=b.next(m=>m.type==='error');b.send({type:'action',version:b.state().version,action:{type:'discard',cardIds:[b.state().game.hand[0].id]}});
  assert.match((await next).message,/turno/);assert.equal(ownMember(b).autoTurns,7);
  next=a.next(m=>m.type==='state'&&m.game.turnPlayerId!==m.meId);
  a.send({type:'action',version:a.state().version,action:{type:'discard',cardIds:[a.state().game.hand[0].id]}});await next;
  assert.equal(ownMember(a).autopilot,false);assert.equal(ownMember(a).autoTurns,0);
});

test('The fifteenth automatic turn eliminates the player, returns every card and keeps the next seat',async t=>{
  const room=flowFixture();room.members[0].autopilot=true;room.members[0].autoTurns=14;
  const g=room.game,p=g.players[0];g.deck.push(...p.hand);p.hand=[];
  const take=(type,color)=>g.deck.splice(g.deck.findIndex(c=>c.type===type&&c.color===color),1)[0];
  p.hand=['blue','green','yellow'].map(color=>take('medicine',color));
  p.body=[{card:take('organ','red'),attachments:[take('medicine','red'),take('medicine','red')]}];
  const {file,clients:[a,b,c]}=await flowClients(t,room,{AUTO_DELAY_MS:'300'});
  assert.equal(ownMember(a).autoTurns,14);
  const eliminated=a.next(m=>m.type==='eliminated');
  const changed=await b.next(m=>m.type==='state'&&m.game.lastEvent?.kind==='elimination');
  assert.match((await eliminated).message,/15 turnos/);assert.equal(changed.status,'playing');assert.equal(changed.hostId,'p1');
  assert.equal(changed.game.turnPlayerId,'p1');assert.equal(changed.game.players.length,2);
  assert.equal(changed.game.lastEvent.reason,'autopilot');assert.equal(changed.game.lastEvent.returnedCount,6);
  assert.match(changed.game.lastEvent.text,/15 turnos en piloto automático/);
  const saved=JSON.parse(readFileSync(file,'utf8'))[0],cards=[...saved.game.deck,...saved.game.discard,...saved.game.players.flatMap(p=>[...p.hand,...p.body.flatMap(o=>[o.card,...o.attachments])])];
  assert.equal(cards.length,68);assert.equal(new Set(cards.map(c=>c.id)).size,68);assert.equal(saved.members[0].autoTurns,15);
  let next=a.next(m=>m.type==='state');a.send({type:'create',name:'Otra sala',maxPlayers:2});assert.notEqual((await next).code,room.code);
});

test('Autopilot elimination at two players grants victory by abandonment',async t=>{
  const room=flowFixture(2);room.members[0].autopilot=true;room.members[0].autoTurns=14;
  const {clients:[a,b]}=await flowClients(t,room,{AUTO_DELAY_MS:'250'});
  const win=await b.next(m=>m.type==='state'&&m.status==='finished');
  assert.equal(win.game.winnerId,win.meId);assert.equal(win.game.winnerReason,'abandonment');assert.equal(win.game.players.length,1);
});

test('Fifteen complete cycles count own automatic turns, not opponents actions or broadcasts',async t=>{
  const room=flowFixture(2);room.members[0].autopilot=true;room.members[0].autoTurns=0;
  // No organs can be built in this fixture, so the counter is exercised to its full limit.
  for(const card of [...room.game.deck,...room.game.players.flatMap(p=>p.hand)]){card.type='virus';card.color='red';delete card.special;}
  const {file,clients:[a,b]}=await flowClients(t,room,{AUTO_DELAY_MS:'40'});
  for(let turn=1;turn<=15;turn++){
    const match=m=>m.type==='state'&&(turn===15?m.status==='finished':m.game.lastEvent?.sequence===turn*2-1&&m.game.turnPlayerId==='p1');
    const state=match(b.state())?b.state():await b.next(match);
    if(turn===15){assert.equal(state.game.winnerId,'p1');break;}
    assert.equal(state.status,'playing');assert.equal(ownMember(a).autoTurns,turn);
    assert.ok(!('autoTurns' in state.members.find(p=>p.id==='p0')));
    b.send({type:'action',version:state.version,action:{type:'discard',cardIds:[state.game.hand[0].id]}});
  }
  assert.equal(JSON.parse(readFileSync(file,'utf8'))[0].members[0].autoTurns,15);
});

test('A glove refill counts as an automatic turn and returns the replenished hand on elimination',async t=>{
  const room=flowFixture();room.members[0].autopilot=true;room.members[0].autoTurns=14;
  room.game.discard.push(...room.game.players[0].hand.splice(0));room.game.players[0].skip=true;
  const {clients:[a,b]}=await flowClients(t,room,{AUTO_DELAY_MS:'250'});
  const changed=await b.next(m=>m.type==='state'&&m.game.lastEvent?.kind==='elimination');
  assert.equal(changed.game.lastEvent.returnedCount,3);assert.equal(changed.game.turnPlayerId,'p1');
  assert.ok(changed.history.some(e=>e.actorId==='p0'&&/repuso/.test(e.text)));
});

test('Any player can request rematch; concurrent consent starts only after everyone answers',async t=>{
  const room=flowFixture(3,true);room.members[1].autopilot=true;room.members[1].autoTurns=8;
  const {clients:[a,b,c]}=await flowClients(t,room);
  const original=a.state().game;
  const pending=[a,b,c].map(c=>c.next(m=>m.type==='state'&&m.rematch?.status==='pending'));
  b.send({type:'rematch',version:b.state().version});await Promise.all(pending);
  assert.equal(a.state().status,'finished');assert.deepEqual(a.state().game,original);
  const vote=a.state().rematch;assert.equal(vote.requestedBy,'p1');assert.deepEqual(vote.acceptedIds,['p1']);
  assert.ok(vote.deadline-Date.now()>89_000&&vote.deadline-Date.now()<=90_000);
  let denied=c.next(m=>m.type==='error');c.send({type:'rematchReply',rematchId:'wrong',accept:true});assert.match((await denied).message,/no está disponible/);
  denied=c.next(m=>m.type==='error');c.send({type:'rematchReply',rematchId:vote.id,accept:'yes'});assert.match((await denied).message,/Confirma/);
  const playing=[a,b,c].map(c=>c.next(m=>m.type==='state'&&m.status==='playing'));
  // Both confirmations carry an old version, but belong to this exact proposal.
  a.send({type:'rematchReply',rematchId:vote.id,accept:true,version:0});
  c.send({type:'rematchReply',rematchId:vote.id,accept:true,version:0});await Promise.all(playing);
  assert.equal(a.state().game.players.length,3);assert.equal(a.state().game.round,1);assert.equal(a.state().game.lastEvent,null);
  assert.equal(a.state().rematch,null);assert.ok([a,b,c].every(c=>!ownMember(c).autopilot&&ownMember(c).autoTurns===0));
});

test('Default turn lasts 25 seconds and pilot state, counters and deadlines are private',async t=>{
  const room=flowFixture(2);room.members[1].autopilot=true;room.members[1].autoTurns=9;
  const {clients:[a,b]}=await flowClients(t,room);
  assert.ok(a.state().turnDeadline-Date.now()>24_000&&a.state().turnDeadline-Date.now()<=25_000);
  assert.equal(b.state().turnDeadline,null);assert.equal(ownMember(b).autopilot,true);assert.equal(ownMember(b).autoTurns,9);
  for(const viewer of [a,b])for(const member of viewer.state().members.filter(m=>m.id!==viewer.state().meId)){
    assert.ok(!('autopilot' in member));assert.ok(!('autoTurns' in member));
  }
  const synced=b.next(m=>m.type==='state');b.send({type:'sync'});await synced;
  assert.ok(!('autoTurns' in b.state().members.find(m=>m.id==='p0')));
});

test('Rematch deadline starts with consent only, migrates host and recalculates an eight-player deck',async t=>{
  const room=flowFixture(8,true);room.hostId='p7';
  const {clients}=await flowClients(t,room,{REMATCH_TIMEOUT_MS:'600'}),[a,b,...others]=clients;
  let next=a.next(m=>m.type==='state'&&m.rematch?.status==='pending');a.send({type:'rematch',version:a.state().version});await next;
  const vote=a.state().rematch;
  next=b.next(m=>m.type==='state'&&m.rematch?.acceptedIds.length===2);b.send({type:'rematchReply',rematchId:vote.id,accept:true});await next;
  assert.equal(b.state().status,'finished');assert.equal(b.state().game.deckSize,136);
  const excluded=others.map(c=>c.next(m=>m.type==='rematchExcluded'));
  const playing=await a.next(m=>m.type==='state'&&m.status==='playing');await Promise.all(excluded);
  assert.ok(Date.now()>=vote.deadline);assert.equal(playing.hostId,'p0');assert.equal(playing.members.length,2);
  assert.deepEqual(playing.game.players.map(p=>p.id),['p0','p1']);assert.equal(playing.game.deckSize,68);
  next=others[0].next(m=>m.type==='state');others[0].send({type:'create',name:'Libre'});assert.notEqual((await next).code,room.code);
});

test('Declining does not force a one-player rematch; unanswered invitations also expire',async t=>{
  const {clients:[a,b]}=await flowClients(t,flowFixture(2,true),{REMATCH_TIMEOUT_MS:'200'});
  let next=b.next(m=>m.type==='state'&&m.rematch?.status==='pending');a.send({type:'rematch',version:a.state().version});await next;
  const cancelled=[a,b].map(c=>c.next(m=>m.type==='state'&&m.rematch?.status==='cancelled'));b.send({type:'rematchReply',rematchId:b.state().rematch.id,accept:false});await Promise.all(cancelled);
  assert.equal(a.state().status,'finished');assert.equal(a.state().game.winnerId,'p0');
  next=a.next(m=>m.type==='state'&&m.rematch?.status==='pending');b.send({type:'rematch',version:b.state().version});await next;
  await a.next(m=>m.type==='state'&&m.rematch?.status==='cancelled');assert.equal(a.state().status,'finished');
});

test('Pending rematch survives reconnect and restart without extending its deadline',async t=>{
  const room=flowFixture(3,true),flow=await flowClients(t,room,{REMATCH_TIMEOUT_MS:'1200'}),[a,b]=flow.clients;
  let next=a.next(m=>m.type==='state'&&m.rematch?.status==='pending');a.send({type:'rematch',version:a.state().version});await next;
  const proposal=a.state().rematch;
  next=b.next(m=>m.type==='state'&&m.rematch?.acceptedIds.length===2);b.send({type:'rematchReply',rematchId:proposal.id,accept:true});await next;
  await flow.restart();const returnedA=await flow.connect(room.members[0]),returnedB=await flow.connect(room.members[1]);
  assert.equal(returnedA.state().rematch.id,proposal.id);assert.equal(returnedA.state().rematch.deadline,proposal.deadline);
  const playing=await returnedB.next(m=>m.type==='state'&&m.status==='playing');assert.equal(playing.members.length,2);
});

test('Practice bots accept the human rematch without waiting for imaginary confirmations',async t=>{
  const room=flowFixture(4,true);room.practice=true;for(const m of room.members.slice(1))m.bot=true;
  const {clients:[a]}=await flowClients(t,room);
  const next=a.next(m=>m.type==='state'&&m.status==='playing');a.send({type:'rematch',version:a.state().version});
  assert.equal((await next).game.players.length,4);
});
