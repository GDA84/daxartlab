'use strict';

let MODEL = null;
const BUILD = '3.0.0-stable';
const MM_PER_UNIT = {mm:1, cm:10, in:25.4, pt:25.4/72, pc:25.4/6, px:25.4/96, q:0.25};

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      postMessage({type:'progress', message:'Leggo SVG…'});
      const text = decodeSvgBuffer(m.buffer);
      MODEL = analyzeDocument(text, m.name || 'input.svg', m.size || m.buffer.byteLength);
      postMessage({type:'loaded', build:BUILD, stats:MODEL.stats, page:MODEL.page, preview:MODEL.preview, warnings:MODEL.warnings});
    } else if (m.type === 'optimize') {
      if (!MODEL) throw new Error('Carica prima un SVG.');
      const result = optimizeDocument(MODEL, m.options || {});
      const bytes = new TextEncoder().encode(result.svgText);
      delete result.svgText;
      postMessage({type:'optimized', build:BUILD, ...result, svgBuffer:bytes.buffer}, [bytes.buffer]);
    } else if (m.type === 'reset') {
      MODEL = null;
      postMessage({type:'reset', build:BUILD});
    }
  } catch (err) {
    postMessage({type:'error', build:BUILD, message:err && err.message ? err.message : String(err)});
  }
};

function decodeSvgBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const probe = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const enc = /encoding\s*=\s*["']\s*([^"']+)/i.exec(probe)?.[1]?.toLowerCase() || 'utf-8';
  let decoder = 'utf-8';
  if (enc.includes('8859-1') || enc.includes('latin-1') || enc.includes('windows-1252')) decoder = 'windows-1252';
  try { return new TextDecoder(decoder).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function analyzeDocument(text, filename, fileBytes) {
  const root = findRootSvg(text);
  if (!root) throw new Error('Elemento <svg> principale non trovato.');
  const rootAttrs = readAttrs(text, root.start, root.end);
  const page = pageFromRoot(rootAttrs);
  const warnings = [];
  if (!page.explicitViewBox) warnings.push('viewBox assente: uso il viewport SVG implicito in CSS px (96 dpi), senza cambiare il formato di stampa.');

  const previewBudget = 35000;
  const estimatedPoints = Math.max(1, Math.ceil(fileBytes / 18));
  const sampleStride = Math.max(1, Math.ceil(estimatedPoints / previewBudget));
  const previewLines = [];

  let paths=0, points=0, drawMm=0, unsupported=0, transformed=0;
  const stack=[{tag:'__root__',matrix:identityMatrix(),hidden:false}];

  scanTags(text, (tagInfo) => {
    const {closing,tag,start,end,selfClosing,attrs}=tagInfo;
    if (closing) {
      popStack(stack, tag);
      return;
    }

    const parent = stack[stack.length-1];
    const local = attrs.transform ? parseTransform(attrs.transform.value) : identityMatrix();
    const matrix = multiplyMatrix(parent.matrix, local);
    if (attrs.transform) transformed++;
    const hidden = isHidden(tag, attrs, parent.hidden);

    if (!hidden && tag === 'path' && attrs.d) {
      if (hasUnsupportedPathCommandsRange(text, attrs.d.start, attrs.d.end)) {
        unsupported++;
      } else {
        const ok = walkLinearPathRange(text, attrs.d.start, attrs.d.end, sp => {
          if (!sp.points || sp.points.length<2) return;
          const rootPts = transformPoints(sp.points, matrix);
          const mmPts = rootPts.map(p => rootToMm(p, page));
          const len = polyLength(mmPts);
          points += sp.points.length; drawMm += len; paths++;
          if (previewLines.length < 12000) previewLines.push(sampleLine(rootPts, sampleStride));
        });
        if (!ok) unsupported++;
      }
    } else if (!hidden && (tag==='polyline' || tag==='polygon') && attrs.points) {
      const pts = parsePointsText(text, attrs.points.start, attrs.points.end);
      if (pts.length>=2) {
        const rootPts=transformPoints(pts,matrix), mmPts=rootPts.map(p=>rootToMm(p,page));
        points+=pts.length;drawMm+=polyLength(mmPts);paths++;
        if(previewLines.length<12000) previewLines.push(sampleLine(rootPts, sampleStride));
     }
    } else if (!hidden && tag==='line') {
      const x1=numAttr(attrs.x1),y1=numAttr(attrs.y1),x2=numAttr(attrs.x2),y2=numAttr(attrs.y2);
      if([x1,y1,x2,y2].every(Number.isFinite)) {
        const rootPts=transformPoints([{x:x1,y:y1},{x:x2,y:y2}],matrix), mmPts=rootPts.map(p=>rootToMm(p,page));
        points+=2;drawMm+=polyLength(mmPts);paths++;
        if(previewLines.length<12000) previewLines.push(rootPts.map(p=>[p.x,p.y]));
      }
    }

    if(!selfClosing && isContainer(tag)) stack.push({tag,matrix,hidden});
  });

  if (!paths && !unsupported) throw new Error('Nessuna geometria lineare compatibile trovata.');
  if (unsupported) warnings.push(unsupported.toLocaleString('it-IT')+' path con curve/archi saranno preservati senza modifica.');
  if (transformed) warnings.push(transformed.toLocaleString('it-IT')+' transformazioni SVG rilevate e rispettate.');

  return {
    text,
    page,
    sampleStride,
    stats:{filename,fileBytes,paths:paths+unsupported,points,drawMm,penLifts:Math.max(0,paths+unsupported-1),unsupported,transformed},
    preview:{viewBox:page.viewBox,lines:previewLines.filter(x=>x.length>=2),sampled:sampleStride>1,totalPoints:points},
    warnings
  };
}
imizeDocument(model, options) {
  const o = normalizeOptions(options);
  if (o.mode === 'lossless') {
    postMessage({type:'progress', message:'Lossless: mantengo il documento e alleggerisco solo commenti/spaziatura…'});
    const svgText = conservativeMinify(model.text);
    verifyPageIdentity(model.text, svgText);
    return {
      svgText,
      preview:model.preview,
      stats:{...model.stats,outputBytes:utf8Length(svgText),travelMm:NaN,reduction:1-utf8Length(svgText)/model.stats.fileBytes,pageOk:true}
    };
  }

  postMessage({type:'progress', message:'Ottimizzo i path senza ricreare canvas o gruppi…'});
  const text=model.text, page=model.page;
  const stack=[{tag:'__root__',matrix:identityMatrix(),hidden:false}];
  const replacements=[];
  const previewLines=[];
  let paths=0, points=0, drawMm=0, travelMm=0, removed=0, unsupported=0, processed=0;
  let prevEndMm=null;

  scanTags(text, (tagInfo) => {
    const {closing,tag,selfClosing,attrs}=tagInfo;
    if (closing) { popStack(stack,tag); return; }
    const parent=stack[stack.length-1];
    const local=attrs.transform?parseTransform(attrs.transform.value):identityMatrix();
    const matrix=multiplyMatrix(parent.matrix,local),inv=invertMatrix(matrix);
    const hidden=isHidden(tag,attrs,parent.hidden);

    if(!hidden && tag==='path' && attrs.d){
      processed++; if(processed%25===0)postMessage({type:'progress',message:'Ottimizzo path… '+processed.toLocaleString('it-IT')});
      if(!inv || hasUnsupportedPathCommandsRange(text,attrs.d.start,attrs.d.end)){
        unsupported++;
      } else {
        const parts=[];
        const ok=walkLinearPathRange(text,attrs.d.start,attrs.d.end,sp=>{
          const out=optimizeSubpath(sp,matrix,inv,page,o,model.sampleStride);
          if(!out){removed++;return;}
          parts.push(out.d);paths++;points+=out.points;drawMm+=out.drawMm;
          if(prevEndMm) travelMm+=Math.hypot(out.firstMm.x-prevEndMm.x,out.firstMm.y-prevEndMm.y);
          prevEndMm=out.lastMm;
          if(previewLines.length<12000 && out.preview.length>=2) previewLines.push(out.preview);
        });
        if(ok) replacements.push({start:attrs.d.start,end:attrs.d.end,value:parts.join('')});
        else unsupported++;
      }
    } else if(!hidden && (tag==='polyline'||tag==='polygon') && attrs.points && inv){
      const pts=parsePointsText(text,attrs.points.start,attrs.points.end);
      const out=optimizeSubpath({points:pts,closed:tag==='polygon'},matrix,inv,page,o,model.sampleStride);
      if(out){
        const localPts=out.localPts;
        replacements.push({start:attrs.points.start,end:attrs.points.end,value:localPts.map(p=>fmt(p.x,o.precision)+','+fmt(p.y,o.precision)).join(' ')});
        paths++;points+=out.points;drawMm+=out.drawMm;
        if(prevEndMm) travelMm+=Math.hypot(out.firstMm.x-prevEndMm.x,out.firstMm.y-prevEndMm.y);prevEndMm=out.lastMm;
        if(previewLines.length<12000&&out.preview.length>=2)previewLines.push(out.preview);
      } else { removed++; replacements.push({start:tagInfo.start,end:tagInfo.end+1,value:''}); }
    }

    if(!selfClosing && isContainer(tag)) stack.push({tag,matrix,hidden});
  });

  const svgText=applyReplacements(text,replacements);
  verifyPageIdentity(model.text,svgText);
  const outputBytes=utf8Length(svgText), totalPaths=paths+unsupported;
  if(totalPaths<1) throw new Error('Il risultato non contiene geometrie visibili. Ottimizzazione annullata.');
  return {
    svgText,
    preview:{viewBox:page.viewBox,lines:previewLines,sampled:model.sampleStride>1,totalPoints:points},
    stats:{paths:totalPaths,points,drawMm,travelMm,penLifts:Math.max(0,totalPaths-1),outputBytes,removedShort:removed,unsupportedPreserved:unsupported,reduction:1-outputBytes/model.stats.fileBytes,pageOk:true}
  };
}

function optimizeSubpath(sp,matrix,inv,page,o,sampleStride){
  if(!sp.points||sp.points.length<2)return null;
  let work=new Array(sp.points.length);
  for(let i=0;i<sp.points.length;i++){
    const root=applyMatrix(matrix,sp.points[i]),mm=rootToMm(root,page);
    work[i]={x:mm.x,y:mm.y,root};
  }
  work=dedupeConsecutive(work,o.dedupeMm);
  if(o.simplifyMm>0&&work.length>2)work=rdp(work,o.simplifyMm);
  const len=polyLength(work);
  if(work.length<2||(o.minPathMm>0&&len<o.minPathMm))return null;
  const localPts=new Array(work.length), preview=[];
  for(let i=0;i<work.length;i++){
    localPts[i]=applyMatrix(inv,work[i].root);
    if(i%sampleStride===0)preview.push([work[i].root.x,work[i].root.y]);
  }
  const q=work[work.length-1];
  if(!preview.length||preview[preview.length-1][0]!==q.root.x||preview[preview.length-1][1]!==q.root.y)preview.push([q.root.x,q.root.y]);
  return {d:serializeLinearSubpath(localPts,sp.closed,o.precision),localPts,points:work.length,drawMm:len,firstMm:work[0],lastMm:work[work.length-1],preview};
}

function applyReplacements(text,repls){
  if(!repls.length)return text;
  repls.sort((a,b)=>a.start-b.start);
  const chunks=[];let pos=0;
  for(const r of repls){if(r.start<pos)continue;chunks.push(text.slice(pos,r.start),r.value);pos=r.end;}
  chunks.push(text.slice(pos));
  return chunks.join('');
}

function normalizeOptions(o){return{mode:o.mode||'safe',simplifyMm:Math.max(0,+o.simplifyMm||0),minPathMm:Math.max(0,+o.minPathMm||0),dedupeMm:Math.max(0,+o.dedupeMm||0),precision:clamp(Math.round(+o.precision||3),0,7)}}

function findRootSvg(text){const i=text.search(/<svg\b/i);if(i<0)return null;const e=findTagEnd(text,i);return e<0?null:{start:i,end:e};}
function pageFromRoot(attrs){
  const wAttr=attrValue(attrs.width),hAttr=attrValue(attrs.height),vbAttr=attrValue(attrs.viewBox)||attrValue(attrs.viewbox),par=attrValue(attrs.preserveAspectRatio)||attrValue(attrs.preserveaspectratio)||null;
  const wl=parseLength(wAttr),hl=parseLength(hAttr),explicit=parseViewBox(vbAttr);
  let widthMm=lengthToMm(wl),heightMm=lengthToMm(hl),vb=explicit;
  if(!vb){let w=lengthToCssPx(wl),h=lengthToCssPx(hl);if(!(w>0))w=300;if(!(h>0))h=150;vb={x:0,y:0,w,h};}
  if(!(widthMm>0)||!(heightMm>0)){widthMm=vb.w*25.4/96;heightMm=vb.h*25.4/96;}
  return{viewBox:vb,widthMm,heightMm,rootWidthAttr:wAttr||null,rootHeightAttr:hAttr||null,rootViewBoxAttr:vbAttr||null,rootPreserveAspectRatio:par,explicitViewBox:Boolean(explicit)};
}

function scanTags(text,cb){
  let pos=0;
  while(true){const s=text.indexOf('<',pos);if(s<0)break;const e=findTagEnd(text,s);if(e<0)break;const info=parseTagInfo(text,s,e);pos=e+1;if(!info)continue;cb(info);}
}
function findTagEnd(text,start){let quote=null;for(let i=start+1;i<text.length;i++){const c=text[i];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='>')return i;}return-1;}
function parseTagInfo(text,start,end){
  let i=start+1;while(i<end&&/\s/.test(text[i]))i++;
  if(text.startsWith('!--',i)||text[i]==='?'||text[i]==='!')return null;
  let closing=false;if(text[i]==='/'){closing=true;i++;while(i<end&&/\s/.test(text[i]))i++;}
  const ns=i;while(i<end&&/[\w:.-]/.test(text[i]))i++;if(i===ns)return null;
  const raw=text.slice(ns,i),tag=raw.includes(':')?raw.split(':').pop().toLowerCase():raw.toLowerCase();
  if(closing)return{closing:true,tag,start,end,selfClosing:false,attrs:{}};
  const attrs=readAttrs(text,start,end);let j=end-1;while(j>start&&/\s/.test(text[j]))j--;
  return{closing:false,tag,start,end,selfClosing:text[j]==='/',attrs};
}
function readAttrs(text,start,end){
  const out={};let i=start+1;while(i<end&&/\s/.test(text[i]))i++;if(text[i]==='/')i++;while(i<end&&/[\w:.-]/.test(text[i]))i++;
  while(i<end){while(i<end&&(/[\s/]/.test(text[i])))i++;if(i>=end)break;const ns=i;while(i<end&&/[\w:.-]/.test(text[i]))i++;if(i===ns){i++;continue;}const name=text.slice(ns,i);while(i<end&&/\s/.test(text[i]))i++;if(text[i]!=='='){out[name]={value:'',start:i,end:i};continue;}i++;while(i<end&&/\s/.test(text[i]))i++;const q=text[i];if(q!=='"'&&q!=="'"){const vs=i;while(i<end&&!/\s/.test(text[i])&&text[i]!=='/')i++;out[name]={value:text.slice(vs,i),start:vs,end:i};continue;}i++;const vs=i;while(i<end&&text[i]!==q)i++;const ve=i;out[name]={value:(name==='d'||name==='points')?null:text.slice(vs,ve),start:vs,end:ve};if(i<end)i++;}
  return out;
}
function attrValue(a){return a?.value??null;}
function numAttr(a){if(!a)return NaN;return Number(a.value);}
function popStack(stack,tag){for(let k=stack.length-1;k>0;k--){const e=stack[k];stack.pop();if(e.tag===tag)break;}}
function isContainer(tag){return['svg','g','a','symbol','defs','clippath','mask','pattern','marker'].includes(tag)}
function isHidden(tag,attrs,parentHidden){const style=attrValue(attrs.style)||'';return parentHidden||['defs','clippath','mask','symbol','pattern','marker'].includes(tag)||String(attrValue(attrs.display)||'').toLowerCase()==='none'||String(attrValue(attrs.visibility)||'').toLowerCase()==='hidden'||/(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(style)||/(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)/i.test(style)}

function hasUnsupportedPathCommandsRange(text,start,end){for(let i=start;i<end;i++){const c=text.charCodeAt(i)|32;if(c===99||c===115||c===113||c===116||c===97)return true;}return false;}
function walkLinearPathRange(text,start,end,onSubpath){
  const re=/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;re.lastIndex=start;
  let token=next(),cmd=null,cx=0,cy=0,sx=0,sy=0,pts=[],closed=false;
  function next(){const m=re.exec(text);return m&&m.index<end?m[0]:null;}const isCmd=t=>t!==null&&/^[a-zA-Z]$/.test(t);const flush=()=>{if(pts.length)onSubpath({points:pts,closed});pts=[];closed=false;};
  while(token!==null){
    if(isCmd(token)){cmd=token;const C=cmd.toUpperCase();if(C==='Z'){closed=true;cx=sx;cy=sy;flush();cmd=null;token=next();continue;}if(!['M','L','H','V'].includes(C))return false;token=next();continue;}
    if(!cmd)return false;const rel=cmd===cmd.toLowerCase(),C=cmd.toUpperCase();
    if(C==='M'||C==='L'){const x0=Number(token),t2=next();if(t2===null||isCmd(t2))return false;const y0=Number(t2);let x=x0,y=y0;if(rel){x+=cx;y+=cy;}if(C==='M'){flush();cx=x;cy=y;sx=x;sy=y;pts=[{x,y}];cmd=rel?'l':'L';}else{cx=x;cy=y;pts.push({x,y});}token=next();}
    else if(C==='H'){let x=Number(token);if(rel)x+=cx;cx=x;pts.push({x:cx,y:cy});token=next();}
    else if(C==='V'){let y=Number(token);if(rel)y+=cy;cy=y;pts.push({x:cx,y:cy});token=next();}
  }
  flush();return true;
}

function parsePointsText(text,start,end){const re=/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;re.lastIndex=start;const n=[];let m;while((m=re.exec(text))&&m.index<end)n.push(Number(m[0]));const o=[];for(let i=0;i+1<n.length;i+=2)o.push({x:n[i],y:n[i+1]});return o;}
function sampleLine(pts,stride){const a=[];for(let i=0;i<pts.length;i+=stride)a.push([pts[i].x,pts[i].y]);const q=pts[pts.length-1];if(!a.length||a[a.length-1][0]!==q.x||a[a.length-1][1]!==q.y)a.push([q.x,q.y]);return a;}
function transformPoints(pts,m){const o=new Array(pts.length);for(let i=0;i<pts.length;i++)o[i]=applyMatrix(m,pts[i]);return o;}

function verifyPageIdentity(a,b){const A=rootSignature(a),B=rootSignature(b);if(!A||!B||A.width!==B.width||A.height!==B.height||A.viewBox!==B.viewBox||A.preserve!==B.preserve)throw new Error('Controllo pagina fallito: il canvas sarebbe cambiato. File non esportato.');}
function rootSignature(t){const r=findRootSvg(t);if(!r)return null;const x=readAttrs(t,r.start,r.end);return{width:attrValue(x.width),height:attrValue(x.height),viewBox:attrValue(x.viewBox)||attrValue(x.viewbox),preserve:attrValue(x.preserveAspectRatio)||attrValue(x.preserveaspectratio)}}
function conservativeMinify(text){let s=String(text);s=s.replace(/<\?xml\b([^>]*?)encoding\s*=\s*(["'])[^"']*\2([^>]*?)\?>/i,'<?xml$1encoding="UTF-8"$3?>');s=s.replace(/<!--[\s\S]*?-->/g,'');return s;}
function utf8Length(s){return new TextEncoder().encode(s).length;}

function rootToMm(p,page){const vb=page.viewBox,sx=page.widthMm/vb.w,sy=page.heightMm/vb.h;const par=(page.rootPreserveAspectRatio||'xMidYMid meet').toLowerCase();if(par.includes('none'))return{x:(p.x-vb.x)*sx,y:(p.y-vb.y)*sy};const sc=Math.min(Math.abs(sx),Math.abs(sy));return{x:(p.x-vb.x)*sc,y:(p.y-vb.y)*sc};}
function parseLength(v){if(!v)return null;const m=String(v).trim().match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)$/);return m?{value:Number(m[1]),unit:(m[2]||'px').toLowerCase()}:null;}
function lengthToMm(l){if(!l||!Number.isFinite(l.value))return NaN;return l.value*(MM_PER_UNIT[l.unit]||MM_PER_UNIT.px);}
function lengthToCssPx(l){if(!l||!Number.isFinite(l.value))return NaN;const u=l.unit||'px';if(u==='px'||u==='')return l.value;if(u==='mm')return l.value*96/25.4;if(u==='cm')return l.value*96/2.54;if(u==='in')return l.value*96;if(u==='pt')return l.value*96/72;if(u==='pc')return l.value*16;if(u==='q')return l.value*96/101.6;return NaN;}
function parseViewBox(v){if(!v)return null;const a=String(v).trim().split(/[\s,]+/).map(Number);return a.length===4&&a.every(Number.isFinite)&&a[2]!==0&&a[3]!==0?{x:a[0],y:a[1],w:a[2],h:a[3]}:null;}

function identityMatrix(){return[1,0,0,1,0,0]}
function multiplyMatrix(a,b){return[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]}
function applyMatrix(m,p){return{x:m[0]*p.x+m[2]*p.y+m[4],y:m[1]*p.x+m[3]*p.y+m[5]}}
function invertMatrix(m){const[a,b,c,d,e,f]=m,det=a*d-b*c;if(Math.abs(det)<1e-15)return null;return[d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det]}
function parseTransform(s){let out=identityMatrix();const re=/([a-zA-Z]+)\s*\(([^)]*)\)/g;let m;while((m=re.exec(String(s)))){const name=m[1].toLowerCase(),v=m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);let t=identityMatrix();if(name==='matrix'&&v.length>=6)t=v.slice(0,6);else if(name==='translate')t=[1,0,0,1,v[0]||0,v.length>1?v[1]:0];else if(name==='scale'){const sx=Number.isFinite(v[0])?v[0]:1,sy=Number.isFinite(v[1])?v[1]:sx;t=[sx,0,0,sy,0,0];}else if(name==='rotate'){const a=(v[0]||0)*Math.PI/180,c=Math.cos(a),sn=Math.sin(a);t=[c,sn,-sn,c,0,0];if(v.length>=3){const cx=v[1],cy=v[2];t=multiplyMatrix(multiplyMatrix([1,0,0,1,cx,cy],t),[1,0,0,1,-cx,-cy]);}}else if(name==='skewx')t=[1,0,Math.tan((v[0]||0)*Math.PI/180),1,0,0];else if(name==='skewy')t=[1,Math.tan((v[0]||0)*Math.PI/180),0,1,0,0];out=multiplyMatrix(out,t);}return out;}

function serializeLinearSubpath(pts,closed,p){let d='M'+fmt(pts[0].x,p)+' '+fmt(pts[0].y,p);for(let i=1;i<pts.length;i++)d+='L'+fmt(pts[i].x,p)+' '+fmt(pts[i].y,p);if(closed)d+='Z';return d;}
function dedupeConsecutive(pts,tol){if(pts.length<2)return pts.slice();const o=[pts[0]];for(let i=1;i<pts.length;i++){const a=o[o.length-1],b=pts[i];if(Math.hypot(b.x-a.x,b.y-a.y)>tol)o.push(b);}return o;}
function polyLength(pts){let s=0;for(let i=1;i<pts.length;i++)s+=Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y);return s;}
function rdp(pts,eps){if(pts.length<3||eps<=0)return pts.slice();const sq=eps*eps,keep=new Uint8Array(pts.length);keep[0]=keep[pts.length-1]=1;const stack=[[0,pts.length-1]];while(stack.length){const[a,b]=stack.pop();let md=sq,idx=-1;for(let i=a+1;i<b;i++){const d=segDist2(pts[i],pts[a],pts[b]);if(d>md){md=d;idx=i;}}if(idx>=0){keep[idx]=1;stack.push([a,idx],[idx,b]);}}const o=[];for(let i=0;i<pts.length;i++)if(keep[i])o.push(pts[i]);return o;}
function segDist2(p,a,b){let x=a.x,y=a.y,dx=b.x-x,dy=b.y-y;if(dx||dy){const t=((p.x-x)*dx+(p.y-y)*dy)/(dx*dx+dy*dy);if(t>1){x=b.x;y=b.y;}else if(t>0){x+=dx*t;y+=dy*t;}}dx=p.x-x;dy=p.y-y;return dx*dx+dy*dy;}
function fmt(v,p){let s=Number(v).toFixed(p);if(p>0)s=s.replace(/\.?0+$/,'');return s==='-0'?'0':s;}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
