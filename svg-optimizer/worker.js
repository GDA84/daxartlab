'use strict';

let MODEL = null;
const MM_PER_UNIT = {mm:1, cm:10, in:25.4, pt:25.4/72, pc:25.4/6, px:25.4/96, q:0.25};

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      postMessage({type:'progress', message:'Leggo intestazione SVG…'});
      const text = decodeSvgBuffer(m.buffer);
      MODEL = analyzeSvg(text, m.name || 'input.svg', m.size || m.buffer.byteLength);
      postMessage({type:'loaded', stats:MODEL.stats, page:MODEL.page, preview:MODEL.preview, warnings:MODEL.warnings});
    } else if (m.type === 'optimize') {
      if (!MODEL) throw new Error('Carica prima un SVG.');
      const result = optimizeSvg(MODEL, m.options || {});
      const bytes = new TextEncoder().encode(result.svgText);
      delete result.svgText;
      postMessage({type:'optimized', ...result, svgBuffer:bytes.buffer}, [bytes.buffer]);
    } else if (m.type === 'reset') {
      MODEL = null;
      postMessage({type:'reset'});
    }
  } catch (err) {
    postMessage({type:'error', message: err && err.message ? err.message : String(err)});
  }
};

function decodeSvgBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const n = Math.min(bytes.length, 512);
  let head='';
  for(let i=0;i<n;i++) head += String.fromCharCode(bytes[i]);
  let enc='utf-8';
  if(bytes.length>=2 && bytes[0]===0xFF && bytes[1]===0xFE) enc='utf-16le';
  else if(bytes.length>=2 && bytes[0]===0xFE && bytes[1]===0xFF) enc='utf-16be';
  else {
    const m=head.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
    if(m) enc=m[1].trim().toLowerCase();
  }
  try { return new TextDecoder(enc).decode(bytes); }
  catch (_) { return new TextDecoder('utf-8').decode(bytes); }
}

