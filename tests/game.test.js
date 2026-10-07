import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, newGame, act, legalActions, matches, status, publicGame, contagionPlan, refillTurn, draw, eliminatePlayers } from '../shared/game.js';

const card=(id,type,color,special)=>({id,type,color,...(special?{special}:{})});
const organ=(id,color,attachments=[])=>({card:card(id,'organ',color),attachments});
function fixture(){return {players:['a','b','c','d'].map(id=>({id,name:id,body:[],hand:[],skip:false})),deck:Array.from({length:30},(_,i)=>card(`draw${i}`,'organ','red')),discard:[],turn:0,round:1,winnerId:null,lastEvent:null,sequence:0};}
function play(g,c,targetPlayerId,targetOrganId,otherPlayerId,otherOrganId,moves){g.players[0].hand=[c];const a=legalActions(g,'a').find(a=>(targetPlayerId===undefined||a.targetPlayerId===targetPlayerId)&&(targetOrganId===undefined||a.targetOrganId===targetOrganId)&&(otherPlayerId===undefined||a.otherPlayerId===otherPlayerId)&&(otherOrganId===undefined||a.otherOrganId===otherOrganId));assert.ok(a,'Expected a legal action');act(g,'a',{type:'play',key:a.key,...(moves?{moves}:{})});}

