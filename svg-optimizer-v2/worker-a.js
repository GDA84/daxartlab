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
        if(previewLines.length<12000) previewLines.push(sampleLine(rootPts,sampleStride));
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
  if (transformed) warnings.push(transformed.toLocaleString('it-IT')+' trasformazioni SVG rilevate e rispettate.');

  return {
    text,
    page,
    sampleStride,
    stats:{filename,fileBytes,paths:paths+unsupported,points,drawMm,penLifts:Math.max(0,paths+unsupported-1),unsupported,transformed},
    preview:{viewBox:page.viewBox,lines:previewLines.filter(x=>x.length>=2),sampled:sampleStride>1,totalPoints:points},
    warnings
  };
}
