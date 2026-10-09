import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { newGame } from '../shared/game.js';

import {client,start} from './helpers.js';

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