test('The exact 68-card deck includes the official distribution',()=>{const d=createDeck();assert.equal(d.length,68);assert.equal(new Set(d.map(c=>c.id)).size,68);assert.deepEqual(['organ','virus','medicine','special'].map(t=>d.filter(c=>c.type===t).length),[21,17,20,10]);assert.deepEqual(['transplant','thief','contagion','glove','error'].map(t=>d.filter(c=>c.special===t).length),[1,3,2,3,1]);});
test('Deal 3 to each player; snapshots never expose rival hands or draw order',()=>{const g=newGame(['a','b','c','d'].map(id=>({id,name:id})));assert.equal(g.deck.length,56);assert.ok(g.players.every(p=>p.hand.length===3));const v=publicGame(g,'a');assert.equal(v.hand.length,3);assert.ok(v.players.every(p=>!('hand'in p)));assert.ok(!('deck'in v));assert.equal(v.actions.every(a=>v.hand.some(c=>c.id===a.cardId)),true);});
test('An organ belongs in the actor body, duplicate colors cannot be played',()=>{const g=fixture();play(g,card('x','organ','red'));assert.equal(g.players[0].body[0].card.id,'x');g.turn=0;g.players[0].hand=[card('y','organ','red')];assert.equal(legalActions(g,'a').length,0);assert.throws(()=>act(g,'a',{type:'play',key:'y:b:::'}));});
test('Viruses infect, then destroy an organ and discard all 3 cards',()=>{const g=fixture();g.players[1].body=[organ('heart','red')];play(g,card('v1','virus','red'),'b','heart');assert.equal(status(g.players[1].body[0]),'infected');g.turn=0;play(g,card('v2','virus','red'),'b','heart');assert.equal(g.players[1].body.length,0);assert.equal(g.discard.length,3);});
test('Medicines cure, vaccinate and immunize; immune organs cannot be targeted',()=>{const g=fixture();g.players[0].body=[organ('brain','blue',[card('v','virus','blue')])];play(g,card('m1','medicine','blue'),'a','brain');assert.equal(status(g.players[0].body[0]),'healthy');assert.equal(g.discard.length,2);g.turn=0;play(g,card('m2','medicine','blue'),'a','brain');assert.equal(status(g.players[0].body[0]),'vaccinated');g.turn=0;play(g,card('m3','medicine','wild'),'a','brain');assert.equal(status(g.players[0].body[0]),'immune');g.turn=0;g.players[0].hand=[card('v2','virus','wild'),card('t','special','purple','thief'),card('tr','special','purple','transplant')];assert.equal(legalActions(g,'a').length,0);});
test('Virus removes a vaccine and discards both, leaving a healthy organ',()=>{const g=fixture();g.players[1].body=[organ('bone','yellow',[card('med','medicine','yellow')])];play(g,card('v','virus','yellow'),'b','bone');assert.equal(status(g.players[1].body[0]),'healthy');assert.equal(g.discard.length,2);});
test('Curing matches the virus rather than the underlying organ',()=>{const g=fixture();g.players[0].body=[organ('w','wild',[card('v','virus','red')])];g.players[0].hand=[card('m','medicine','green')];assert.equal(legalActions(g,'a').length,0);play(g,card('m2','medicine','red'),'a','w');assert.equal(status(g.players[0].body[0]),'healthy');});
test('Wild vaccines and viruses can be removed by any color on a basic organ',()=>{for(const type of ['medicine','virus']){const g=fixture();g.players[1].body=[organ('r','red',[card('w',type,'wild')])];play(g,card('x',type==='medicine'?'virus':'medicine','green'),'b','r');assert.equal(status(g.players[1].body[0]),'healthy');}});
test('Wild attachment does not change the color when immunizing or destroying',()=>{for(const type of ['medicine','virus']){const g=fixture();g.players[1].body=[organ('r','red',[card('w',type,'wild')])];g.players[0].hand=[card('x',type,'green')];assert.equal(legalActions(g,'a').length,0);}});
test('Wild organ can be immunized with two different medicines',()=>{const g=fixture();g.players[0].body=[organ('w','wild')];play(g,card('r','medicine','red'),'a','w');g.turn=0;play(g,card('g','medicine','green'),'a','w');assert.equal(status(g.players[0].body[0]),'immune');});
test('A player can use medicines and viruses on any body, including their own',()=>{const g=fixture();g.players[0].body=[organ('r','red')];g.players[1].body=[organ('r2','red')];g.players[0].hand=[card('v','virus','red'),card('m','medicine','red')];assert.equal(legalActions(g,'a').length,4);});
test('The thief steals attachments too, and cannot duplicate a color',()=>{const g=fixture();g.players[1].body=[organ('r','red',[card('v','virus','red')])];play(g,card('t','special','purple','thief'),'b','r');assert.equal(g.players[0].body[0].attachments[0].id,'v');assert.equal(g.players[1].body.length,0);g.turn=0;g.players[1].body=[organ('r2','red')];g.players[0].hand=[card('t2','special','purple','thief')];assert.equal(legalActions(g,'a').length,0);});
test('Transplant can exchange organs between two rivals, with their attachments',()=>{const g=fixture();g.players[1].body=[organ('r','red',[card('m','medicine','red')])];g.players[2].body=[organ('b','blue',[card('v','virus','blue')])];play(g,card('t','special','purple','transplant'),'b','r','c','b');assert.equal(g.players[1].body[0].card.id,'b');assert.equal(g.players[2].body[0].attachments[0].id,'m');});
test('Transplant disallows duplicated colors and immune organs',()=>{const g=fixture();g.players[1].body=[organ('r','red'),organ('b1','blue')];g.players[2].body=[organ('b2','blue')];g.players[0].hand=[card('t','special','purple','transplant')];assert.equal(legalActions(g,'a').some(a=>a.targetOrganId==='r'&&a.otherOrganId==='b2'),false);g.players[2].body[0].attachments=[card('m1','medicine','blue'),card('m2','medicine','blue')];assert.equal(legalActions(g,'a').length,0);});
test('Medical error exchanges entire bodies, immune organs and empty bodies included',()=>{const g=fixture();g.players[1].body=[organ('r','red',[card('m1','medicine','red'),card('m2','medicine','red')])];play(g,card('e','special','purple','error'),'b');assert.equal(g.players[0].body[0].card.id,'r');assert.equal(g.players[1].body.length,0);assert.equal(status(g.players[0].body[0]),'immune');});
test('Contagion finds a maximum matching instead of a greedy partial infection',()=>{const g=fixture();g.players[0].body=[organ('w','wild',[card('vw','virus','wild')]),organ('r','red',[card('vr','virus','red')])];g.players[1].body=[organ('r2','red'),organ('g','green')];const plan=contagionPlan(g,g.players[0]);assert.equal(plan.length,2);assert.equal(plan.find(m=>m.sourceOrganId==='r').targetOrganId,'r2');play(g,card('c','special','purple','contagion'));assert.ok(g.players[0].body.every(o=>status(o)==='healthy'));assert.ok(g.players[1].body.every(o=>status(o)==='infected'));});
test('Contagion permits alternate maximum plans and rejects duplicate/incomplete ones atomically',()=>{const g=fixture();g.players[0].body=[organ('r','red',[card('v','virus','red')])];g.players[1].body=[organ('r1','red')];g.players[2].body=[organ('r2','red')];g.players[0].hand=[card('c','special','purple','contagion')];const a=legalActions(g,'a')[0],before=JSON.stringify(g);assert.throws(()=>act(g,'a',{type:'play',key:a.key,moves:[]}));assert.equal(JSON.stringify(g),before);act(g,'a',{type:'play',key:a.key,moves:[{sourceOrganId:'r',targetPlayerId:'c',targetOrganId:'r2'}]});assert.equal(status(g.players[2].body[0]),'infected');assert.equal(status(g.players[1].body[0]),'healthy');});
test('Contagion only affects free compatible rival organs',()=>{const g=fixture();g.players[0].body=[organ('r','red',[card('v','virus','red')])];g.players[1].body=[organ('r1','red',[card('m','medicine','red')]),organ('b','blue')];g.players[0].hand=[card('c','special','purple','contagion')];assert.equal(legalActions(g,'a').length,0);});
test('Latex glove empties rivals hands; every rival loses exactly one turn',()=>{const g=newGame(['a','b','c','d'].map(id=>({id,name:id})));g.discard.push(...g.players[0].hand);g.players[0].hand=[card('gl','special','purple','glove')];play(g,g.players[0].hand[0]);assert.equal(g.players[0].hand.length,3);for(let i=1;i<=3;i++){assert.equal(g.turn,i);assert.equal(g.players[i].hand.length,0);assert.equal(legalActions(g,g.players[i].id).length,0);refillTurn(g);assert.equal(g.players[i].hand.length,3);assert.equal(g.players[i].skip,false);}assert.equal(g.turn,0);assert.equal(g.round,2);});
test('Discard 1 to 3 cards, refill automatically, reject invalid or out-of-turn moves',()=>{const g=newGame(['a','b'].map(id=>({id,name:id}))),a=g.players[0],id=a.hand[0].id;const before=JSON.stringify(g);assert.throws(()=>act(g,'b',{type:'discard',cardIds:[id]}));assert.throws(()=>act(g,'a',{type:'discard',cardIds:[id,id]}));assert.throws(()=>act(g,'a',{type:'discard',cardIds:[]}));assert.equal(JSON.stringify(g),before);act(g,'a',{type:'discard',cardIds:[id]});assert.equal(a.hand.length,3);assert.equal(g.turn,1);assert.equal(g.discard[0].id,id);});
test('An exhausted draw pile turns over discards without reshuffling',()=>{const g=fixture();g.deck=[];g.discard=[card('first','organ','red'),card('second','organ','blue'),card('last','organ','yellow')];draw(g,g.players[0]);assert.deepEqual(g.players[0].hand.map(c=>c.id),['first','second','last']);assert.equal(g.discard.length,0);});
test('Win with four healthy organs, including wild, even if the fifth is infected',()=>{const g=fixture();g.players[0].body=['red','blue','green','yellow'].map((c,i)=>organ(`o${i}`,c,c==='yellow'?[card('v','virus','yellow')]:[]));play(g,card('w','organ','wild'));assert.equal(g.winnerId,'a');assert.equal(g.players[0].body.length,5);assert.throws(()=>act(g,'a',{type:'discard',cardIds:[]}));});
test('Treatments may give a rival a winning body',()=>{const g=fixture();g.players[1].body=['red','blue','green'].map((c,i)=>organ(`o${i}`,c));g.players[2].body=[organ('bone','yellow')];g.players[1].body.push(organ('wild','wild',[card('v','virus','wild')]));play(g,card('tr','special','purple','transplant'),'b','wild','c','bone');assert.equal(g.winnerId,'b');});
test('Generated legal playouts preserve every card and valid body state',()=>{
  for(let run=0;run<20;run++){
    let seed=run+1;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
    const g=newGame(['a','b','c','d'].map(id=>({id,name:id})),random);
    for(let i=0;i<700&&!g.winnerId;i++){
      const p=g.players[g.turn];if(p.skip){refillTurn(g);}else{const actions=legalActions(g,p.id);const organ=actions.find(a=>p.hand.find(c=>c.id===a.cardId).type==='organ');const a=organ||actions[Math.floor(random()*actions.length)];act(g,p.id,a?{type:'play',key:a.key}:{type:'discard',cardIds:p.hand.map(c=>c.id)});}
      const cards=[...g.deck,...g.discard,...g.players.flatMap(p=>[...p.hand,...p.body.flatMap(o=>[o.card,...o.attachments])])];
      assert.equal(cards.length,68);assert.equal(new Set(cards.map(c=>c.id)).size,68);
      for(const p of g.players){assert.equal(new Set(p.body.map(o=>o.card.color)).size,p.body.length);for(const o of p.body){assert.ok(o.attachments.length<=2);if(o.attachments.length===2)assert.ok(o.attachments.every(c=>c.type==='medicine'));}}
    }
    assert.ok(g.winnerId,'The game should reach a winner');
  }
});
test('Elimination returns the complete hand and body, including immune attachments, to the deck',()=>{
  const g=newGame(['a','b','c','d'].map(id=>({id,name:id}))),p=g.players[1];
  const take=(type,color)=>{const i=g.deck.findIndex(c=>c.type===type&&c.color===color);assert.ok(i>=0);return g.deck.splice(i,1)[0];};
  p.body=[{card:take('organ','red'),attachments:[take('medicine','red'),take('medicine','red')]}];
  const returned=[...p.hand,...p.body.flatMap(o=>[o.card,...o.attachments])],before=g.deck.length;
  eliminatePlayers(g,['b'],()=>.4);
  assert.equal(g.deck.length,before+6);assert.ok(returned.every(c=>g.deck.some(d=>d.id===c.id)));assert.equal(g.players.length,3);assert.equal(g.players[g.turn].id,'a');
  const all=[...g.deck,...g.discard,...g.players.flatMap(p=>[...p.hand,...p.body.flatMap(o=>[o.card,...o.attachments])])];
  assert.equal(all.length,68);assert.equal(new Set(all.map(c=>c.id)).size,68);assert.equal(g.lastEvent.returnedCount,6);
});
test('Eliminating current or earlier seats preserves the correct next player and round',()=>{
  for(const [turn,removed,next,round] of [[0,['a'],'b',1],[2,['a'],'c',1],[2,['c'],'d',1],[3,['d'],'a',2],[2,['c','d'],'a',2]]){
    const g=newGame(['a','b','c','d'].map(id=>({id,name:id})));g.turn=turn;
    eliminatePlayers(g,removed);assert.equal(g.players[g.turn].id,next);assert.equal(g.round,round);
  }
});
test('The last remaining player wins by abandonment without needing four organs',()=>{
  const g=newGame(['a','b'].map(id=>({id,name:id})));eliminatePlayers(g,['a']);
  assert.equal(g.winnerId,'b');assert.equal(g.winnerReason,'abandonment');assert.equal(g.players[0].body.length,0);assert.deepEqual(legalActions(g,'b'),[]);
  const before=JSON.stringify(g);assert.deepEqual(eliminatePlayers(g,['a']),[]);assert.equal(JSON.stringify(g),before);
});
test('Batch elimination of all players closes the game without inventing a winner',()=>{
  const g=newGame(['a','b'].map(id=>({id,name:id})));eliminatePlayers(g,['a','b']);
  assert.equal(g.players.length,0);assert.equal(g.deck.length,68);assert.equal(g.abandoned,true);assert.equal(g.winnerId,null);assert.equal(publicGame(g,'a').turnPlayerId,null);
});