function analyzeSvg(text, filename, fileBytes) {
  const warnings=[];
  const svgMatch=text.match(/<svg\b([^>]*)>/i);
  if(!svgMatch) throw new Error('Il file non contiene un elemento <svg> valido.');
  const rootAttrs=parseAttrs(svgMatch[1]||'');
  const rootWidthAttr=rootAttrs.width||null;
  const rootHeightAttr=rootAttrs.height||null;
  const rootViewBoxAttr=rootAttrs.viewBox||rootAttrs.viewbox||null;
  const rootPreserveAspectRatio=rootAttrs.preserveAspectRatio||rootAttrs.preserveaspectratio||null;
  const explicitViewBox=parseViewBox(rootViewBoxAttr);
  const widthLen=parseLength(rootWidthAttr), heightLen=parseLength(rootHeightAttr);
  let widthMm=lengthToMm(widthLen), heightMm=lengthToMm(heightLen);

  let vb=explicitViewBox;
  if(!vb){
    let w=lengthToCssPx(widthLen), h=lengthToCssPx(heightLen);
    if(!(w>0)) w=300;
    if(!(h>0)) h=150;
    vb={x:0,y:0,w,h};
    warnings.push('viewBox assente: uso corretto del viewport SVG implicito in CSS px (96 dpi).');
  }
  if(!(widthMm>0)||!(heightMm>0)){
    widthMm=vb.w*25.4/96; heightMm=vb.h*25.4/96;
    warnings.push('Dimensione fisica non esplicita: conversione a 96 dpi.');
  }

  const page={
    viewBox:vb,widthMm,heightMm,
    rootWidthAttr,rootHeightAttr,rootViewBoxAttr,rootPreserveAspectRatio,
    explicitViewBox:Boolean(explicitViewBox)
  };

  postMessage({type:'progress', message:'Analizzo geometria senza caricarla tutta in memoria…'});
  const previewBudget=60000;
  const estimatedPoints=Math.max(1,Math.ceil(fileBytes/18));
  const sampleStride=Math.max(1,Math.ceil(estimatedPoints/previewBudget));
  const previewLines=[];
  const stack=[{tag:'__root__',matrix:identityMatrix(),hidden:false}];
  const tagRe=/<\s*(\/?)\s*([a-zA-Z][\w:.-]*)([^>]*?)(\/?)\s*>/g;
  let match,pathTags=0,polyTags=0,lineTags=0,unsupported=0,transformedTags=0;
  let points=0,drawMm=0,subpaths=0;

  const consume=(sp,matrix)=>{
    if(!sp.points||sp.points.length<2) return;
    const mmPts=new Array(sp.points.length), rootPts=new Array(sp.points.length);
    for(let j=0;j<sp.points.length;j++){
      const rp=applyMatrix(matrix,sp.points[j]); rootPts[j]=rp; mmPts[j]=rootToMm(rp,page);
    }
    points += sp.points.length;
    drawMm += polyLength(mmPts);
    subpaths++;
    if(previewLines.length<16000){
      const arr=[];
      for(let j=0;j<rootPts.length;j+=sampleStride) arr.push([rootPts[j].x,rootPts[j].y]);
      const q=rootPts[rootPts.length-1];
      if(!arr.length || arr[arr.length-1][0]!==q.x || arr[arr.length-1][1]!==q.y) arr.push([q.x,q.y]);
      if(arr.length>=2) previewLines.push(arr);
    }
  };

  while((match=tagRe.exec(text))){
    const closing=!!match[1];
    const rawName=match[2];
    const tag=rawName.includes(':')?rawName.split(':').pop().toLowerCase():rawName.toLowerCase();
    const attrText=match[3]||'';
    const selfClosing=!!match[4]||/\/\s*$/.test(attrText);
    if(closing){
      for(let k=stack.length-1;k>0;k--){const entry=stack[k];stack.pop();if(entry.tag===tag)break;}
      continue;
    }
    const attrs=parseAttrs(attrText), parent=stack[stack.length-1];
    const local=attrs.transform?parseTransform(attrs.transform):identityMatrix();
    const matrix=multiplyMatrix(parent.matrix,local);
    if(attrs.transform) transformedTags++;
    const style=attrs.style||'';
    const hidden=parent.hidden || ['defs','clippath','mask','symbol','pattern','marker'].includes(tag) ||
      String(attrs.display||'').toLowerCase()==='none' || String(attrs.visibility||'').toLowerCase()==='hidden' ||
      /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(style) || /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)/i.test(style);

    if(!hidden && tag==='path' && attrs.d){
      pathTags++;
      if(hasUnsupportedPathCommands(attrs.d)) unsupported++;
      else if(!walkLinearPath(attrs.d,sp=>consume(sp,matrix))) unsupported++;
      if(pathTags%100===0) postMessage({type:'progress',message:'Analizzo path… '+pathTags.toLocaleString('it-IT')});
    } else if(!hidden && (tag==='polyline'||tag==='polygon')){
      polyTags++; const pts=parsePointsAttr(attrs.points); if(pts.length>=2)consume({points:pts,closed:tag==='polygon'},matrix);
    } else if(!hidden && tag==='line'){
      lineTags++; const x1=+attrs.x1,y1=+attrs.y1,x2=+attrs.x2,y2=+attrs.y2;
      if([x1,y1,x2,y2].every(Number.isFinite))consume({points:[{x:x1,y:y1},{x:x2,y:y2}],closed:false},matrix);
    }
    if(!selfClosing && ['svg','g','a','symbol','defs','clippath','mask','pattern','marker'].includes(tag)) stack.push({tag,matrix,hidden});
  }

  if(!subpaths && !unsupported) throw new Error('Non sono state trovate geometrie supportate.');
  if(unsupported) warnings.push(unsupported.toLocaleString('it-IT')+' path con curve/archi saranno mantenuti senza modifica.');
  if(transformedTags) warnings.push(transformedTags.toLocaleString('it-IT')+' trasformazioni SVG rilevate e rispettate.');

  return {
    rawText:text,page,sampleStride,
    stats:{filename,fileBytes,paths:subpaths+unsupported,points,drawMm,penLifts:Math.max(0,subpaths+unsupported-1),unsupported,pathTags,polyTags,lineTags,transformedTags},
    preview:{viewBox:vb,lines:previewLines,totalPoints:points,sampled:sampleStride>1},warnings
  };
}

