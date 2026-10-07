import * as THREE from '/vendor/three.module.js';
const canvas=document.querySelector('#scene');
let renderer;
try { renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'}); } catch { canvas.remove(); }
if (renderer) {
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,.1,100);
  camera.position.set(0,0,14);
  const group=new THREE.Group(); scene.add(group);
  const ringMaterial=new THREE.MeshBasicMaterial({color:0xa2d55e,transparent:true,opacity:.08,side:THREE.DoubleSide});
  group.rotation.x=.65;
  for(const radius of [3.3,3.38,4.8]) { const ring=new THREE.Mesh(new THREE.RingGeometry(radius,radius+.015,120),ringMaterial); ring.scale.y=.85;group.add(ring); }
  const particles=[];
  // Everything is planar: rings and tiny laboratory symbols, without polygonal props.
  for(let i=0;i<35;i++) { const cross=new THREE.Group(),mat=new THREE.MeshBasicMaterial({color:0xbedcab,transparent:true,opacity:.055});for(const [w,h] of [[.16,.025],[.025,.16]])cross.add(new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat));cross.position.set((Math.random()-.5)*18,(Math.random()-.5)*11,-1);scene.add(cross);particles.push({cross,speed:.025+Math.random()*.025}); }
  function resize(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();}resize();addEventListener('resize',resize);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const clock=new THREE.Clock(); let last=0;
  function frame(){requestAnimationFrame(frame);if(document.hidden)return;const t=clock.getElapsedTime();if(t-last<1/30)return;last=t;group.visible=!document.querySelector('.table');if(!reduced.matches){for(const p of particles)p.cross.rotation.z=t*p.speed;group.rotation.z=Math.sin(t*.12)*.012;}renderer.render(scene,camera);}frame();
}
