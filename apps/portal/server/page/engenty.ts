/**
 * The flat engenty as the open repository draws it (`apps/web/src/engenty/engenty.tsx`): an
 * idle SMIL morph, a blink, and pupils and body that follow the pointer (`gaze.js` below, the
 * runtime's `use-engenty-gaze.ts` without React). Kept here as strings: the page is server-made
 * HTML, and the figures are the one thing on it that moves.
 */

interface Kind {
  fill: string;
  ink: string;
  ex: number;
  ey: number;
  max: number;
  r: number;
  blink: string;
  dur: string;
  shadowY: number;
  shadowR: number;
  morph: string;
  extra?: string;
}

const KINDS: Record<string, Kind> = {
  round: {
    fill: "oklch(60% 0.23 262)",
    ink: "oklch(18% 0.08 260)",
    ex: 68,
    ey: 58,
    max: 3.4,
    r: 8,
    blink: "5.2s",
    dur: "3.6s",
    shadowY: 108,
    shadowR: 26,
    morph:
      "M60 22 C65.2 22 71.2 24 75.8 26 C80.2 28 84 30.7 87 34 C90 37.3 92.2 41.3 93.8 46 C95.2 50.7 96 56.8 96 62 C96 67.2 95.2 72.7 93.8 77.1 C92.2 81.5 90 85.3 87 88.5 C84 91.7 80.2 94.2 75.8 96.1 C71.2 98 65.2 100 60 100 C54.8 100 48.8 98 44.2 96.1 C39.8 94.2 36 91.7 33 88.5 C30 85.3 27.8 81.5 26.2 77.1 C24.8 72.7 24 67.2 24 62 C24 56.8 24.8 50.7 26.2 46 C27.8 41.3 30 37.3 33 34 C36 30.7 39.8 28 44.2 26 C48.8 24 54.8 22 60 22 Z;M60 30 C65.7 29.9 72.4 27.8 77.1 28.2 C81.9 28.8 85.7 30.3 88.5 33 C91.3 35.7 93.2 39.4 94.1 44.2 C95 49.1 94.1 56.2 94 62 C93.9 67.8 94.5 74.4 93.4 79.1 C92.3 83.8 90.3 87.5 87.5 90.2 C84.7 93 81 94.8 76.4 95.6 C71.8 96.4 65.5 95 60 95 C54.5 95 48.2 96.4 43.6 95.6 C39 94.8 35.3 93 32.5 90.2 C29.7 87.5 27.7 83.8 26.6 79.1 C25.5 74.4 26.1 67.7 26 62 C25.9 56.3 25 49.7 25.9 45 C26.8 40.3 28.7 36.7 31.5 34 C34.3 31.3 38.1 29.7 42.9 29 C47.6 28.3 54.3 30.1 60 30 Z;M60 22 C65.2 22 71.2 24 75.8 26 C80.2 28 84 30.7 87 34 C90 37.3 92.2 41.3 93.8 46 C95.2 50.7 96 56.8 96 62 C96 67.2 95.2 72.7 93.8 77.1 C92.2 81.5 90 85.3 87 88.5 C84 91.7 80.2 94.2 75.8 96.1 C71.2 98 65.2 100 60 100 C54.8 100 48.8 98 44.2 96.1 C39.8 94.2 36 91.7 33 88.5 C30 85.3 27.8 81.5 26.2 77.1 C24.8 72.7 24 67.2 24 62 C24 56.8 24.8 50.7 26.2 46 C27.8 41.3 30 37.3 33 34 C36 30.7 39.8 28 44.2 26 C48.8 24 54.8 22 60 22 Z",
    extra:
      '<circle cx="97" cy="34" fill="FILL" opacity="0.5" r="6"><animate attributeName="cy" dur="3.6s" repeatCount="indefinite" values="34;28;34"/></circle><circle cx="106" cy="24" fill="FILL" opacity="0.35" r="3.5"><animate attributeName="cy" begin="0.4s" dur="3.6s" repeatCount="indefinite" values="24;17;24"/></circle>',
  },
  drop: {
    fill: "oklch(82% 0.17 78)",
    ink: "oklch(30% 0.10 60)",
    ex: 60,
    ey: 56,
    max: 3.2,
    r: 8,
    blink: "4.4s",
    dur: "4.4s",
    shadowY: 106,
    shadowR: 24,
    morph:
      "M46.9 25.9 Q60 13.3 73.1 25.9 Q90 42 90 66 Q90 96 60 98 Q30 96 30 66 Q30 42 46.9 25.9 Z;M39.9 28.9 Q50.1 16.8 68.1 26.6 Q91 39 88 66 Q92 98 60 96 Q28 98 32 66 Q27.5 43.5 39.9 28.9 Z;M52.6 26.6 Q69.9 17 80.3 28.9 Q93 43.5 90 66 Q88 98 60 96 Q32 98 32 66 Q30.5 39 52.6 26.6 Z;M46.9 25.9 Q60 13.3 73.1 25.9 Q90 42 90 66 Q90 96 60 98 Q30 96 30 66 Q30 42 46.9 25.9 Z",
    extra:
      '<path d="M49 75 C54 78 64 78.5 71 71.4" fill="none" stroke="oklch(30% 0.10 55)" stroke-linecap="round" stroke-width="2.6"/>',
  },
  dome: {
    fill: "oklch(72% 0.22 145)",
    ink: "oklch(16% 0.08 160)",
    ex: 60,
    ey: 54,
    max: 3.4,
    r: 8.5,
    blink: "4.6s",
    dur: "3s",
    shadowY: 104,
    shadowR: 27,
    morph:
      "M60 20 Q92 30 92 70 Q92 96 60 96 Q28 96 28 70 Q28 30 60 20 Z;M60 30 Q98 36 96 74 Q96 98 60 98 Q24 98 24 74 Q22 36 60 30 Z;M60 12 Q88 26 88 68 Q88 94 60 94 Q32 94 32 68 Q32 26 60 12 Z;M60 20 Q92 30 92 70 Q92 96 60 96 Q28 96 28 70 Q28 30 60 20 Z",
    extra:
      '<path d="M46 90 L46 80 M60 92 L60 82 M74 90 L74 80" opacity="0.5" stroke="oklch(28% 0.10 155)" stroke-linecap="round" stroke-width="2.4"/><circle cx="60" cy="6" fill="FILL" r="3"><animate attributeName="cy" dur="3s" repeatCount="indefinite" values="8;3;8"/></circle>',
  },
  flame: {
    fill: "oklch(64% 0.25 18)",
    ink: "oklch(22% 0.10 18)",
    ex: 60,
    ey: 62,
    max: 3.2,
    r: 8,
    blink: "3.8s",
    dur: "2.6s",
    shadowY: 106,
    shadowR: 22,
    morph:
      "M60 14 Q84 44 80 76 Q78 98 60 98 Q42 98 40 76 Q36 44 60 14 Z;M52 18 Q86 40 82 76 Q80 98 60 98 Q40 98 38 76 Q32 46 52 18 Z;M68 18 Q88 46 82 76 Q80 98 60 98 Q40 98 38 76 Q34 40 68 18 Z;M60 14 Q84 44 80 76 Q78 98 60 98 Q42 98 40 76 Q36 44 60 14 Z",
    extra:
      '<path d="M40 20 Q60 6 80 20" fill="none" opacity="0.55" stroke="FILL" stroke-linecap="round" stroke-width="3"><animate attributeName="opacity" dur="2.6s" repeatCount="indefinite" values="0.55;0.15;0.55"/></path><circle cx="60" cy="82" fill="oklch(22% 0.10 18)" r="2.6"/>',
  },
  oval: {
    fill: "oklch(70% 0.21 42)",
    ink: "oklch(24% 0.10 30)",
    ex: 66,
    ey: 58,
    max: 3.2,
    r: 8,
    blink: "4.2s",
    dur: "4s",
    shadowY: 102,
    shadowR: 32,
    morph:
      "M60 34 Q100 38 100 64 Q100 92 60 94 Q20 92 20 64 Q20 38 60 34 Z;M60 40 Q110 40 108 66 Q108 96 60 96 Q12 96 12 66 Q10 40 60 40 Z;M60 28 Q92 36 92 62 Q92 88 60 90 Q28 88 28 62 Q28 36 60 28 Z;M60 34 Q100 38 100 64 Q100 92 60 94 Q20 92 20 64 Q20 38 60 34 Z",
    extra:
      '<g fill="none" opacity="0.45" stroke="oklch(40% 0.16 30)" stroke-width="2.2"><path d="M28 54 Q60 48 92 54"><animate attributeName="d" dur="4s" repeatCount="indefinite" values="M28 54 Q60 48 92 54;M20 56 Q60 50 100 56;M32 52 Q60 46 88 52;M28 54 Q60 48 92 54"/></path><path d="M26 70 Q60 64 94 70"><animate attributeName="d" dur="4s" repeatCount="indefinite" values="M26 70 Q60 64 94 70;M18 72 Q60 66 102 72;M30 68 Q60 62 90 68;M26 70 Q60 64 94 70"/></path></g>',
  },
  bean: {
    fill: "oklch(74% 0.16 192)",
    ink: "oklch(18% 0.08 200)",
    ex: 70,
    ey: 58,
    max: 3.4,
    r: 8,
    blink: "4.8s",
    dur: "3.8s",
    shadowY: 102,
    shadowR: 26,
    morph:
      "M48 96 Q24 92 26 68 Q28 44 52 38 Q78 32 88 50 Q98 66 84 84 Q70 100 48 96 Z;M46 98 Q20 92 24 66 Q28 40 54 36 Q80 30 90 50 Q100 68 84 86 Q68 102 46 98 Z;M50 94 Q28 90 28 68 Q30 46 52 40 Q76 34 86 50 Q94 64 82 82 Q72 98 50 94 Z;M48 96 Q24 92 26 68 Q28 44 52 38 Q78 32 88 50 Q98 66 84 84 Q70 100 48 96 Z",
    extra:
      '<circle cx="32" cy="94" fill="FILL" opacity="0.4" r="4"><animate attributeName="cx" dur="3.8s" repeatCount="indefinite" values="32;27;32"/></circle>',
  },
  pebble: {
    fill: "oklch(66% 0.13 235)",
    ink: "oklch(20% 0.06 244)",
    ex: 68,
    ey: 72,
    max: 3,
    r: 7.5,
    blink: "5.6s",
    dur: "4.6s",
    shadowY: 102,
    shadowR: 34,
    morph:
      "M60 96 Q20 96 18 78 Q16 60 46 56 Q78 52 98 62 Q110 72 104 86 Q98 96 60 96 Z;M60 98 Q14 98 14 78 Q14 58 46 54 Q80 50 102 62 Q114 74 106 88 Q98 98 60 98 Z;M60 94 Q26 94 22 78 Q20 62 46 58 Q76 54 94 62 Q106 70 100 84 Q94 94 60 94 Z;M60 96 Q20 96 18 78 Q16 60 46 56 Q78 52 98 62 Q110 72 104 86 Q98 96 60 96 Z",
    extra:
      '<g fill="oklch(30% 0.05 244)" opacity="0.32"><circle cx="42" cy="76" r="3"/><circle cx="56" cy="86" r="2.2"/><circle cx="86" cy="80" r="2.6"/></g>',
  },
  sprout: {
    fill: "oklch(89% 0.2 118)",
    ink: "oklch(24% 0.09 108)",
    ex: 60,
    ey: 68,
    max: 3.4,
    r: 8.5,
    blink: "4.2s",
    dur: "3.2s",
    shadowY: 106,
    shadowR: 26,
    morph:
      "M60 100 Q28 98 28 72 Q28 46 60 44 Q92 46 92 72 Q92 98 60 100 Z;M60 102 Q24 100 24 72 Q24 42 60 40 Q96 42 96 72 Q96 100 60 102 Z;M60 98 Q32 96 32 72 Q32 50 60 48 Q88 50 88 72 Q88 96 60 98 Z;M60 100 Q28 98 28 72 Q28 46 60 44 Q92 46 92 72 Q92 98 60 100 Z",
    extra:
      '<g fill="FILL"><ellipse cx="48" cy="34" rx="6" ry="10"><animate attributeName="cy" dur="3.2s" repeatCount="indefinite" values="34;30;34"/></ellipse><ellipse cx="72" cy="32" rx="5.5" ry="9"><animate attributeName="cy" begin="0.5s" dur="3.2s" repeatCount="indefinite" values="32;28;32"/></ellipse></g>',
  },
  tower: {
    fill: "oklch(60% 0.25 300)",
    ink: "oklch(20% 0.09 308)",
    ex: 60,
    ey: 52,
    max: 3.2,
    r: 8,
    blink: "5s",
    dur: "4s",
    shadowY: 108,
    shadowR: 20,
    morph:
      "M60 102 Q36 100 38 78 Q40 58 42 44 Q44 26 60 24 Q76 26 78 44 Q80 58 82 78 Q84 100 60 102 Z;M60 104 Q32 102 36 78 Q40 56 40 42 Q40 22 60 20 Q80 22 80 42 Q80 56 84 78 Q88 102 60 104 Z;M60 100 Q40 98 40 78 Q42 60 44 46 Q46 30 60 28 Q74 30 76 46 Q78 60 80 78 Q80 98 60 100 Z;M60 102 Q36 100 38 78 Q40 58 42 44 Q44 26 60 24 Q76 26 78 44 Q80 58 82 78 Q84 100 60 102 Z",
    extra:
      '<g fill="none" opacity="0.4" stroke="oklch(28% 0.10 308)" stroke-linecap="round" stroke-width="2.2"><path d="M42 74 Q60 70 78 74"/><path d="M40 88 Q60 84 80 88"/></g>',
  },
  wedge: {
    fill: "oklch(65% 0.28 345)",
    ink: "oklch(22% 0.10 345)",
    ex: 60,
    ey: 70,
    max: 3.2,
    r: 8,
    blink: "3.6s",
    dur: "2.9s",
    shadowY: 106,
    shadowR: 28,
    morph:
      "M60 30 Q74 40 86 70 Q96 92 78 98 Q60 102 42 98 Q24 92 34 70 Q46 40 60 30 Z;M60 24 Q78 38 90 70 Q100 94 78 100 Q60 104 42 100 Q20 94 30 70 Q42 38 60 24 Z;M60 34 Q72 44 82 70 Q92 90 76 96 Q60 100 44 96 Q28 90 38 70 Q48 44 60 34 Z;M60 30 Q74 40 86 70 Q96 92 78 98 Q60 102 42 98 Q24 92 34 70 Q46 40 60 30 Z",
    extra:
      '<path d="M52 22 Q60 14 68 22" fill="none" opacity="0.5" stroke="FILL" stroke-linecap="round" stroke-width="3"><animate attributeName="opacity" dur="2.9s" repeatCount="indefinite" values="0.5;0.12;0.5"/></path>',
  },
};

