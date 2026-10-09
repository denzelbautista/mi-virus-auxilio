import { cardName, status, COLOR_NAMES, ORGAN_NAMES, SPECIAL_NAMES, matches, deckSizeFor } from '/shared/game.js';
import { cardSVG, backSVG, icon, palette } from '/art.js';
import '/scene.js';
import { turnCueSource, updateTurnCue, refreshTurnCue } from '/turn-cue.js';
import { fitGameViewport } from '/viewport.js';

const app=document.querySelector('#app'), header=document.querySelector('#header'), modal=document.querySelector('#modal');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeRead=(key,fallback)=>{try{return JSON.parse(sessionStorage.getItem(key))??fallback;}catch{return fallback;}};
let session=safeRead('virus:session',null), recent=safeRead('virus:recent',[]);
let accessToken=localStorage.getItem('virus:access')||'', access=null;
let room=null, ws, reconnectTimer, attempts=0, intentional=false, online=false, capacity=8, roomCapacity=4, serverOffset=0;
let selected=null, armed=false, firstTransplant=null, discarding=false, discards=new Set(), busy=false, formMode=new URLSearchParams(location.search).has('sala')?'join':'create';
let sound=localStorage.getItem('virus:sound')==='true', toastTimer, audio, winnerShown=null, initialConnect=true;
const avatarColors=['#d7f68b','#afc9fa','#ffc588','#c8a6f5','#ffacb9','#83d4c3','#e1b7a3','#b3dbe8'];
const descriptions={organ:'Añade este órgano a tu cuerpo. No puedes repetir su color.',virus:'Infecta un órgano, elimina una vacuna o extirpa un órgano infectado compatible.',medicine:'Cura un virus, vacuna un órgano sano o añade una segunda medicina para inmunizarlo.',transplant:'Intercambia dos órganos de dos jugadores cualesquiera. Sus cartas adjuntas viajan con ellos. No pueden estar inmunizados ni producir colores repetidos.',thief:'Roba un órgano de un rival con sus virus o vacunas. No puede estar inmunizado ni repetir un color de tu cuerpo.',contagion:'Traslada el máximo posible de tus virus a órganos libres compatibles de tus rivales. Puedes elegir los destinos.',glove:'Los demás descartan toda su mano. En su siguiente turno solo reponen tres cartas, perdiendo ese turno.',error:'Intercambia todo tu cuerpo con el de un rival, incluidos los órganos inmunizados.'};
const me=()=>room?.game?.players.find(p=>p.id===room.meId);
const isTurn=()=>room?.status==='playing'&&room.game.turnPlayerId===room.meId&&!me()?.skip;
const selectedCard=()=>room?.game?.hand.find(c=>c.id===selected);
const actions=()=>room?.game?.actions.filter(a=>a.cardId===selected)||[];
function store(){sessionStorage.setItem('virus:session',JSON.stringify(session));sessionStorage.setItem('virus:recent',JSON.stringify(recent.slice(0,8)));}
function notify(message,error=false){const toast=document.querySelector('#toast');toast.textContent=message;toast.className=`show${error?' error':''}`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.className='',4500);}
function tone(type='select') {
  if(!sound)return;
  try {audio ||=new (window.AudioContext||window.webkitAudioContext)();audio.resume();const osc=audio.createOscillator(),gain=audio.createGain();osc.connect(gain);gain.connect(audio.destination);const now=audio.currentTime;osc.type='sine';osc.frequency.setValueAtTime(type==='play'?440:type==='turn'?620:340,now);osc.frequency.exponentialRampToValueAtTime(type==='play'?180:880,now+.12);gain.gain.setValueAtTime(.025,now);gain.gain.exponentialRampToValueAtTime(.001,now+.18);osc.start(now);osc.stop(now+.2);}catch{}
}
function connect(){
  clearTimeout(reconnectTimer);ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}`);
  ws.addEventListener('open',()=>{online=true;attempts=0;busy=false;document.querySelector('#connection').hidden=true;renderHeader();if(session)send({type:'resume',...session});else if(!initialConnect)notify('Conexión restablecida.');initialConnect=false;});
  ws.addEventListener('message',e=>{
    const msg=JSON.parse(e.data);
    if(msg.type==='hello'){capacity=msg.maxPlayers;roomCapacity=Math.min(roomCapacity,capacity);if(!room)renderLanding();return;}
    if(msg.type==='session'){session={code:msg.code,token:msg.token};recent=recent.filter(s=>s.code!==msg.code);recent.unshift(session);store();return;}
    if(msg.type==='sessionExpired'||msg.type==='eliminated'||msg.type==='rematchExcluded'){recent=recent.filter(s=>s.code!==session?.code);session=null;room=null;busy=false;resetSelection();closeModal();store();render();notify(msg.message||'Esta sala ya no está disponible. Puedes crear otra.',true);return;}
    if(msg.type==='left'){session=null;room=null;busy=false;resetSelection();store();closeModal();render();refreshAccess();return;}
    if(msg.type==='error'){busy=false;notify(msg.message,true);if(room)render();else{const el=document.querySelector('#form-error');if(el)el.textContent=msg.message;const b=document.querySelector('#submit-room');if(b)b.disabled=false;}return;}
    if(msg.type==='state'){
      const before=room, event=msg.game?.lastEvent;
      const newEvent=before?.game&&event&&event.sequence!==before.game.lastEvent?.sequence;
      const from=newEvent?eventSource(event):null;
      const turnFrom=turnCueSource(before);
      room=msg;if(access&&!access.rooms.includes(msg.code))access.rooms.push(msg.code);busy=false;serverOffset=msg.serverTime?msg.serverTime-Date.now():0;
      if(before?.code!==msg.code||before?.game?.turnPlayerId!==msg.game?.turnPlayerId||newEvent||selected&&!msg.game?.hand.some(c=>c.id===selected)){resetSelection();}
      render();
      if(before?.game?.turnPlayerId!==msg.game?.turnPlayerId&&isTurn())tone('turn');
      if(newEvent&&event.card&&from)animateCard(event,from);
      updateTurnCue(before,room,turnFrom,newEvent&&event.card&&from?620:0);
      if(room.status==='finished'&&before?.rematch?.id===msg.rematch?.id&&JSON.stringify(before?.rematch)!==JSON.stringify(msg.rematch)&&modal.open)showWinner();
      if(room.status==='finished'&&before?.rematch?.id!==msg.rematch?.id&&modal.open)showWinner();
      if(room.status==='finished'&&winnerShown!==`${room.code}:${event?.sequence}`){winnerShown=`${room.code}:${event?.sequence}`;setTimeout(showWinner,newEvent?650:0);}
      if(before?.status==='finished'&&room.status==='playing'){winnerShown=null;closeModal();}
    }
  });
  ws.addEventListener('close',e=>{
    online=false;busy=false;renderHeader();
    if(e.code===4001){intentional=true;document.querySelector('#connection').hidden=false;document.querySelector('#connection').textContent='Esta sesión está abierta en otra ventana. Recarga para retomarla.';return;}
    if(intentional)return;
    const el=document.querySelector('#connection');el.hidden=false;el.textContent='Reconectando… Tu partida se conserva.';
    reconnectTimer=setTimeout(connect,Math.min(1000*2**attempts++,12000));
  });
  ws.addEventListener('error',()=>{});
}
function send(msg){if(!online||ws.readyState!==WebSocket.OPEN){notify('Esperando conexión con el laboratorio…',true);return false;}ws.send(JSON.stringify(msg));return true;}
function request(type,extra={}){if(busy)return;busy=true;if(!send({type,version:room?.version,accessToken,...extra}))busy=false;}
function resetSelection(){selected=null;armed=false;firstTransplant=null;discarding=false;discards.clear();}
function renderHeader(){
  header.innerHTML=`<button class="brand" data-do="home" aria-label="VIRUS! El laboratorio"><span class="brand-mark">${icon('flask')}</span><span><span class="brand-name">VIRUS<em>!</em></span><span class="brand-sub">EL LABORATORIO</span></span></button><div class="header-tools">${room?`<button class="room-badge" data-do="invite" aria-label="Invitar a la sala ${esc(room.code)}"><span>${room.practice?'PRÁCTICA':'SALA'}</span><b>${room.practice?'CON BOTS':esc(room.code)}</b>${room.practice?'':icon('copy')}</button>`:`<span class="header-status"><i class="dot ${online?'':'offline'}"></i>${online?'Laboratorio en línea':'Conectando'}</span>`}<button class="icon-btn" data-do="sound" title="${sound?'Silenciar':'Activar sonido'}" aria-label="${sound?'Silenciar':'Activar sonido'}">${icon(sound?'sound':'muted')}</button><button class="icon-btn" data-do="rules" title="Cómo jugar" aria-label="Cómo jugar">${icon('help')}</button>${room?`<button class="icon-btn" data-do="leave" title="Salir de la sala" aria-label="Salir de la sala">${icon('exit')}</button>`:`<button class="text-btn" data-do="catalog">Las cartas ${icon('arrow')}</button>`}</div>`;
}
function render(){renderHeader();if(!room)renderLanding();else if(room.status==='lobby')renderLobby();else renderGame();refreshTurnCue(room);if(!room||room.status==='lobby')fitGameViewport();}
async function refreshAccess(){
  if(!accessToken)return;
  try{const r=await fetch('/api/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:accessToken})});const value=await r.json();if(!r.ok)throw new Error(value.error);access=value.access;if(access.kind==='room')formMode='join';}
  catch{access=null;accessToken='';localStorage.removeItem('virus:access');}
  if(!room)renderLanding();
}
function accessEntry(){
  return `<form class="room-form access-form" id="access-form"><div class="eyebrow">TU INVITACIÓN AL LABORATORIO</div><h2>Primero, tu código de acceso.</h2><p>Ingresa el acceso que recibiste para abrir o unirte a una sala.</p><label class="field">Código de acceso<input name="accessCode" autocomplete="off" maxlength="100" placeholder="VIR-…" required/></label><button class="primary full" type="submit">Validar acceso ${icon('arrow')}</button><p id="access-error" class="form-error" role="alert"></p></form>`;
}
function accessSummary(){
  return `<div class="access-summary"><strong>${access.kind==='full'?'Acceso total':access.kind==='room'?'Acceso individual · Sala '+esc(access.roomCode):'Acceso temporal'}</strong><span>Válido hasta ${new Date(access.expiresAt).toLocaleString('es-PE',{dateStyle:'short',timeStyle:'short'})}${access.kind==='limited'?` · ${access.rooms.length}/${access.maxRooms} salas utilizadas`:''}</span><button type="button" data-do="change-access">Cambiar código</button></div>`;
}
function renderLanding(){
  const savedName=localStorage.getItem('virus:name')||'', code=access?.kind==='room'?access.roomCode:new URLSearchParams(location.search).get('sala')||'';
  app.innerHTML=`<section class="landing"><div class="landing-copy"><div class="eyebrow">Un pequeño caos. Una gran partida.</div><h1>La mejor cura<br>es <span>jugar sucio.</span></h1><p class="intro">Construye tu cuerpo. Contagia a tus amigos.<br>El primero con cuatro órganos sanos se lleva la gloria.</p>${!access?accessEntry():accessSummary()+`<form class="room-form" id="room-form"><div class="tabs"><button ${access.kind==='room'?'hidden':''} type="button" class="tab ${formMode==='create'?'active':''}" data-do="tab-create">Crear una sala</button><button type="button" class="tab ${formMode==='join'?'active':''}" data-do="tab-join">Unirme a una sala</button></div><label class="field">Tu nombre en el laboratorio<input id="player-name" name="name" autocomplete="nickname" maxlength="24" placeholder="¿Cómo te llamamos?" value="${esc(savedName)}" required/></label>${formMode==='create'?`<label class="field">Nombre de la sala <span style="opacity:.5">· opcional</span><input name="roomName" maxlength="24" placeholder="Los sospechosos de siempre"/></label><label class="field">Plazas de la sala<select name="maxPlayers" id="room-capacity" class="select">${Array.from({length:capacity-1},(_,i)=>i+2).map(n=>`<option value="${n}" ${n===roomCapacity?'selected':''}>${n} jugadores</option>`).join('')}</select></label><p class="deck-note">El mazo se ajusta a quienes jueguen: desde cinco participantes añadimos cartas de los mismos tipos y colores.</p>`:`<label class="field">Código de la sala<input name="code" maxlength="6" placeholder="Ej. LAB234" value="${esc(code)}" style="text-transform:uppercase;letter-spacing:3px" required/></label>`}<button id="submit-room" type="submit" class="primary full">${icon(formMode==='create'?'flask':'users')}${formMode==='create'?'Abrir el laboratorio':'Entrar al laboratorio'}${icon('arrow')}</button><p id="form-error" class="form-error" role="alert"></p></form>`}${access&&access.kind!=='room'?`<button class="practice-btn" data-do="practice">${icon('spark')}¿Vienes solo? <span>Practica con bots</span> ${icon('arrow')}</button>`:''}${recent.length?`<button class="practice-btn" data-do="resume">${icon('link')}Reanudar sala <span>${esc(recent[0].code)}</span></button>`:''}</div><div class="hero"><div class="hero-orbit"></div><span class="hero-dot"></span><span class="hero-plus">+</span><div class="hero-tag">${icon('users')}2–${capacity} jugadores · una dosis de caos</div><div class="hero-cards"><div class="hero-card">${cardSVG({id:'hero1',type:'organ',color:'red'})}</div><div class="hero-card">${cardSVG({id:'hero2',type:'medicine',color:'blue'})}</div><div class="hero-card">${cardSVG({id:'hero3',type:'virus',color:'green'})}</div></div><div class="hero-tag bottom">${icon('shield')}Tu amistad no está inmunizada.</div><div class="hero-caption">68–${deckSizeFor(capacity)} CARTAS. INFINITAS MALAS INTENCIONES.</div></div></section><footer class="site-footer"><div class="features"><span class="feature">${icon('users')}Salas privadas</span><span class="feature">${icon('link')}En tiempo real</span><span class="feature">${icon('shield')}Cada partida, su mundo</span></div><span>Una adaptación independiente · Arte original · <a href="/admin">Administración</a></span></footer>`;
}
function avatar(p,index,large=false){return `<div class="avatar ${p.bot?'bot':''}" style="--avatar:${avatarColors[index%avatarColors.length]}" aria-hidden="true">${esc(p.name.trim().slice(0,2).toUpperCase())}</div>`;}
function renderLobby(){
  const host=room.meId===room.hostId, count=room.members.length, allOnline=room.members.every(m=>m.connected);
  app.innerHTML=`<section class="lobby"><div class="eyebrow">La calma antes del contagio</div><h1>${esc(room.roomName)}</h1><p>El laboratorio está listo. Solo faltan tus cómplices.<br>Comparte el código de la sala con tus amigos.</p><div class="invite"><div><small>CÓDIGO DE LA SALA</small><strong>${esc(room.code)}</strong></div><button class="icon-btn" data-do="invite" title="Copiar código de sala" aria-label="Copiar código de sala">${icon('copy')}</button></div><div class="seats">${Array.from({length:room.maxPlayers},(_,i)=>{const p=room.members[i];return p?`<div class="lobby-seat">${avatar(p,i,true)}<strong>${esc(p.name)}${p.id===room.meId?' (tú)':''}</strong><small><i class="dot ${p.connected?'':'offline'}"></i> ${p.id===room.hostId?'Anfitrión':p.connected?'En el laboratorio':'Reconectando'}</small></div>`:`<div class="lobby-seat empty"><div class="avatar">${icon('users')}</div><strong>Asiento libre</strong><small>Esperando un cómplice</small></div>`;}).join('')}</div><button class="primary lobby-action" data-do="start" ${!host||count<2||!allOnline||busy?'disabled':''}>${icon('spark')}${host?'Que empiece el contagio':'Esperando al anfitrión'}${icon('arrow')}</button><div class="lobby-info">${count} de ${room.maxPlayers} jugadores ${host&&count>=2&&count<room.maxPlayers?'· Puedes empezar ahora o esperar a los demás.':''}</div><div class="hint">${icon('heart')} Gana con 4 órganos sanos diferentes. ${count>=2?`${deckSizeFor(count)} cartas para ${count} participantes.`:'El mazo se ajustará al comenzar.'}</div></section>`;
}
function targetable(p,o){if(!armed||!isTurn())return false;let a=actions();if(selectedCard()?.special==='transplant'&&firstTransplant)return a.some(a=>a.targetPlayerId===firstTransplant.playerId&&a.targetOrganId===firstTransplant.organId&&a.otherPlayerId===p.id&&a.otherOrganId===o.card.id||a.otherPlayerId===firstTransplant.playerId&&a.otherOrganId===firstTransplant.organId&&a.targetPlayerId===p.id&&a.targetOrganId===o.card.id);return a.some(a=>a.targetPlayerId===p.id&&a.targetOrganId===o.card.id||a.otherPlayerId===p.id&&a.otherOrganId===o.card.id);}
function bodyCards(p,own=false){
  if(!p.body.length)return `<div class="body-empty" aria-label="Cuerpo vacío">${Array.from({length:own?4:3},()=>'<span class="empty-slot">+</span>').join('')}</div>`;
  return p.body.map(o=>{
    const s=status(o), valid=targetable(p,o), chosen=firstTransplant?.organId===o.card.id;
    const labels={healthy:'Sano',infected:'Infectado',vaccinated:'Vacunado',immune:'Inmune'};
    return `<button class="body-organ ${valid?'targetable':''} ${chosen?'chosen':''}" data-do="organ" data-player="${p.id}" data-organ="${o.card.id}" title="${esc(cardName(o.card))} · ${labels[s]}${valid?' · Elegir destino':''}" aria-label="${esc(cardName(o.card))} de ${esc(p.name)}, ${labels[s]}"><span class="organ-stack" style="--layers:${o.attachments.length}"><span class="organ-base">${cardSVG(o.card)}</span>${o.attachments.map((card,i)=>`<span class="organ-attachment" style="--layer:${o.attachments.length-1-i};z-index:${i+1}" data-attachment="${card.id}">${cardSVG(card)}</span>`).join('')}</span></button>`;
  }).join('');
}
function playerTag(p,idx){const member=room.members.find(m=>m.id===p.id),active=room.game.turnPlayerId===p.id&&room.status==='playing';return `<div class="player-tag ${active?'active':''} ${!member?.connected?'absent':''}" data-player-tag="${p.id}" title="${esc(p.name)}${!member?.connected?' · Desconectado':''}" aria-label="${esc(p.name)}${p.id===room.meId?', tú':''}${active?', turno actual':''}${!member?.connected?', desconectado':''}">${avatar(p,idx)}<div class="player-name">${esc(p.name)}</div></div>`;}
function discardPile(g) {
  const cards=g.discardPreview || (g.discardTop?[g.discardTop]:[]);
  const angles=[-13,16,-9,11,-18,5];
  return `<div class="pile discard">${cards.length?`<div class="discard-stack" data-pile="discard" aria-label="Pila de descarte">${cards.map((card,i)=>{
    const index=g.discardCount-cards.length+i;
    return `<div class="discard-layer" style="--rotation:${angles[index%angles.length]}deg;--dx:${(i-(cards.length-1)/2)*4}px;--dy:${(cards.length-1-i)*-2}px;z-index:${i}">${cardSVG(card)}</div>`;
  }).join('')}</div>`:`<div class="empty-pile" data-pile="discard">${icon('trash')}</div>`}<div class="pile-label">DESCARTE <b>${g.discardCount}</b></div></div>`;
}
function updateCountdowns() {
  document.querySelectorAll('[data-offline-until],[data-countdown-until]').forEach(el=>{
    const remaining=Math.max(0,Math.ceil((Number(el.dataset.offlineUntil||el.dataset.countdownUntil)-Date.now()-serverOffset)/1000));
    el.textContent=`${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;
  });
}
setInterval(updateCountdowns,1000);
function pilotStatus(){
  if(room.status!=='playing')return '';
  const own=room.members.find(m=>m.id===room.meId);
  if(own?.autopilot){const n=Math.max(0,room.autoTurnLimit-own.autoTurns);return `<div class="pilot-status automatic" role="status"><strong>Piloto automático</strong><span>Te queda${n===1?'':'n'} ${n} turno${n===1?'':'s'}</span></div>`;}
  return room.turnDeadline?`<div class="pilot-status"><span>Piloto automático en <b data-countdown-until="${room.turnDeadline}"></b></span></div>`:'';
}
function renderGame(){
  const g=room.game, own=me(), myTurn=isTurn(), turn=g.players.find(p=>p.id===g.turnPlayerId), c=selectedCard();
  const myIndex=g.players.findIndex(p=>p.id===room.meId);
  const ordered=Array.from({length:g.players.length-1},(_,i)=>g.players[(myIndex+i+1)%g.players.length]);
  const expanded=g.players.length>4;
  const sideCount=g.players.length>=7?2:1;
  const frontCount=ordered.length-sideCount*2;
  const seats=ordered.map((p,i)=>{
    let cls, position='';
    if(expanded){
      cls=i<sideCount?'seat-right':i<sideCount+frontCount?'seat-top':'seat-left';
      const row=cls==='seat-right'?sideCount-1-i:i-sideCount-frontCount;
      position=cls==='seat-top'?`--seat-x:${88-(i-sideCount+.5)*76/frontCount}%`:`--seat-row:${row}`;
    }else cls=ordered.length===1?'seat-top':ordered.length===2?(i===0?'seat-right':'seat-left'):i===0?'seat-right':i===ordered.length-1?'seat-left':'seat-top';
    return `<section class="seat ${cls}" style="${position}" aria-label="Jugador ${esc(p.name)}">
      ${playerTag(p,g.players.indexOf(p))}
      <div class="hand-backs" data-hand-player="${p.id}" aria-label="Mano oculta de ${esc(p.name)}">${Array.from({length:p.handCount},()=>`<div class="mini-back">${backSVG()}</div>`).join('')}</div>
      <div class="body-cards" aria-label="Órganos frente a ${esc(p.name)}">${bodyCards(p)}</div>
    </section>`;
  }).join('');
  const hint=discarding?'Elige las cartas que quieres cambiar. Esto consume tu turno.':c?(armed?'Elige un órgano resaltado en la mesa.':'Otro clic en la carta para jugarla. También puedes usar el botón.'):'Un clic para seleccionar. Otro para jugar. Que empiece el caos.';
  const member=room.members.find(m=>m.id===turn?.id), disconnected=room.status==='playing'&&member&&!member.connected;
  const until=disconnected?member.offlineSince+(room.disconnectTimeoutMs||300000):0;
  const turnText=room.status==='finished'?'Partida terminada':disconnected?`${esc(turn.name)} se desconectó · <span class="disconnect-count" data-offline-until="${until}"></span> para volver`:own.skip&&turn?.id===own.id?'Repones tu mano · pierdes este turno':myTurn?'Tu turno. Haz de las tuyas.':`Turno de ${esc(turn?.name||'tu rival')}`;
  app.innerHTML=`<div class="game-layout ${expanded?'expanded-game':''}">
    <div class="game-viewport">
    <section class="table ${expanded?'expanded-table':''}" style="--rival-rows:${Math.ceil(ordered.length/2)}" aria-label="Mesa de juego">
      <div class="table-label"><i class="dot"></i>${room.practice?'MODO PRÁCTICA':'PARTIDA PRIVADA'} <span> / </span><b>${esc(room.roomName)}</b></div>
      <div class="turn-counter">RONDA <b>${String(g.round).padStart(2,'0')}</b> · ${g.players.length} JUGADORES</div>
      <div class="table-orbit" aria-hidden="true"></div>
      <div class="pile deck-pile"><div class="pile-card" data-pile="deck">${backSVG()}</div><div class="pile-label">MAZO <b>${g.deckCount}</b></div></div>
      <div class="rival-seats">${seats}</div>
      <div class="table-center">${discardPile(g)}</div>
      ${armed?`<div class="target-banner">${firstTransplant?'Ahora elige el segundo órgano.':c?.special==='transplant'?'Elige el primer órgano del intercambio.':'Elige dónde jugar tu carta.'}<small>Los destinos válidos brillan en verde.</small></div>`:''}
      <div class="own-zone">
        <div class="own-player">${playerTag(own,myIndex)}${pilotStatus()}</div>
        <div class="own-body"><span class="body-title">TU CUERPO</span><div class="body-cards" data-own-body>${bodyCards(own,true)}</div></div>
      </div>
      <div class="hand-zone">
        <div class="turn-pill ${myTurn?'':'waiting'} ${disconnected?'disconnected':''}">${icon(myTurn?'spark':'users')}${turnText}</div>
        ${c?`<div class="selection-info"><small>${c.type==='special'?'TRATAMIENTO':COLOR_NAMES[c.color].toUpperCase()}</small><strong>${esc(cardName(c))}</strong><p>${esc(descriptions[c.special||c.type])}</p></div>`:''}
        <div class="hand" aria-label="Tus cartas">${g.hand.map((card,i)=>`<button class="hand-card ${selected===card.id?'selected':''} ${discards.has(card.id)?'discard-selected':''}" data-do="card" data-card="${card.id}" style="--rot:${(i-(g.hand.length-1)/2)*8}deg" title="${esc(cardName(card))}" aria-label="${esc(cardName(card))}${selected===card.id?', seleccionada':''}" aria-pressed="${selected===card.id||discards.has(card.id)}">${cardSVG(card)}${discards.has(card.id)?`<span class="card-check">${icon('check')}</span>`:''}</button>`).join('')}</div>
        <div class="hand-actions">${room.members.find(m=>m.id===room.meId)?.autopilot?'<button class="secondary" data-do="takeover">Retomar control</button>':''}${discarding?`
          <button class="primary" data-do="confirm-discard" ${!discards.size||!myTurn||busy?'disabled':''}>${icon('trash')}Cambiar ${discards.size||''} carta${discards.size===1?'':'s'}</button>
          <button class="secondary" data-do="cancel">Cancelar</button>`:`
          ${c?`<button class="primary" data-do="play" ${!myTurn||!actions().length||busy?'disabled':''}>${icon('arrow')}${armed?'Elegir destino':'Jugar carta'}</button>`:''}
          <button class="${c?'secondary':'discard-toggle'}" data-do="discard" ${!myTurn||busy?'disabled':''}>${icon('trash')}Cambiar cartas</button>
          ${room.status==='finished'?`<button class="primary" data-do="winner">${icon('trophy')}Ver resultado</button>`:''}`}
        </div>
        <p class="hand-hint">${esc(hint)}</p>
      </div>
    </section>
    </div>
    <aside class="feed">
      <div class="feed-title">En el laboratorio <span>${g.players.length} JUGADORES</span></div>
      <div class="objective"><span class="inline-icon">${icon('heart')}</span><strong>Un cuerpo sano. Una victoria.</strong><p>Reúne cuatro órganos diferentes, libres de virus, vacunados o inmunizados.</p><div class="progress">${Array.from({length:4},(_,i)=>`<span class="${i<own.healthy?'done':''}"></span>`).join('')}</div></div>
      <div class="log-title">ÚLTIMOS MOVIMIENTOS</div>
      <div class="log" aria-live="polite">${g.lastEvent?room.history.slice().reverse().map(e=>`<div class="log-entry" style="--event-color:${palette[e.card?.color]?.[0]||'#d7f68b'}">${esc(e.text)}<small>${new Date(e.at).toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})}</small></div>`).join(''):'<div class="log-entry">Todo está demasiado tranquilo.<br>La primera dosis corre por tu cuenta.</div>'}</div>
      <div class="feed-tip"><b>Receta para sobrevivir</b><br>Dos medicinas hacen un órgano inmune. Las amistades, por desgracia, no tienen vacuna.<button data-do="rules">${icon('book')}Consultar las reglas ${icon('arrow')}</button></div>
    </aside>
  </div>`;
  updateCountdowns();
  fitGameViewport();
  refreshTurnCue(room);
}