test('Expanded decks scale every original group, preserve color balance and use unique IDs',()=>{
  const sizes=[68,68,68,84,107,121,136];
  for(let n=2;n<=8;n++){
    const deck=createDeck(n),factor=Math.max(1,n/4);
    assert.equal(deck.length,sizes[n-2]);assert.equal(new Set(deck.map(c=>c.id)).size,deck.length);
    for(const color of ['red','green','blue','yellow','wild'])for(const type of ['organ','virus','medicine']){
      const base=type==='organ'?(color==='wild'?1:5):type==='virus'?(color==='wild'?1:4):4;
      assert.equal(deck.filter(c=>c.type===type&&c.color===color).length,Math.round(base*factor));
    }
    for(const [special,base] of [['transplant',1],['thief',3],['contagion',2],['glove',3],['error',1]])assert.equal(deck.filter(c=>c.special===special).length,Math.round(base*factor));
  }
  for(const n of [1,9,2.5,'8',NaN])assert.throws(()=>createDeck(n),/2 y 8/);
});
test('Eight players receive private hands and the expanded deck survives elimination intact',()=>{
  const g=newGame(Array.from({length:8},(_,i)=>({id:`p${i}`,name:`Jugador ${i}`})),()=>.4);
  assert.equal(g.deckSize,136);assert.equal(g.startingPlayerCount,8);assert.equal(g.deck.length,112);
  for(const p of g.players){const view=publicGame(g,p.id);assert.equal(view.hand.length,3);assert.equal(view.deckSize,136);assert.ok(view.players.every(p=>!('hand' in p)));assert.ok(!('deck' in view));}
  g.turn=7;eliminatePlayers(g,['p7','p2']);assert.equal(g.players[g.turn].id,'p0');assert.equal(g.round,2);
  assert.equal(g.deckSize,136);assert.equal(g.startingPlayerCount,8);
  const all=[...g.deck,...g.discard,...g.players.flatMap(p=>[...p.hand,...p.body.flatMap(o=>[o.card,...o.attachments])])];assert.equal(all.length,136);assert.equal(new Set(all.map(c=>c.id)).size,136);
});
test('Glove at eight seats makes all seven rivals refill and advances one complete round',()=>{
  const g=newGame(Array.from({length:8},(_,i)=>({id:`p${i}`,name:`p${i}`})),()=>.4);
  const i=g.deck.findIndex(c=>c.special==='glove'),glove=g.deck.splice(i,1)[0];g.deck.push(...g.players[0].hand.splice(0));g.players[0].hand=[glove];
  const a=legalActions(g,'p0').find(a=>a.cardId===glove.id);act(g,'p0',{type:'play',key:a.key});
  for(let i=1;i<8;i++){assert.equal(g.turn,i);assert.equal(g.players[i].hand.length,0);assert.equal(g.players[i].skip,true);refillTurn(g);assert.equal(g.players[i].hand.length,3);}
  assert.equal(g.turn,0);assert.equal(g.round,2);
  const all=[...g.deck,...g.discard,...g.players.flatMap(p=>p.hand)];assert.equal(all.length,136);assert.equal(new Set(all.map(c=>c.id)).size,136);
});
test('Contagion matches five infections against thirty-five rival organs',()=>{
  const colors=['red','green','blue','yellow','wild'];
  const g=fixture();g.players=Array.from({length:8},(_,i)=>({id:`p${i}`,name:`p${i}`,body:colors.map((color,j)=>organ(`o${i}-${j}`,color,i===0?[card(`v${j}`,'virus',j===0?'wild':color)]:[])),hand:[],skip:false}));
  const plan=contagionPlan(g,g.players[0]);assert.equal(plan.length,5);assert.equal(new Set(plan.map(m=>m.sourceOrganId)).size,5);assert.equal(new Set(plan.map(m=>m.targetOrganId)).size,5);
  for(const m of plan){const source=g.players[0].body.find(o=>o.card.id===m.sourceOrganId),target=g.players.find(p=>p.id===m.targetPlayerId).body.find(o=>o.card.id===m.targetOrganId);assert.ok(matches(source.attachments[0],target.card));}
});
test('Expanded games for five through eight players reach winners without losing or duplicating cards',()=>{
  for(let n=5;n<=8;n++)for(let run=0;run<12;run++){
    let seed=n*100+run;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
    const g=newGame(Array.from({length:n},(_,i)=>({id:`p${i}`,name:`p${i}`})),random),size=g.deckSize;
    for(let turn=0;turn<3000&&!g.winnerId;turn++){
      const p=g.players[g.turn];if(p.skip)refillTurn(g);else{const moves=legalActions(g,p.id),addOrgan=moves.find(a=>p.hand.find(c=>c.id===a.cardId).type==='organ'),move=addOrgan||moves[Math.floor(random()*moves.length)];act(g,p.id,move?{type:'play',key:move.key}:{type:'discard',cardIds:p.hand.map(c=>c.id)});}
      const all=[...g.deck,...g.discard,...g.players.flatMap(p=>[...p.hand,...p.body.flatMap(o=>[o.card,...o.attachments])])];assert.equal(all.length,size);assert.equal(new Set(all.map(c=>c.id)).size,size);
      for(const p of g.players){assert.equal(new Set(p.body.map(o=>o.card.color)).size,p.body.length);assert.ok(p.hand.length<=3);for(const o of p.body){assert.ok(o.attachments.length<=2);if(o.attachments.length===2)assert.ok(o.attachments.every(c=>c.type==='medicine'));}}
    }
    assert.ok(g.winnerId,`Expected a winner for ${n} players, seed ${run}`);
  }
});
