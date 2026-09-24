/* DaxART Contour Plotter worker - CPU-heavy geometry off main thread */
'use strict';

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type !== 'generate') return;
  try {
    const {w,h,buffer,spacing,simplifyM,minPathM,groundMpp,indexEvery} = m;
    const elev = new Float32Array(buffer);
    postMessage({type:'progress',message:'Calcolo isolinee…'});
    const groups = generateSegments(w,h,elev,Math.max(1,spacing));
    postMessage({type:'progress',message:'Collego e semplifico le curve…'});
    const paths = processGroups(groups, groundMpp, Math.max(0,simplifyM), Math.max(0,minPathM), Math.max(1,indexEvery), Math.max(1,spacing));
    let vertices=0, drawM=0;
    for (const p of paths){vertices += p.points.length; drawM += p.lenM;}
    postMessage({type:'done',paths,vertices,drawM});
  } catch (err) {
    postMessage({type:'error',message:err && err.message ? err.message : String(err)});
  }
};

function interp(ax,ay,bx,by,va,vb,level){
  const den=vb-va, t=Math.abs(den)<1e-9 ? .5 : (level-va)/den;
  return {x:ax+(bx-ax)*t,y:ay+(by-ay)*t};
}

function generateSegments(W,H,E,spacing){
  const groups=new Map();
  const add=(lev,a,b)=>{let g=groups.get(lev);if(!g){g=[];groups.set(lev,g)}g.push([a,b])};
  for(let y=0;y<H-1;y++){
    if(y%100===0) postMessage({type:'progress',message:'Calcolo isolinee… '+Math.round(y/(H-1)*100)+'%'});
    for(let x=0;x<W-1;x++){
      const i=y*W+x, tl=E[i], tr=E[i+1], bl=E[i+W], br=E[i+W+1];
      if(!Number.isFinite(tl)||!Number.isFinite(tr)||!Number.isFinite(bl)||!Number.isFinite(br)) continue;
      const mn=Math.min(tl,tr,bl,br), mx=Math.max(tl,tr,bl,br);
      for(let lev=Math.ceil(mn/spacing)*spacing;lev<=mx;lev+=spacing){
        const ints=[];
        if((tl<lev)!=(tr<lev)) ints.push(interp(x,y,x+1,y,tl,tr,lev));
        if((tr<lev)!=(br<lev)) ints.push(interp(x+1,y,x+1,y+1,tr,br,lev));
        if((br<lev)!=(bl<lev)) ints.push(interp(x+1,y+1,x,y+1,br,bl,lev));
        if((bl<lev)!=(tl<lev)) ints.push(interp(x,y+1,x,y,bl,tl,lev));
        if(ints.length===2) add(lev,ints[0],ints[1]);
        else if(ints.length===4){
          const mid=(tl+tr+bl+br)/4;
          if(mid>=lev){add(lev,ints[0],ints[3]);add(lev,ints[1],ints[2]);}
          else {add(lev,ints[0],ints[1]);add(lev,ints[2],ints[3]);}
        }
      }
    }
  }
  return groups;
}

const pkey=p=>Math.round(p.x*10000)+','+Math.round(p.y*10000);

function stitchLinear(segs){
  const by=new Map();
  for(let i=0;i<segs.length;i++){
    for(const p of segs[i]){
      const k=pkey(p); let a=by.get(k); if(!a){a=[];by.set(k,a)} a.push(i);
    }
  }
  const used=new Uint8Array(segs.length);
  const lines=[];
  const nextAt=(p)=>{
    const list=by.get(pkey(p)); if(!list) return -1;
    for(const idx of list) if(!used[idx]) return idx;
    return -1;
  };
  const extend=(line,front)=>{
    while(true){
      const p=front?line[0]:line[line.length-1], idx=nextAt(p);
      if(idx<0) break;
      used[idx]=1;
      const s=segs[idx];
      const d0=Math.hypot(s[0].x-p.x,s[0].y-p.y), d1=Math.hypot(s[1].x-p.x,s[1].y-p.y);
      const q=d0<=d1?s[1]:s[0];
      if(front) line.unshift(q); else line.push(q);
    }
  };

  // Start open chains at degree-1 endpoints.
  for(let i=0;i<segs.length;i++){
    if(used[i]) continue;
    const s=segs[i], d0=(by.get(pkey(s[0]))||[]).length, d1=(by.get(pkey(s[1]))||[]).length;
    if(d0===1||d1===1){
      used[i]=1;
      const line=d0===1?[s[0],s[1]]:[s[1],s[0]];
      extend(line,false); extend(line,true); lines.push(line);
    }
  }
  // Remaining segments are loops/branches. Linear scan: no repeated O(n) seed search.
  for(let i=0;i<segs.length;i++){
    if(used[i]) continue;
    used[i]=1;
    const line=[segs[i][0],segs[i][1]];
    extend(line,false); extend(line,true); lines.push(line);
  }
  return lines;
}

function rdp(pts,eps){
  if(pts.length<3||eps<=0)return pts;
  const sq=eps*eps;
  function d2(p,a,b){
    let x=a.x,y=a.y,dx=b.x-x,dy=b.y-y;
    if(dx||dy){
      const t=((p.x-x)*dx+(p.y-y)*dy)/(dx*dx+dy*dy);
      if(t>1){x=b.x;y=b.y}else if(t>0){x+=dx*t;y+=dy*t}
    }
    dx=p.x-x;dy=p.y-y;return dx*dx+dy*dy;
  }
  const keep=new Uint8Array(pts.length); keep[0]=keep[pts.length-1]=1;
  const stack=[[0,pts.length-1]];
  while(stack.length){
    const [a,b]=stack.pop(); let md=sq,idx=-1;
    for(let i=a+1;i<b;i++){const d=d2(pts[i],pts[a],pts[b]);if(d>md){md=d;idx=i}}
    if(idx>=0){keep[idx]=1;stack.push([a,idx],[idx,b]);}
  }
  const out=[];for(let i=0;i<pts.length;i++)if(keep[i])out.push(pts[i]);return out;
}

function plen(p){let s=0;for(let i=1;i<p.length;i++)s+=Math.hypot(p[i].x-p[i-1].x,p[i].y-p[i-1].y);return s}

function processGroups(groups,groundMpp,simplifyM,minPathM,indexEvery,spacing){
  const eps=simplifyM/groundMpp, minPx=minPathM/groundMpp, paths=[];
  let gi=0;
  for(const [lev,segs] of groups){
    if((gi++%10)===0) postMessage({type:'progress',message:'Collego quote… '+gi+'/'+groups.size});
    for(let line of stitchLinear(segs)){
      if(eps>0) line=rdp(line,eps);
      const lp=plen(line);
      if(line.length<2||lp<minPx) continue;
      paths.push({lev,index:Math.abs(Math.round(lev/spacing))%indexEvery===0,points:line,lenM:lp*groundMpp});
    }
  }
  return paths;
}