function playSelected(){
  if(!isTurn()||busy){notify('Puedes mirar tus cartas mientras esperas tu turno.');return;}
  const c=selectedCard(), opts=actions();if(!c)return;if(!opts.length){notify('Esta carta no tiene un destino válido. Puedes cambiarla.',true);return;}
  if(c.special==='contagion'){showContagion(opts[0]);return;}
  if(c.special==='error'){showChoices(opts);return;}
  if(c.type==='organ'||c.special==='glove'){perform(opts[0]);return;}
  armed=true;firstTransplant=null;renderGame();
}
function perform(a,moves){if(busy||!isTurn())return;closeModal();request('action',{action:{type:'play',key:a.key,...(moves?{moves}:{})}});tone('play');renderGame();}
function selectOrgan(playerId,organId){
  const p=room.game.players.find(p=>p.id===playerId), o=p?.body.find(o=>o.card.id===organId);if(!o)return;
  if(!armed||!targetable(p,o)){inspectOrgan(p,o);return;}
  if(selectedCard()?.special==='transplant'){
    if(!firstTransplant){firstTransplant={playerId,organId};renderGame();return;}
    const a=actions().find(a=>a.targetPlayerId===firstTransplant.playerId&&a.targetOrganId===firstTransplant.organId&&a.otherPlayerId===playerId&&a.otherOrganId===organId||a.otherPlayerId===firstTransplant.playerId&&a.otherOrganId===firstTransplant.organId&&a.targetPlayerId===playerId&&a.targetOrganId===organId);
    if(a)perform(a);
  }else{const a=actions().find(a=>a.targetPlayerId===playerId&&a.targetOrganId===organId);if(a)perform(a);}
}
function eventSource(e){const el=e.actorId===room.meId?document.querySelector(`[data-card="${e.card?.id}"]`):document.querySelector(`[data-hand-player="${e.actorId}"]`);return(el||document.querySelector(`[data-player-tag="${e.actorId}"]`))?.getBoundingClientRect();}
function animateCard(e,from){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const target=!e.discard&&e.card.type!=='special'?(document.querySelector(`[data-organ="${e.targetOrganId||e.card.id}"]`)||document.querySelector(`[data-player-tag="${e.targetPlayerId}"]`)):document.querySelector('[data-pile="discard"]');
  if(!target)return;
  const tableScale=Number(target.closest('.game-viewport')?.style.getPropertyValue('--board-scale'))||1;
  const to=target.getBoundingClientRect(),fly=document.createElement('div');fly.className='flight-card';fly.innerHTML=cardSVG(e.card);fly.style.width=`${100*tableScale}px`;fly.style.left=`${from.x+from.width/2-50*tableScale}px`;fly.style.top=`${from.y+from.height/2-70*tableScale}px`;document.body.append(fly);
  const dx=to.x+to.width/2-(from.x+from.width/2),dy=to.y+to.height/2-(from.y+from.height/2),scale=target.offsetWidth/100;
  const seat=target.closest('.seat'),layer=target.querySelector('.discard-layer:last-child');
  const angle=layer?parseFloat(layer.style.getPropertyValue('--rotation')):seat?.classList.contains('seat-left')?90:seat?.classList.contains('seat-right')?-90:seat?.classList.contains('seat-top')?180:0;
  const incline=0;
  const anim=fly.animate([{transform:'perspective(800px) translate3d(0,0,0) rotateX(0deg) rotateZ(-5deg) scale(1)'},{transform:`perspective(800px) translate3d(${dx*.5}px,${dy*.5-85*tableScale}px,${140*tableScale}px) rotateX(-30deg) rotateZ(${angle*.4+12}deg) scale(1.25)`,offset:.5},{transform:`perspective(800px) translate3d(${dx}px,${dy}px,0) rotateX(${incline}deg) rotateZ(${angle}deg) scale(${scale})`}],{duration:620,easing:'cubic-bezier(.22,.61,.36,1)'});
  anim.finished.then(()=>{fly.remove();target.classList.add('body-pop');setTimeout(()=>target.classList.remove('body-pop'),500);});
}
function openModal(html){modal.innerHTML=html;if(!modal.open)modal.showModal();}
function closeModal(){if(modal.open)modal.close();}
function modalHead(title,kicker='EL LABORATORIO'){return `<div class="modal-head"><div><div class="eyebrow">${kicker}</div><h2>${title}</h2></div><button class="icon-btn" data-do="close-modal" aria-label="Cerrar">${icon('close')}</button></div>`;}
function showChoices(opts){openModal(`${modalHead('Elige un cuerpo para intercambiar','ERROR MÉDICO')}<p class="modal-copy">Tu cuerpo completo y el del rival intercambian posiciones. Incluye los órganos inmunizados.</p><div class="choose-list">${opts.map(a=>{const p=room.game.players.find(p=>p.id===a.targetPlayerId);return `<button class="choice" data-do="choice" data-key="${a.key}"><span>${esc(p.name)} · ${p.body.length} órganos · ${p.healthy} sanos</span>${icon('arrow')}</button>`;}).join('')}</div>`);}
let contagionAction=null;
function showContagion(a){
  contagionAction=a;const own=me(),sources=own.body.filter(o=>status(o)==='infected');
  openModal(`${modalHead('Reparte el contagio','TRATAMIENTO')}<p class="modal-copy">Debes trasladar <b>${a.moves.length} virus</b>, el máximo posible. Elige órganos libres de tus rivales. Cada destino admite un solo virus.</p><form id="contagion-form">${sources.map(o=>{const defaults=a.moves.find(m=>m.sourceOrganId===o.card.id),targets=room.game.players.filter(p=>p.id!==own.id).flatMap(p=>p.body.filter(t=>status(t)==='healthy'&&matches(o.attachments[0],t.card)).map(t=>({p,t})));return `<div class="planner-row"><label>${esc(cardName(o.card))}<br><small>${esc(cardName(o.attachments[0]))}</small></label><select name="${o.card.id}" aria-label="Destino del virus de ${esc(cardName(o.card))}"><option value="">Mantener aquí</option>${targets.map(({p,t})=>`<option value="${p.id}:${t.card.id}" ${defaults?.targetOrganId===t.card.id?'selected':''}>${esc(p.name)} · ${esc(cardName(t.card))}</option>`).join('')}</select></div>`;}).join('')}<div class="modal-actions"><button type="button" class="secondary" data-do="close-modal">Cancelar</button><button type="submit" class="primary">${icon('arrow')}Propagar los virus</button></div></form>`);
}
function inspectOrgan(p,o){openModal(`${modalHead('Ficha del órgano',esc(p.name))}<div class="inspection"><div class="big-card">${cardSVG(o.card)}</div><div><h3>${esc(cardName(o.card))}</h3><p>Estado: <b>${{healthy:'sano',infected:'infectado',vaccinated:'vacunado',immune:'inmunizado'}[status(o)]}</b>.</p><p>${status(o)==='immune'?'Dos medicinas lo protegen frente a virus, robos y trasplantes. Error médico sí puede intercambiarlo.':status(o)==='infected'?'No cuenta para ganar. Una medicina compatible con el virus lo cura; un segundo virus compatible con el órgano lo destruye.':status(o)==='vaccinated'?'Cuenta como sano. Un virus compatible con la medicina elimina la vacuna. Una segunda medicina compatible con el órgano lo inmuniza.':'Cuenta para ganar. Puedes vacunarlo con una medicina compatible.'}</p>${o.attachments.length?`<div class="attachments">${o.attachments.map(c=>cardSVG(c)).join('')}</div>`:''}</div></div>`);}
function showRules(tab='basic'){
  const tabs=`<div class="rule-tabs"><button class="tab ${tab==='basic'?'active':''}" data-do="rules-basic">Lo esencial</button><button class="tab ${tab==='special'?'active':''}" data-do="rules-special">Tratamientos</button><button class="tab ${tab==='colors'?'active':''}" data-do="rules-colors">Multicolor</button></div>`;
  let content;
  if(tab==='basic')content=`<div class="rule-list"><article class="rule-item"><span class="inline-icon">${icon('heart')}</span><strong>Cuatro órganos sanos</strong><p>Gana con 4 órganos diferentes sanos, vacunados o inmunizados. Cada color aparece una sola vez en tu cuerpo. El multicolor es un quinto órgano distinto.</p></article><article class="rule-item"><span class="inline-icon">${icon('arrow')}</span><strong>Una acción por turno</strong><p>Juega una carta o descarta entre 1 y 3. Después repones automáticamente tu mano hasta 3 cartas. No puedes pasar sin actuar.</p></article><article class="rule-item"><span class="inline-icon">${icon('spark')}</span><strong>Virus: pequeños saboteadores</strong><p>Un virus infecta un órgano compatible. Otro lo extirpa. Si hay una vacuna, el virus elimina la medicina compatible y ambos se descartan. Los órganos inmunes están protegidos.</p></article><article class="rule-item"><span class="inline-icon">${icon('shield')}</span><strong>Medicina: cura y protege</strong><p>Una medicina compatible cura un virus: ambos se descartan. En un órgano libre vacuna; una segunda medicina inmuniza. Puedes usar medicinas y virus sobre tu cuerpo o sobre el de un rival.</p></article><article class="rule-item full-rule"><strong>De 2 a 8 jugadores</strong><p>Esta adaptación permite ocho participantes. Hasta cuatro usamos el mazo de 68 cartas; desde cinco aumentamos las copias de cada tipo y color en proporción al grupo. A ocho hay 136 cartas. El mazo se fija al comenzar y se conserva si alguien queda eliminado. Es una variante propia para mesas ampliadas.</p></article><article class="rule-item full-rule"><strong>Un clic, y luego otro</strong><p>El primer clic eleva una carta. El segundo la juega o resalta sus destinos válidos. Haz clic en el órgano elegido para lanzarla. Para cambiar cartas, activa «Cambiar cartas», elige una o varias y confirma. Al agotarse el mazo, se voltea el descarte sin barajar.</p></article></div>`;
  else if(tab==='special')content=`<div class="special-list" style="margin-top:18px">${Object.entries(SPECIAL_NAMES).map(([special,name])=>`<article>${cardSVG({id:`help-${special}`,type:'special',color:'purple',special})}<div><strong>${name}</strong><p>${descriptions[special]}</p></div></article>`).join('')}</div>`;
  else content=`<div class="rule-list"><article class="rule-item full-rule"><strong>El órgano multicolor siempre es multicolor</strong><p>Puede recibir virus y vacunas de cualquier color, y dos medicinas diferentes pueden inmunizarlo. No cambia de color cuando recibe una carta. Puedes tener cinco órganos y ganar si cuatro están sanos.</p></article><article class="rule-item full-rule"><strong>Para curar, mira el virus. Para quitar una vacuna, mira la medicina.</strong><p>La cura debe coincidir con el virus, incluso sobre un órgano multicolor. Un virus elimina una vacuna de su mismo color. Virus y medicinas multicolor son compatibles con cualquier color.</p></article><article class="rule-item full-rule"><strong>Para extirpar o inmunizar, mira el órgano</strong><p>Una carta multicolor adjunta no cambia el órgano. Si un corazón rojo tiene un virus multicolor, necesitas otro virus rojo o multicolor para destruirlo. Si tiene una medicina multicolor, necesitas otra roja o multicolor para inmunizarlo.</p></article></div>`;
  openModal(`${modalHead('La receta del caos')}${tabs}${content}<div class="rule-source">Reglas: el reglamento VIRUS! que adjuntaste y <a href="https://tranjisgames.com/blog/nuestros-juegos-7/virus-preguntas-frecuentes-9" target="_blank" rel="noreferrer">las aclaraciones de Tranjis Games</a>. Ilustraciones originales de esta adaptación.</div>`);
}
function showCatalog(){const cards=['organ','virus','medicine'].flatMap(type=>['red','green','blue','yellow','wild'].map(color=>({id:`catalog-${type}-${color}`,type,color}))).concat(Object.keys(SPECIAL_NAMES).map(special=>({id:`catalog-${special}`,type:'special',special,color:'purple'})));openModal(`${modalHead('Conoce a los sospechosos','LAS CARTAS')}<p class="modal-copy">Una familia de ilustraciones vectoriales originales. Cinco colores, cuatro tipos y demasiadas formas de meterse en problemas.</p><div class="catalog">${cards.map(c=>`<div class="catalog-card">${cardSVG(c)}${esc(cardName(c))}</div>`).join('')}</div>`);}
function rematchControls(){
  const proposal=room.rematch;
  if(proposal?.status==='pending'){
    const vote=proposal.votes[room.meId];
    return `<div class="rematch-box"><h3>¿Otra dosis?</h3><p>Confirma tu participación · <b data-countdown-until="${proposal.deadline}"></b></p><ul>${room.members.map(m=>`<li>${esc(m.name)} · ${{yes:'Confirmó',no:'No jugará',pending:'Esperando respuesta'}[proposal.votes[m.id]]||'No participa'}</li>`).join('')}</ul>${vote!=='yes'?'<button class="primary" data-do="rematch-yes">Confirmar revancha</button>':'<p>Ya confirmaste. Esperando a los demás.</p>'}${vote!=='no'?'<button class="secondary" data-do="rematch-no">No participar</button>':''}</div>`;
  }
  if(room.maxGames&&room.matchNumber>=room.maxGames)return '<p>Esta sala completó las partidas incluidas.</p>';
  return `${proposal?.message?`<p>${esc(proposal.message)}</p>`:''}${room.game.players.length>=2?`<button class="primary" data-do="rematch">${icon('spark')}Solicitar revancha</button>`:'<p>No quedan suficientes jugadores para una revancha.</p>'}`;
}
function showWinner(){
  if(room?.status!=='finished')return;
  const winner=room.game.players.find(p=>p.id===room.game.winnerId);if(!winner)return;
  const won=winner.id===room.meId, forfeit=room.game.winnerReason==='abandonment';
  openModal(`<div class="winner"><div class="winner-icon">${icon('trophy')}</div><h2>${won?'El laboratorio es tuyo.':`${esc(winner.name)} se lleva la gloria.`}</h2><p>${forfeit?'Victoria por abandono.':won?'Cuatro órganos sanos. Unas cuantas amistades en observación.':'Un cuerpo completo. Una victoria contagiosa.'}</p>${forfeit?'':`<div class="winner-body">${winner.body.filter(o=>status(o)!=='infected').slice(0,4).map(o=>cardSVG(o.card)).join('')}</div>`}${rematchControls()}<button class="secondary" data-do="close-modal">Volver a la mesa</button></div>`);updateCountdowns();tone('turn');
}
async function copyInvite(){const code=room.code;try{await navigator.clipboard.writeText(code);notify('Código de sala copiado. Compártelo con tus amigos.');}catch{openModal(`${modalHead('Invita a tus cómplices')}<p class="modal-copy">Comparte este código de sala con tus amigos.</p><label class="field">Código de la sala<input value="${esc(code)}" readonly id="invite-code"/></label>`);document.querySelector('#invite-code').select();}}
function askLeave(){if(!room)return;openModal(`${modalHead('¿Salimos del laboratorio?')}<p class="modal-copy">${room.practice?'La partida de práctica se cerrará.':room.status==='lobby'?'Dejarás libre tu asiento. Los demás pueden seguir reuniéndose.':room.status==='finished'?'La partida terminó. Puedes volver al inicio y crear otra sala.':'Tienes cinco minutos para regresar desde «Reanudar sala» en este navegador. Si no vuelves, quedarás eliminado y tus cartas se devolverán al mazo. Si queda un solo jugador, ganará por abandono.'}</p><div class="modal-actions"><button class="secondary" data-do="close-modal">Seguir aquí</button><button class="primary" data-do="confirm-leave">Salir de la sala ${icon('exit')}</button></div>`);}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-do]');if(!b||b.disabled)return;const cmd=b.dataset.do;
  if(cmd==='close-modal'){closeModal();return;}
  if(cmd==='sound'){sound=!sound;localStorage.setItem('virus:sound',String(sound));renderHeader();if(sound)tone();return;}
  if(cmd==='rules'||cmd.startsWith('rules-')){showRules(cmd==='rules'?'basic':cmd.slice(6));return;}
  if(cmd==='catalog'){showCatalog();return;}
  if(cmd==='home'){if(room)askLeave();else{formMode='create';renderLanding();}return;}
  if(cmd==='tab-create'||cmd==='tab-join'){const name=document.querySelector('#player-name')?.value;if(name)localStorage.setItem('virus:name',name);formMode=cmd.slice(4);renderLanding();return;}
  if(cmd==='practice'){const input=document.querySelector('#player-name');if(!input.value.trim()){input.focus();notify('Escribe tu nombre para entrar al laboratorio.',true);return;}localStorage.setItem('virus:name',input.value.trim());request('practice',{name:input.value.trim(),roomName:'Práctica del laboratorio',maxPlayers:roomCapacity});return;}
  if(cmd==='resume'){if(recent.length){session=recent[0];store();send({type:'resume',...session});}return;}
  if(cmd==='invite'){if(!room.practice)copyInvite();else notify('La práctica es privada. Crea una sala para jugar con amigos.');return;}
  if(cmd==='takeover'){request('takeover');return;}
  if(cmd==='rematch-yes'||cmd==='rematch-no'){request('rematchVote',{accept:cmd==='rematch-yes',rematchId:room.rematch.id});return;}
  if(cmd==='change-access'){access=null;accessToken='';localStorage.removeItem('virus:access');renderLanding();return;}
  if(cmd==='start'||cmd==='rematch'){request(cmd);return;}
  if(cmd==='leave'){askLeave();return;}
  if(cmd==='confirm-leave'){if(room.status==='lobby'||room.practice)recent=recent.filter(s=>s.code!==room.code);request('leave');return;}
  if(cmd==='winner'){showWinner();return;}
  if(cmd==='cancel'){resetSelection();renderGame();return;}
  if(cmd==='discard'){if(!isTurn())return;armed=false;firstTransplant=null;discarding=true;discards=new Set(selectedCard()?[selected]:[]);renderGame();return;}
  if(cmd==='confirm-discard'){if(isTurn()&&discards.size){request('action',{action:{type:'discard',cardIds:[...discards]}});tone('play');renderGame();}return;}
  if(cmd==='card'){
    if(busy)return;
    if(discarding){if(!isTurn())return;discards.has(b.dataset.card)?discards.delete(b.dataset.card):discards.add(b.dataset.card);selected=discards.has(b.dataset.card)?b.dataset.card:discards.values().next().value||null;renderGame();tone();return;}
    if(selected===b.dataset.card){playSelected();return;}
    selected=b.dataset.card;armed=false;firstTransplant=null;renderGame();tone();return;
  }
  if(cmd==='play'){playSelected();return;}
  if(cmd==='organ'){selectOrgan(b.dataset.player,b.dataset.organ);return;}
  if(cmd==='choice'){const a=actions().find(a=>a.key===b.dataset.key);if(a)perform(a);return;}
});
document.addEventListener('change',e=>{if(e.target.id==='room-capacity')roomCapacity=Number(e.target.value);});
document.addEventListener('submit',async e=>{
  e.preventDefault();
  if(e.target.id==='access-form'){
    const button=e.target.querySelector('button');button.disabled=true;
    try{const r=await fetch('/api/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:new FormData(e.target).get('accessCode')})});const value=await r.json();if(!r.ok)throw new Error(value.error);accessToken=value.token;access=value.access;localStorage.setItem('virus:access',accessToken);if(access.kind==='room')formMode='join';renderLanding();}
    catch(err){document.querySelector('#access-error').textContent=err.message;button.disabled=false;}return;
  }
  if(e.target.id==='room-form'){
    const data=new FormData(e.target);const name=data.get('name').trim();if(!name)return;
    localStorage.setItem('virus:name',name);const button=document.querySelector('#submit-room');button.disabled=true;busy=false;
    request(formMode,{name,roomName:data.get('roomName'),code:data.get('code'),...(formMode==='create'?{maxPlayers:Number(data.get('maxPlayers'))}:{})});if(!busy)button.disabled=false;
  }
  if(e.target.id==='contagion-form'){
    const moves=[...new FormData(e.target)].filter(([_,v])=>v).map(([sourceOrganId,v])=>{const [targetPlayerId,targetOrganId]=v.split(':');return{sourceOrganId,targetPlayerId,targetOrganId};});
    if(moves.length!==contagionAction.moves.length||new Set(moves.map(m=>m.targetOrganId)).size!==moves.length){notify(`Elige ${contagionAction.moves.length} destinos distintos.`,true);return;}
    perform(contagionAction,moves);
  }
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!modal.open&&room?.game){resetSelection();renderGame();}if(e.key==='Enter'&&e.target===document.body&&selected)playSelected();});
modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}});
render();connect();refreshAccess();
