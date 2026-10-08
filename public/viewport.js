// Fit the existing composition to the available CSS viewport, not device pixels.
let observer,currentFit;
export function fitGameViewport(){
  observer?.disconnect();
  currentFit=null;
  const viewport=document.querySelector('.game-viewport');
  document.body.classList.toggle('in-game',!!viewport);
  if(!viewport)return;
  function fit(){
    if(!viewport.isConnected)return;
    const table=viewport.querySelector('.table');
    // Read the original responsive layout before applying the uniform scale.
    // Resetting it also avoids accumulating scale across rerenders or resizes.
    viewport.removeAttribute('data-fitted');
    const height=viewport.clientHeight,width=viewport.clientWidth;
    const naturalHeight=table.offsetHeight;
    if(!height||!width||!naturalHeight)return;
    const scale=Math.min(1,height/naturalHeight);
    viewport.style.setProperty('--board-scale',String(scale));
    viewport.style.setProperty('--board-height',`${naturalHeight}px`);
    viewport.style.setProperty('--board-width',`${width/scale}px`);
    viewport.setAttribute('data-fitted','');
  }
  currentFit=fit;fit();
  observer=new ResizeObserver(fit);
  observer.observe(viewport);
}
addEventListener('resize',()=>currentFit?.());
window.visualViewport?.addEventListener('resize',()=>currentFit?.());
