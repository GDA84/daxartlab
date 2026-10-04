function optimizeDocument(model, options) {
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
    const matrix=multiplyMatrix(parent.matrix,local), inv=invertMatrix(matrix);
    const hidden=isHidden(tag,attrs,parent.hidden);

    if(!hidden && tag==='path' && attrs.d){
      processed++; if(processed%25===0) postMessage({type:'progress',message:'Ottimizzo path… '+processed.toLocaleString('it-IT')});
      if(!inv || hasUnsupportedPathCommandsRange(text,attrs.d.start,attrs.d.end)) {
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