function optimizeSvg(model,opts){
  const o=normalizeOptions(opts);
  if(o.mode==='lossless'){
    postMessage({type:'progress',message:'Pulizia lossless del documento…'});
    const svgText=conservativeMinify(model.rawText);
    verifyPageIdentity(model.rawText,svgText);
    return {svgText,preview:model.preview,stats:{...model.stats,outputBytes:utf8Length(svgText),travelMm:NaN,reduction:1-utf8Length(svgText)/model.stats.fileBytes,pageOk:true}};
  }
  return optimizeInPlace(model,o);
}

function optimizeInPlace(model,o){
  postMessage({type:'progress',message:'Ottimizzo i path in-place. Canvas e struttura non vengono ricreati…'});
  const text=model.rawText,page=model.page;
  const stack=[{tag:'__root__',matrix:identityMatrix(),hidden:false}];
  const tagRe=/<\s*(\/?)\s*([a-zA-Z][\w:.-]*)([^>]*?)(\/?)\s*>/g;
  let out=[],lastIndex=0,match,processed=0;
  let paths=0,points=0,drawMm=0,travelMm=0,removed=0,unsupported=0;
  let prevEndMm=null;
  const previewLines=[], sampleStride=Math.max(1,model.sampleStride||1);

  const processSubpath=(sp,matrix,inv,rebuilt)=>{
    if(!sp.points||sp.points.length<2)return;
    let work=new Array(sp.points.length);
    for(let j=0;j<sp.points.length;j++){
      const root=applyMatrix(matrix,sp.points[j]);
      const mm=rootToMm(root,page);
      work[j]={x:mm.x,y:mm.y,root};
    }
    work=dedupeConsecutive(work,o.dedupeMm);
    if(o.simplifyMm>0 && work.length>2) work=rdp(work,o.simplifyMm);
    const len=polyLength(work);
    if(work.length<2 || (o.minPathMm>0 && len<o.minPathMm)){removed++;return;}

    const localPts=new Array(work.length), rootPts=new Array(work.length);
    for(let j=0;j<work.length;j++){
      rootPts[j]=work[j].root;
      localPts[j]=applyMatrix(inv,work[j].root);
    }
    rebuilt.push(serializeLinearSubpath(localPts,sp.closed,o.precision));
    if(prevEndMm){const f=work[0];travelMm+=Math.hypot(f.x-prevEndMm.x,f.y-prevEndMm.y);}
    prevEndMm=work[work.length-1];
    paths++;points+=work.length;drawMm+=len;

    if(previewLines.length<16000){
      const arr=[];
      for(let j=0;j<rootPts.length;j+=sampleStride)arr.push([rootPts[j].x,rootPts[j].y]);
      const q=rootPts[rootPts.length-1];
      if(!arr.length||arr[arr.length-1][0]!==q.x||arr[arr.length-1][1]!==q.y)arr.push([q.x,q.y]);
      if(arr.length>=2)previewLines.push(arr);
    }
  };

  while((match=tagRe.exec(text))){
    out.push(text.slice(lastIndex,match.index)); lastIndex=tagRe.lastIndex;
    const full=match[0],closing=!!match[1],rawName=match[2];
    const tag=rawName.includes(':')?rawName.split(':').pop().toLowerCase():rawName.toLowerCase();
    const attrText=match[3]||'', selfClosing=!!match[4]||/\/\s*>$/.test(full);
    if(closing){
      out.push(full);
      for(let k=stack.length-1;k>0;k--){const entry=stack[k];stack.pop();if(entry.tag===tag)break;}
      continue;
    }
    const attrs=parseAttrs(attrText),parent=stack[stack.length-1];
    const local=attrs.transform?parseTransform(attrs.transform):identityMatrix();
    const matrix=multiplyMatrix(parent.matrix,local),inv=invertMatrix(matrix);
    const style=attrs.style||'';
    const hidden=parent.hidden || ['defs','clippath','mask','symbol','pattern','marker'].includes(tag) ||
      String(attrs.display||'').toLowerCase()==='none' || String(attrs.visibility||'').toLowerCase()==='hidden' ||
      /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(style) || /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)/i.test(style);

    let emitted=full;
    if(!hidden && tag==='path' && attrs.d){
      processed++; if(processed%50===0)postMessage({type:'progress',message:'Ottimizzo path… '+processed.toLocaleString('it-IT')});
      if(!inv || hasUnsupportedPathCommands(attrs.d)){unsupported++;}
      else{
        const rebuilt=[];
        const ok=walkLinearPath(attrs.d,sp=>processSubpath(sp,matrix,inv,rebuilt));
        if(ok)emitted=rebuilt.length?replaceAttr(full,'d',rebuilt.join('')):''; else unsupported++;
      }
    } else if(!hidden && (tag==='polyline'||tag==='polygon') && attrs.points && inv){
      const pts=parsePointsAttr(attrs.points),rebuilt=[];
      processSubpath({points:pts,closed:tag==='polygon'},matrix,inv,rebuilt);
      if(!rebuilt.length)emitted='';
      else emitted=replaceAttr(full,'points',pathDToPoints(rebuilt[0]));
    } else if(!hidden && tag==='line'){
      const x1=+attrs.x1,y1=+attrs.y1,x2=+attrs.x2,y2=+attrs.y2;
      if(inv&&[x1,y1,x2,y2].every(Number.isFinite)){
        const rebuilt=[];processSubpath({points:[{x:x1,y:y1},{x:x2,y:y2}],closed:false},matrix,inv,rebuilt);
        if(!rebuilt.length)emitted='';
      }
    }
    out.push(emitted);
    if(!selfClosing && ['svg','g','a','symbol','defs','clippath','mask','pattern','marker'].includes(tag))stack.push({tag,matrix,hidden});
  }
  out.push(text.slice(lastIndex));

  const svgText=conservativeMinify(out.join(''));
  verifyPageIdentity(model.rawText,svgText);
  const outputBytes=utf8Length(svgText);
  const totalPaths=paths+unsupported;
  if(totalPaths<1)throw new Error('Il risultato non contiene geometrie visibili. Ottimizzazione annullata.');
  return {
    svgText,
    preview:{viewBox:page.viewBox,lines:previewLines,totalPoints:points,sampled:sampleStride>1},
    stats:{paths:totalPaths,points,drawMm,travelMm,penLifts:Math.max(0,totalPaths-1),outputBytes,removedShort:removed,unsupportedPreserved:unsupported,reduction:1-outputBytes/model.stats.fileBytes,pageOk:true}
  };
}