export const kindOf = (avatar: string) => (avatar in KINDS ? avatar : "round");

/** The figure as inline SVG; `gaze.js` finds it by `data-engenty` and moves its eye and body. */
export function engentySvg(avatar: string, size: number): string {
  const kind = kindOf(avatar);
  const k = KINDS[kind];
  const ry = k.r * 1.15;
  const d = k.morph.split(";")[0];
  // The leaves of the sprout stand behind its body; everything else in front.
  const behind = kind === "sprout" ? (k.extra ?? "") : "";
  const front = kind === "sprout" ? "" : (k.extra ?? "");
  return (
    `<svg data-engenty="${kind}" data-ex="${k.ex}" data-ey="${k.ey}" data-max="${k.max}" data-r="${k.r}" viewBox="0 0 120 120" width="${size}" height="${size}" overflow="visible" aria-hidden="true" style="display:block">` +
    `<ellipse class="e-shadow" cx="60" cy="${k.shadowY}" rx="${k.shadowR}" ry="4.5" fill="#000" opacity="0.14"><animate attributeName="rx" dur="${k.dur}" repeatCount="indefinite" values="${k.shadowR};${k.shadowR * 0.8};${k.shadowR}"/></ellipse>` +
    `<g class="e-lean">${behind.replaceAll("FILL", k.fill)}` +
    `<path fill="${k.fill}" d="${d}"><animate attributeName="d" dur="${k.dur}" repeatCount="indefinite" values="${k.morph}"/></path>` +
    `${front.replaceAll("FILL", k.fill)}` +
    `<ellipse cx="${k.ex}" cy="${k.ey}" fill="#fff" rx="${k.r}" ry="${ry}"><animate attributeName="ry" dur="${k.blink}" keyTimes="0;0.92;0.95;1" repeatCount="indefinite" values="${ry};${ry};${k.r * 0.1};${ry}"/></ellipse>` +
    `<circle class="e-pupil" cx="${k.ex}" cy="${k.ey + 1}" fill="${k.ink}" r="${k.r * 0.48}"/>` +
    `<circle class="e-glint" cx="${k.ex - k.r * 0.25}" cy="${k.ey - k.r * 0.3}" fill="#fff" r="${k.r * 0.18}"/>` +
    "</g></svg>"
  );
}

