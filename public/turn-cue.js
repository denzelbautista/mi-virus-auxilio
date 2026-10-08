// Presentation only: the server remains the sole authority for turn order.
const NS='http://www.w3.org/2000/svg';
let cue=null;
const tagFor=id=>[...document.querySelectorAll('[data-player-tag]')].find(el=>el.dataset.playerTag===id);
const center=el=>{const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};};
export function turnCueSource(room){const tag=tagFor(room?.game?.turnPlayerId);return tag?center(tag.querySelector('.avatar')||tag):null;}
function clearCue(){
  if(!cue)return;
  clearTimeout(cue.timer);cancelAnimationFrame(cue.frame);cue.overlay?.remove();
  document.querySelectorAll('.turn-arrival').forEach(el=>{el.classList.remove('turn-arrival');el.style.removeProperty('--turn-elapsed');});
  cue=null;
}
export function refreshTurnCue(room){
  if(!cue)return;
  if(room?.code!==cue.code||room?.status!=='playing'||room.game.turnPlayerId!==cue.playerId){clearCue();return;}
  if(!cue.highlightAt)return;
  const tag=tagFor(cue.playerId);
  if(tag&&!tag.classList.contains('turn-arrival')){
    tag.style.setProperty('--turn-elapsed',`${-(performance.now()-cue.highlightAt)}ms`);
    tag.classList.add('turn-arrival');
  }
}
function highlight(current,room){
  if(cue!==current)return;
  current.overlay?.remove();current.highlightAt=performance.now();
  refreshTurnCue(room);current.timer=setTimeout(clearCue,2000);
}
function svgElement(name,attrs={}){const el=document.createElementNS(NS,name);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));return el;}
function travel(current,room,from){
  if(cue!==current)return;
  const tag=tagFor(current.playerId),table=document.querySelector('.table');
  if(!tag||!table){clearCue();return;}
  const to=center(tag.querySelector('.avatar')||tag);
  if(!from||matchMedia('(prefers-reduced-motion: reduce)').matches){highlight(current,room);return;}
  const overlay=svgElement('svg',{class:'turn-transfer','aria-hidden':'true',width:innerWidth,height:innerHeight,viewBox:`0 0 ${innerWidth} ${innerHeight}`});
  // Follow the table perimeter from the old seat to the new one. On a mobile
  // grid use a short curved connection instead of looping around other seats.
  const points=[...table.querySelectorAll('[data-player-tag]')].map(el=>center(el.querySelector('.avatar')||el));
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
  const cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
  const rx=Math.max(70,(Math.max(...xs)-Math.min(...xs))/2),ry=Math.max(70,(Math.max(...ys)-Math.min(...ys))/2);
  let d;
  if(table.classList.contains('expanded-table')&&innerWidth<=850){
    const dx=to.x-from.x,dy=to.y-from.y,length=Math.hypot(dx,dy)||1,bend=Math.min(48,length*.2);
    d=`M ${from.x} ${from.y} Q ${(from.x+to.x)/2-dy/length*bend} ${(from.y+to.y)/2+dx/length*bend} ${to.x} ${to.y}`;
  }else{
    const start=Math.atan2((from.y-cy)/ry,(from.x-cx)/rx);
    let end=Math.atan2((to.y-cy)/ry,(to.x-cx)/rx);
    while(end>=start)end-=Math.PI*2;
    const r1=Math.hypot((from.x-cx)/rx,(from.y-cy)/ry),r2=Math.hypot((to.x-cx)/rx,(to.y-cy)/ry);
    d=Array.from({length:65},(_,i)=>{const t=i/64,a=start+(end-start)*t,r=r1+(r2-r1)*t;return `${i?'L':'M'} ${cx+Math.cos(a)*rx*r} ${cy+Math.sin(a)*ry*r}`;}).join(' ');
  }
  const path=svgElement('path',{d,class:'turn-transfer-trail'});
  overlay.append(path);
  const arrows=Array.from({length:3},(_,i)=>{
    const arrow=svgElement('path',{d:'M -8 -7 L 0 0 L -8 7',class:'turn-transfer-arrow',opacity:1-i*.25});overlay.append(arrow);return arrow;
  });
  overlay.style.opacity='0';current.overlay=overlay;document.body.append(overlay);
  const length=path.getTotalLength(),started=performance.now(),duration=780;
  function frame(now){
    if(cue!==current)return;
    const t=Math.min(1,(now-started)/duration),progress=1-(1-t)**2;
    path.style.strokeDasharray=`${length} ${length}`;path.style.strokeDashoffset=String(length*(1-progress));
    arrows.forEach((arrow,i)=>{
      const distance=Math.max(0,Math.min(length,length*progress-i*15)),p=path.getPointAtLength(distance),a=path.getPointAtLength(Math.max(0,distance-2)),b=path.getPointAtLength(Math.min(length,distance+2));
      arrow.setAttribute('transform',`translate(${p.x} ${p.y}) rotate(${Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI})`);
      arrow.style.visibility=length*progress<i*15?'hidden':'visible';
    });
    overlay.style.opacity=String(Math.min(1,t*8,(1-t)*8));
    if(t<1)current.frame=requestAnimationFrame(frame);else highlight(current,room);
  }
  current.frame=requestAnimationFrame(frame);
}
export function updateTurnCue(before,room,from,delay=0){
  refreshTurnCue(room);
  if(before?.code!==room.code||before.status!=='playing'||room.status!=='playing'||before.game?.turnPlayerId===room.game?.turnPlayerId)return;
  clearCue();
  cue={code:room.code,playerId:room.game.turnPlayerId};
  const current=cue;current.timer=setTimeout(()=>travel(current,room,from),delay);
}
// A resize invalidates the old path coordinates. Do not leave floating arrows.
addEventListener('resize',()=>{if(cue&&!cue.highlightAt)clearCue();});