function normalizeOptions(opts){
  return {
    mode:opts.mode||'safe',
    simplifyMm:Math.max(0,Number(opts.simplifyMm)||0),
    minPathMm:Math.max(0,Number(opts.minPathMm)||0),
    dedupeMm:Math.max(0,Number(opts.dedupeMm)||0),
    precision:clamp(Math.round(Number(opts.precision)||3),0,7)
  };
}

function verifyPageIdentity(a,b){
  const sig=t=>{
    const m=t.match(/<svg\b([^>]*)>/i);if(!m)return null;
    const x=parseAttrs(m[1]||'');return {width:x.width||null,height:x.height||null,viewBox:x.viewBox||x.viewbox||null,preserve:x.preserveAspectRatio||x.preserveaspectratio||null};
  };
  const A=sig(a),B=sig(b);
  if(!A||!B||A.width!==B.width||A.height!==B.height||A.viewBox!==B.viewBox||A.preserve!==B.preserve){
    throw new Error('Controllo pagina fallito: width/height/viewBox sarebbero cambiati. File non esportato.');
  }
}

function conservativeMinify(text){
  let s=String(text);
  s=s.replace(/<\?xml\b([^>]*?)encoding\s*=\s*(["'])[^"']*\2([^>]*?)\?>/i,'<?xml$1encoding="UTF-8"$3?>');
  s=s.replace(/<!--[\s\S]*?-->/g,'');
  s=s.replace(/>\s+</g,'><');
  return s.trim();
}
function utf8Length(s){return new TextEncoder().encode(s).length;}

function rootToMm(p,page){
  const vb=page.viewBox;
  const sx=page.widthMm/vb.w, sy=page.heightMm/vb.h;
  const par=(page.rootPreserveAspectRatio||'xMidYMid meet').toLowerCase();
  if(par.includes('none')) return {x:(p.x-vb.x)*sx,y:(p.y-vb.y)*sy};
  const sc=Math.min(Math.abs(sx),Math.abs(sy));
  return {x:(p.x-vb.x)*sc,y:(p.y-vb.y)*sc};
}

function hasUnsupportedPathCommands(d){return /[CcSsQqTtAa]/.test(d);}
function walkLinearPath(d,onSubpath){
  const re=/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  let token=next(),cmd=null,cx=0,cy=0,sx=0,sy=0,pts=[],closed=false;
  function next(){const m=re.exec(d);return m?m[0]:null;}
  const isCmd=t=>t!==null&&/^[a-zA-Z]$/.test(t);
  const flush=()=>{if(pts.length)onSubpath({points:pts,closed});pts=[];closed=false;};
  while(token!==null){
    if(isCmd(token)){
      cmd=token;const C=cmd.toUpperCase();
      if(C==='Z'){closed=true;cx=sx;cy=sy;flush();cmd=null;token=next();continue;}
      if(!['M','L','H','V'].includes(C))return false;
      token=next();continue;
    }
    if(!cmd)return false;
    const rel=cmd===cmd.toLowerCase(),C=cmd.toUpperCase();
    if(C==='M'||C==='L'){
      const x0=Number(token),t2=next();if(t2===null||isCmd(t2))return false;
      const y0=Number(t2);let x=x0,y=y0;if(rel){x+=cx;y+=cy;}
      if(C==='M'){flush();cx=x;cy=y;sx=x;sy=y;pts=[{x,y}];cmd=rel?'l':'L';}
      else{cx=x;cy=y;pts.push({x,y});}
      token=next();
    } else if(C==='H'){let x=Number(token);if(rel)x+=cx;cx=x;pts.push({x:cx,y:cy});token=next();}
    else if(C==='V'){let y=Number(token);if(rel)y+=cy;cy=y;pts.push({x:cx,y:cy});token=next();}
  }
  flush();return true;
}

function serializeLinearSubpath(pts,closed,precision){
  if(!pts.length)return'';
  let d='M'+fmt(pts[0].x,precision)+' '+fmt(pts[0].y,precision);
  for(let i=1;i<pts.length;i++)d+='L'+fmt(pts[i].x,precision)+' '+fmt(pts[i].y,precision);
  if(closed)d+='Z';return d;
}
function pathDToPoints(d){const n=String(d).match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)||[];const a=[];for(let i=0;i+1<n.length;i+=2)a.push(n[i]+','+n[i+1]);return a.join(' ');}
function replaceAttr(tag,name,value){const re=new RegExp('(\\b'+name+'\\s*=\\s*)([\\"\'])([\\s\\S]*?)\\2','i');return re.test(tag)?tag.replace(re,(m,p,q)=>p+q+value+q):tag;}

function parseAttrs(s){const out={};const re=/([:\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;let m;while((m=re.exec(s)))out[m[1]]=m[3]!==undefined?m[3]:m[4];return out;}
function parseLength(v){if(!v)return null;const m=String(v).trim().match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)$/);if(!m)return null;return{value:Number(m[1]),unit:(m[2]||'px').toLowerCase()};}
function lengthToMm(l){if(!l||!Number.isFinite(l.value))return NaN;return l.value*(MM_PER_UNIT[l.unit]||MM_PER_UNIT.px);}
function lengthToCssPx(l){if(!l||!Number.isFinite(l.value))return NaN;const u=l.unit||'px';if(u==='px'||u==='')return l.value;if(u==='mm')return l.value*96/25.4;if(u==='cm')return l.value*96/2.54;if(u==='in')return l.value*96;if(u==='pt')return l.value*96/72;if(u==='pc')return l.value*16;if(u==='q')return l.value*96/101.6;return NaN;}
function parseViewBox(v){if(!v)return null;const a=String(v).trim().split(/[\s,]+/).map(Number);if(a.length!==4||!a.every(Number.isFinite)||a[2]===0||a[3]===0)return null;return{x:a[0],y:a[1],w:a[2],h:a[3]};}
function parsePointsAttr(s){if(!s)return[];const n=String(s).trim().split(/[\s,]+/).map(Number).filter(Number.isFinite),o=[];for(let i=0;i+1<n.length;i+=2)o.push({x:n[i],y:n[i+1]});return o;}

function identityMatrix(){return[1,0,0,1,0,0];}
function multiplyMatrix(a,b){return[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
function applyMatrix(m,p){return{x:m[0]*p.x+m[2]*p.y+m[4],y:m[1]*p.x+m[3]*p.y+m[5]};}
function invertMatrix(m){const[a,b,c,d,e,f]=m,det=a*d-b*c;if(Math.abs(det)<1e-15)return null;return[d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det];}
function parseTransform(s){
  let out=identityMatrix();const re=/([a-zA-Z]+)\s*\(([^)]*)\)/g;let m;
  while((m=re.exec(String(s)))){const name=m[1].toLowerCase(),v=m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);let t=identityMatrix();
    if(name==='matrix'&&v.length>=6)t=v.slice(0,6);
    else if(name==='translate')t=[1,0,0,1,v[0]||0,v.length>1?v[1]:0];
    else if(name==='scale'){const sx=Number.isFinite(v[0])?v[0]:1,sy=Number.isFinite(v[1])?v[1]:sx;t=[sx,0,0,sy,0,0];}
    else if(name==='rotate'){const a=(v[0]||0)*Math.PI/180,c=Math.cos(a),sn=Math.sin(a);t=[c,sn,-sn,c,0,0];if(v.length>=3){const cx=v[1],cy=v[2];t=multiplyMatrix(multiplyMatrix([1,0,0,1,cx,cy],t),[1,0,0,1,-cx,-cy]);}}
    else if(name==='skewx'){const a=(v[0]||0)*Math.PI/180;t=[1,0,Math.tan(a),1,0,0];}
    else if(name==='skewy'){const a=(v[0]||0)*Math.PI/180;t=[1,Math.tan(a),0,1,0,0];}
    out=multiplyMatrix(out,t);
  }return out;
}

function dedupeConsecutive(pts,tol){if(pts.length<2)return pts.slice();const o=[pts[0]];for(let i=1;i<pts.length;i++){const a=o[o.length-1],b=pts[i];if(Math.hypot(b.x-a.x,b.y-a.y)>tol)o.push(b);}return o;}
function polyLength(pts){let s=0;for(let i=1;i<pts.length;i++)s+=Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y);return s;}
function rdp(pts,eps){if(pts.length<3||eps<=0)return pts.slice();const sq=eps*eps,keep=new Uint8Array(pts.length);keep[0]=keep[pts.length-1]=1;const stack=[[0,pts.length-1]];while(stack.length){const[a,b]=stack.pop();let md=sq,idx=-1;for(let i=a+1;i<b;i++){const d=segDist2(pts[i],pts[a],pts[b]);if(d>md){md=d;idx=i;}}if(idx>=0){keep[idx]=1;stack.push([a,idx],[idx,b]);}}const o=[];for(let i=0;i<pts.length;i++)if(keep[i])o.push(pts[i]);return o;}
function segDist2(p,a,b){let x=a.x,y=a.y,dx=b.x-x,dy=b.y-y;if(dx||dy){const t=((p.x-x)*dx+(p.y-y)*dy)/(dx*dx+dy*dy);if(t>1){x=b.x;y=b.y;}else if(t>0){x+=dx*t;y+=dy*t;}}dx=p.x-x;dy=p.y-y;return dx*dx+dy*dy;}
function fmt(v,p){let s=Number(v).toFixed(p);if(p>0)s=s.replace(/\.?0+$/,'');return s==='-0'?'0':s;}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

if (typeof self === 'undefined') globalThis.self = globalThis;