/** Pupils and body follow the pointer; nothing moves where the person asked for less motion. */
export const GAZE_JS = `(function(){
if(!window.matchMedia||window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;
var cast=[];document.querySelectorAll("svg[data-engenty]").forEach(function(svg){
cast.push({svg:svg,lean:svg.querySelector(".e-lean"),shadow:svg.querySelector(".e-shadow"),pupil:svg.querySelector(".e-pupil"),glint:svg.querySelector(".e-glint"),ex:+svg.dataset.ex,ey:+svg.dataset.ey,max:+svg.dataset.max,r:+svg.dataset.r,tx:0,ty:0,rot:0,px:+svg.dataset.ex,py:+svg.dataset.ey+1});});
if(!cast.length)return;
var p={x:innerWidth*0.62,y:innerHeight*0.28},raf=0,settle=48;
function lerp(a,b,t){return a+(b-a)*t}
function tick(){raf=0;var moving=false,vh=innerHeight;
for(var i=0;i<cast.length;i++){var e=cast[i],rect=e.svg.getBoundingClientRect();if(rect.bottom<-40||rect.top>vh+40)continue;
var cx=rect.left+rect.width*0.5,cy=rect.top+rect.height*0.48,dx=p.x-cx,dy=p.y-cy,dist=Math.hypot(dx,dy)||1,nx=dx/dist,ny=dy/dist;
var reach=Math.min(rect.width,rect.height)*2.4,look=0.35+Math.min(1,dist/reach)*0.65;
var ttx=nx*5.5*look,tty=ny*3.5*look,trot=nx*7*look+ny*1.2*look;
e.tx=lerp(e.tx,ttx,0.16);e.ty=lerp(e.ty,tty,0.16);e.rot=lerp(e.rot,trot,0.14);
if(e.lean)e.lean.setAttribute("transform","translate("+e.tx.toFixed(2)+" "+e.ty.toFixed(2)+") rotate("+e.rot.toFixed(2)+" 60 62)");
if(e.shadow)e.shadow.setAttribute("cx",(60-e.tx*0.35).toFixed(2));
var tpx=e.ex+nx*e.max*look,tpy=e.ey+1+ny*e.max*0.9*look;
e.px=lerp(e.px,tpx,0.24);e.py=lerp(e.py,tpy,0.24);
if(e.pupil){e.pupil.setAttribute("cx",e.px.toFixed(2));e.pupil.setAttribute("cy",e.py.toFixed(2));}
if(e.glint){e.glint.setAttribute("cx",(e.px-e.r*0.25).toFixed(2));e.glint.setAttribute("cy",(e.py-1-e.r*0.3).toFixed(2));}
if(Math.abs(e.tx-ttx)>0.05||Math.abs(e.px-tpx)>0.05)moving=true;}
if(moving||settle-->0)raf=requestAnimationFrame(tick);}
addEventListener("pointermove",function(ev){p.x=ev.clientX;p.y=ev.clientY;settle=48;if(!raf)raf=requestAnimationFrame(tick);},{passive:true});
raf=requestAnimationFrame(tick);})();`;
