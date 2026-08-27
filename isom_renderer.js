(function(root){
  'use strict';
  const registry=root.OMAPMAKER_ISOM_REGISTRY;
  if(!registry?.renderers)throw new Error('Normrenderern kräver OMapMakers symbolregister');
  const NS='http://www.w3.org/2000/svg';
  const number=value=>Number.isFinite(Number(value))?Number(value):0;
  const factor=scale=>registry.measurementBasis.baseScale/Math.max(1,number(scale)||15000);
  const paperMm=(value,scale)=>number(value)*factor(scale);
  const colour=name=>registry.colours[name]?.screen||name||'none';
  const definition=symbol=>registry.renderers[String(symbol)]||null;
  const svgEscape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function metresPerPixel(map){
    const center=map.getCenter(),zoom=map.getZoom();
    return 156543.03392804097*Math.cos(center.lat*Math.PI/180)/Math.pow(2,zoom);
  }
  function pixelsPerPaperMm(map,scale,mode='print'){
    if(mode!=='print')return 96/25.4;
    return (number(scale)||10000)/(1000*metresPerPixel(map));
  }
  function px(value,context){return Math.max(.35,paperMm(value,context.scale)*pixelsPerPaperMm(context.map,context.scale,context.mode))}
  function dashPixels(values,context){return (values||[]).map(value=>Math.max(.5,px(value,context))).join(' ')}
  function lineStyles(symbol,properties={},context){
    const d=definition(symbol);if(!d)return{outer:{color:'#111',weight:1.5}};
    const base={color:colour(d.colour||d.outline||'black'),weight:px(d.widthMm||d.lineWidthMm||.14,context),opacity:1,lineCap:'butt',lineJoin:'round'};
    if(d.dashMm)base.dashArray=dashPixels(d.dashMm,context);
    if(d.kind==='dotted-line'){base.weight=px(d.dotDiameterMm,context);base.dashArray=`0 ${Math.max(.5,px((d.repeatMm||d.dotDiameterMm)-d.dotDiameterMm,context))}`;base.lineCap='round'}
    if(d.kind==='cased-line'){
      const sourceWidth=Math.max(0,number(properties.widthMetres||properties.renderWidthMetres||properties.estimatedWidthMetres));
      const sourceMm=sourceWidth*1000/(number(context.scale)||10000),innerMm=Math.max(paperMm(d.minimumInnerWidthMm,context.scale),sourceMm),outlineMm=paperMm(d.outlineWidthMm,context.scale);
      const unit=pixelsPerPaperMm(context.map,context.scale,context.mode);
      return{outer:{...base,color:colour(d.outline),weight:(innerMm+2*outlineMm)*unit},inner:{...base,color:colour(d.fill),weight:innerMm*unit}};
    }
    if(d.kind==='railway')return{outer:{...base,weight:px(d.widthMm,context),dashArray:null},inner:{...base,color:colour(d.innerColour),weight:px(d.innerWidthMm,context),dashArray:dashPixels(d.dashMm,context),lineCap:'butt'}};
    if(d.kind==='double-line-with-supports'){
      const total=d.lineCentreGapMm+d.lineWidthMm,inner=Math.max(.01,d.lineCentreGapMm-d.lineWidthMm);
      return{outer:{...base,weight:px(total,context)},inner:{...base,color:colour('white'),weight:px(inner,context)}};
    }
    return{outer:base};
  }
  function areaStyle(symbol,properties={},context){
    const d=definition(symbol);if(!d)return{color:'#111',weight:1,fillColor:'#fff',fillOpacity:.15};
    const clear=d.outline&&!d.outlineConditional||d.outlineConditional==='clear'&&properties.boundary==='clear';
    const large=d.largeThresholdMetres&&number(properties.maximumDimensionMetres)>=d.largeThresholdMetres;
    const fill=large&&d.largeFill?d.largeFill:d.fill;
    return{color:clear?colour(d.outline):'transparent',weight:clear?px(d.outlineWidthMm||.1,context):0,fillColor:colour(fill||'white'),fillOpacity:1,opacity:1,lineCap:'round',lineJoin:'round'};
  }
  function pointMarkup(symbol,context,properties={}){
    const d=definition(symbol),largeSupport=d?.kind==='double-line-with-supports'&&Boolean(properties.largeMast),supportSize=largeSupport?d.largeSupportSizeMm:d?.supportWidthMm,stroke=colour(d?.colour||'black'),sw=paperMm(d?.supportStrokeMm||d?.strokeWidthMm||.14,context.scale),w=paperMm(supportSize||d?.widthMm||d?.diameterMm||.8,context.scale),h=paperMm(supportSize||d?.heightMm||d?.diameterMm||.8,context.scale),pad=Math.max(sw,.08),view=`${-w/2-pad} ${-h/2-pad} ${w+2*pad} ${h+2*pad}`;let body='';
    if(d?.kind==='point-circle')body=`<circle cx="0" cy="0" r="${w/2}" fill="${stroke}"/>`;
    else if(d?.kind==='point-ring')body=`<circle cx="0" cy="0" r="${Math.max(.01,w/2-sw/2)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='pit'||d?.kind==='waterhole')body=`<path d="M${-w/2},${-h/2} V${h*.12} L0,${h/2} L${w/2},${h*.12} V${-h/2}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    else if(d?.kind==='spring')body=`<path d="M${-w/2},0 A${w/2},${h/2} 0 1 0 ${w/2},0 M${w*.2},${h*.2} L${w*.55},${h*.65}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='point-cross')body=`<path d="M${-w/2},${-h/2} L${w/2},${h/2} M${w/2},${-h/2} L${-w/2},${h/2}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='high-tower')body=`<circle cx="0" cy="0" r="${w/2}" fill="none" stroke="${stroke}" stroke-width="${sw}"/><path d="M${-w*.3},${-h*.3} L${w*.3},${h*.3} M${w*.3},${-h*.3} L${-w*.3},${h*.3}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='line-with-supports')body=`<path d="M${-w/2},0H${w/2}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='double-line-with-supports')body=largeSupport?`<rect x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`:`<path d="M${-w/2},0H${w/2}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else body=`<circle cx="0" cy="0" r="${Math.max(.1,w/3)}" fill="${stroke}"/>`;
    if((d?.kind==='line-with-supports'||d?.kind==='double-line-with-supports')&&!largeSupport&&Number.isFinite(Number(properties.angleDegrees)))body=`<g transform="rotate(${90-number(properties.angleDegrees)-number(context.declination)})">${body}</g>`;
    const unit=pixelsPerPaperMm(context.map,context.scale,context.mode),size=Math.max(8,Math.max(w,h)*unit+4);
    return{html:`<svg class="symbol-svg" xmlns="${NS}" viewBox="${view}">${body}</svg>`,sizePx:size,widthMm:w,heightMm:h};
  }
  function localProject(coordinate,center){
    const latitude=center.lat*Math.PI/180;
    return{x:(number(coordinate[0])-center.lng)*111320*Math.cos(latitude),y:(number(coordinate[1])-center.lat)*111320};
  }
  function paperProject(coordinate,context){
    const p=localProject(coordinate,context.center),a=number(context.declination)*Math.PI/180,c=Math.cos(a),s=Math.sin(a),x=p.x*c-p.y*s,y=p.x*s+p.y*c;
    return{x:context.widthMm/2+x*1000/context.scale,y:context.heightMm/2-y*1000/context.scale};
  }
  function coordinatesForGeometry(geometry){
    const type=geometry?.type,c=geometry?.coordinates||[];
    if(type==='Point')return[[c]];
    if(type==='LineString')return[c];
    if(type==='MultiLineString'||type==='Polygon')return c;
    if(type==='MultiPolygon')return c.flat();
    return[];
  }
  function geometryPath(geometry,context){
    const closed=geometry?.type==='Polygon'||geometry?.type==='MultiPolygon';
    return coordinatesForGeometry(geometry).map(line=>line.map((coordinate,index)=>{const p=paperProject(coordinate,context);return`${index?'L':'M'}${p.x.toFixed(3)},${p.y.toFixed(3)}`}).join(' ')+(closed?' Z':'')).join(' ');
  }
  function pathLengthMm(geometry,context){
    let total=0;for(const line of coordinatesForGeometry(geometry))for(let i=1;i<line.length;i++){const a=paperProject(line[i-1],context),b=paperProject(line[i],context);total+=Math.hypot(b.x-a.x,b.y-a.y)}return total;
  }
  function paperBounds(geometry,context){
    const points=coordinatesForGeometry(geometry).flat().map(point=>paperProject(point,context));if(!points.length)return null;
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y);return{left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
  }
  function polygonAreaMm2(geometry,context){
    if(!geometry?.type?.includes('Polygon'))return 0;let total=0;const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
    for(const polygon of polygons)for(let ringIndex=0;ringIndex<polygon.length;ringIndex++){const points=polygon[ringIndex].map(point=>paperProject(point,context));let area=0;for(let i=0,j=points.length-1;i<points.length;j=i++)area+=points[j].x*points[i].y-points[i].x*points[j].y;total+=(ringIndex?-1:1)*Math.abs(area/2)}return Math.max(0,total);
  }
  function symbolForFeature(feature){return String(feature?.properties?.isomSymbol||feature?.properties?.symbol||'')}
  function featureLabel(feature,index){const p=feature.properties||{};return p.name||p.omapType||p.objectType||`Objekt ${index+1}`}
  function preflight(features,options){
    const scale=number(options.scale)||10000,context={...options,scale},issues=[];let tested=0;
    if(options.declination===null||options.declination===''||!Number.isFinite(Number(options.declination)))issues.push({severity:'error',code:'declination-missing',message:'Magnetisk deklination saknas; kartrotation och 601-linjer kan inte verifieras.'});
    const checked=[];
    (features||[]).forEach((feature,index)=>{
      const symbol=symbolForFeature(feature),d=definition(symbol),geometry=feature.geometry,label=featureLabel(feature,index),type=geometry?.type;
      if(!symbol||!d){issues.push({severity:'error',code:'renderer-missing',symbol:symbol||null,featureId:feature.id||null,message:`${label}: normrenderer saknas.`});return}
      const allowed=registry.symbols[symbol]?.geometry||[];
      if(allowed.length&&!allowed.includes(type)){issues.push({severity:'error',code:'geometry-mismatch',symbol,featureId:feature.id||null,message:`${label}: ${type} stämmer inte med ISOM ${symbol}.`});return}
      const bounds=paperBounds(geometry,context);if(bounds&&(bounds.right<0||bounds.bottom<0||bounds.left>context.widthMm||bounds.top>context.heightMm))return;tested++;
      const length=type?.includes('Line')?pathLengthMm(geometry,context):null,minimumLength=paperMm(d.minimumLengthMm,scale),minimumBox=(d.minimumBoxMm||[]).map(value=>paperMm(value,scale)),minimumWidth=paperMm(d.minimumWidthMm,scale);
      if(length!=null&&minimumLength&&length+1e-6<minimumLength)issues.push({severity:'warning',code:'minimum-length',symbol,featureId:feature.id||null,actualMm:length,requiredMm:minimumLength,message:`${label}: ${length.toFixed(2)} mm är kortare än minsta längd ${minimumLength.toFixed(2)} mm.`});
      if(bounds&&minimumBox.length===2&&(bounds.width+1e-6<minimumBox[0]||bounds.height+1e-6<minimumBox[1]))issues.push({severity:'warning',code:'minimum-area-box',symbol,featureId:feature.id||null,actualMm:[bounds.width,bounds.height],requiredMm:minimumBox,message:`${label}: ytan underskrider ${minimumBox[0].toFixed(2)} × ${minimumBox[1].toFixed(2)} mm.`});
      if(minimumBox.length===2&&type?.includes('Polygon')){const area=polygonAreaMm2(geometry,context),requiredArea=minimumBox[0]*minimumBox[1];if(area+1e-6<requiredArea)issues.push({severity:'warning',code:'minimum-area',symbol,featureId:feature.id||null,actualMm2:area,requiredMm2:requiredArea,message:`${label}: arean ${area.toFixed(2)} mm² underskrider riktvärdet ${requiredArea.toFixed(2)} mm².`})}
      if(bounds&&minimumWidth&&Math.min(bounds.width,bounds.height)+1e-6<minimumWidth)issues.push({severity:'warning',code:'minimum-width',symbol,featureId:feature.id||null,actualMm:Math.min(bounds.width,bounds.height),requiredMm:minimumWidth,message:`${label}: en dimension är mindre än ${minimumWidth.toFixed(2)} mm.`});
      if(d.minimumDashes&&length!=null){const pattern=(d.dashMm||[]).reduce((a,b)=>a+b,0)*factor(scale),count=pattern?Math.floor(length/pattern):0;if(count<d.minimumDashes)issues.push({severity:'warning',code:'minimum-dashes',symbol,featureId:feature.id||null,message:`${label}: för få hela streck för att symbolen ska kännas igen.`})}
      if(d.minimumDots&&length!=null){const repeat=paperMm(d.repeatMm||d.dotDiameterMm,scale),count=repeat?Math.floor(length/repeat):0;if(count<d.minimumDots)issues.push({severity:'warning',code:'minimum-dots',symbol,featureId:feature.id||null,message:`${label}: för få punkter för att symbolen ska kännas igen.`})}
      if(d.requiresDirection&&!feature.properties?.downhillSide)issues.push({severity:'warning',code:'direction-missing',symbol,featureId:feature.id||null,message:`${label}: fallriktning saknas, så taggar kan inte riktas säkert.`});
      if(d.settings?.supports&&['manual','gps'].includes(feature.properties?.source)&&Number(feature.properties?.supportCount)===0)issues.push({severity:'warning',code:'support-missing',symbol,featureId:feature.id||null,message:`${label}: inga exakta stolp- eller mastlägen har placerats.`});
      if(bounds)checked.push({feature,index,symbol,d,bounds,label});
    });
    const maxPairs=120000;let pairs=0;
    for(let i=0;i<checked.length&&pairs<maxPairs;i++)for(let j=i+1;j<checked.length&&pairs++<maxPairs;j++){
      const a=checked[i],b=checked[j],bothImpassable=a.d.impassable&&b.d.impassable,aPoint=a.feature.geometry?.type==='Point',bPoint=b.feature.geometry?.type==='Point',sameColour=(a.d.colour||a.d.outline)===(b.d.colour||b.d.outline);
      if(!bothImpassable&&!aPoint&&!bPoint&&!sameColour)continue;
      const dx=Math.max(0,Math.max(a.bounds.left,b.bounds.left)-Math.min(a.bounds.right,b.bounds.right)),dy=Math.max(0,Math.max(a.bounds.top,b.bounds.top)-Math.min(a.bounds.bottom,b.bounds.bottom)),gap=Math.hypot(dx,dy),required=paperMm(bothImpassable?registry.preflight.impassableGapMm:registry.preflight.generalGapMm,scale);
      if(gap>0&&gap+1e-6<required)issues.push({severity:'warning',code:bothImpassable?'minimum-opening':'minimum-gap',symbol:`${a.symbol}/${b.symbol}`,featureId:a.feature.id||null,message:`Avståndet mellan ${a.label} och ${b.label} är cirka ${gap.toFixed(2)} mm; normen kräver ${required.toFixed(2)} mm.`});
    }
    const errors=issues.filter(issue=>issue.severity==='error').length,warnings=issues.length-errors;
    return{registryVersion:registry.registryVersion,standard:registry.standard,scale,featureCount:tested,errors,warnings,passed:errors===0,issues};
  }
  function patternDefs(scale){
    const f=factor(scale),c=colour;return[
      `<pattern id="p-marsh-solid" patternUnits="userSpaceOnUse" width="4" height="${.3*f}"><path d="M0 ${.12*f/2}H4" stroke="${c('blue')}" stroke-width="${.12*f}"/></pattern>`,
      `<pattern id="p-marsh-dashed" patternUnits="userSpaceOnUse" width="${1.15*f}" height="${.3*f}"><path d="M0 ${.1*f/2}H${.9*f}" stroke="${c('blue')}" stroke-width="${.1*f}"/></pattern>`,
      `<pattern id="p-scattered-402" patternUnits="userSpaceOnUse" width="${.7*f}" height="${.7*f}" patternTransform="rotate(45)"><rect width="100%" height="100%" fill="${c('yellow')}"/><circle cx="${.35*f}" cy="${.35*f}" r="${.2*f}" fill="white"/></pattern>`,
      `<pattern id="p-scattered-404" patternUnits="userSpaceOnUse" width="${.8*f}" height="${.8*f}" patternTransform="rotate(45)"><rect width="100%" height="100%" fill="${c('yellow50')}"/><circle cx="${.4*f}" cy="${.4*f}" r="${.25*f}" fill="white"/></pattern>`,
      `<pattern id="p-cultivated" patternUnits="userSpaceOnUse" width="${.8*f}" height="${.8*f}"><rect width="100%" height="100%" fill="${c('yellow')}"/><circle cx="${.4*f}" cy="${.4*f}" r="${.1*f}" fill="${c('black')}"/></pattern>`
    ].join('');
  }
  function areaFill(symbol,d){if(symbol==='307'||symbol==='308')return'url(#p-marsh-solid)';if(symbol==='310')return'url(#p-marsh-dashed)';if(symbol==='402')return'url(#p-scattered-402)';if(symbol==='404')return'url(#p-scattered-404)';if(symbol==='412')return'url(#p-cultivated)';return colour(d.fill||'white')}
  function sampleLine(line,context,spacing){
    const points=line.map(p=>paperProject(p,context)),result=[];let next=spacing/2;
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],length=Math.hypot(b.x-a.x,b.y-a.y);while(next<=length){const t=next/length;result.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,angle:Math.atan2(b.y-a.y,b.x-a.x)});next+=spacing}next-=length}return result;
  }
  function vectorElements(feature,context){
    const symbol=symbolForFeature(feature),d=definition(symbol);if(!d)return[];const path=geometryPath(feature.geometry,context),f=factor(context.scale),elements=[],layer=name=>registry.colourOrder.indexOf(name);
    if(feature.geometry.type==='Point'){
      const p=paperProject(feature.geometry.coordinates,context),point=pointMarkup(symbol,{...context,map:{getCenter:()=>context.center,getZoom:()=>0},mode:'digital'},feature.properties||{}),markup=point.html.replace(/^<svg[^>]*>|<\/svg>$/g,'');
      const w=point.widthMm,h=point.heightMm,pad=Math.max(paperMm(d.supportStrokeMm||d.strokeWidthMm||.14,context.scale),.08);
      elements.push({layer:layer(d.colour||'black'),markup:`<svg x="${p.x-w/2-pad}" y="${p.y-h/2-pad}" width="${w+2*pad}" height="${h+2*pad}" viewBox="${-w/2-pad} ${-h/2-pad} ${w+2*pad} ${h+2*pad}" overflow="visible">${markup}</svg>`});return elements;
    }
    if(d.kind==='area'||d.kind==='pattern-area'){
      const showOutline=d.outline&&(!d.outlineConditional||feature.properties?.boundary==='clear'),large=d.largeThresholdMetres&&number(feature.properties?.maximumDimensionMetres)>=d.largeThresholdMetres,fill=large&&d.largeFill?colour(d.largeFill):areaFill(symbol,d),fillLayer=layer(large&&d.largeFill?d.largeFill:d.fill||d.patternColour||'white');elements.push({layer:fillLayer,markup:`<path d="${path}" fill="${fill}" fill-rule="evenodd"/>`});
      if(showOutline)elements.push({layer:layer(d.outline),markup:`<path d="${path}" fill="none" stroke="${colour(d.outline)}" stroke-width="${paperMm(d.outlineWidthMm,context.scale)}" stroke-linejoin="round"/>`});return elements;
    }
    const stroke=name=>colour(name),lineWidth=value=>paperMm(value,context.scale),dash=d.kind==='dotted-line'?` stroke-dasharray="0 ${lineWidth(Math.max(0,(d.repeatMm||d.dotDiameterMm)-d.dotDiameterMm))}"`:d.dashMm?` stroke-dasharray="${d.dashMm.map(v=>paperMm(v,context.scale)).join(' ')}"`:'';
    if(d.kind==='cased-line'){
      const source=Math.max(0,number(feature.properties?.widthMetres||feature.properties?.renderWidthMetres||feature.properties?.estimatedWidthMetres))*1000/context.scale,inner=Math.max(paperMm(d.minimumInnerWidthMm,context.scale),source),outer=inner+2*paperMm(d.outlineWidthMm,context.scale);elements.push({layer:layer(d.outline),markup:`<g data-composite-symbol="${symbol}"><path d="${path}" fill="none" stroke="${stroke(d.outline)}" stroke-width="${outer}" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="${stroke(d.fill)}" stroke-width="${inner}" stroke-linejoin="round"/></g>`});return elements;
    }
    if(d.kind==='railway'){elements.push({layer:layer('black'),markup:`<g data-composite-symbol="${symbol}"><path d="${path}" fill="none" stroke="${stroke('black')}" stroke-width="${lineWidth(d.widthMm)}"/><path d="${path}" fill="none" stroke="white" stroke-width="${lineWidth(d.innerWidthMm)}" stroke-dasharray="${d.dashMm.map(v=>lineWidth(v)).join(' ')}"/></g>`});return elements}
    if(d.kind==='double-line-with-supports'){elements.push({layer:layer('black'),markup:`<g data-composite-symbol="${symbol}"><path d="${path}" fill="none" stroke="${stroke('black')}" stroke-width="${lineWidth(d.lineCentreGapMm+d.lineWidthMm)}"/><path d="${path}" fill="none" stroke="white" stroke-width="${lineWidth(d.lineCentreGapMm-d.lineWidthMm)}"/></g>`});return elements}
    elements.push({layer:layer(d.colour||'black'),markup:`<path d="${path}" fill="none" stroke="${stroke(d.colour||'black')}" stroke-width="${lineWidth(d.widthMm||d.lineWidthMm||d.dotDiameterMm||.14)}"${dash} stroke-linecap="${d.kind==='dotted-line'?'round':'butt'}" stroke-linejoin="round"/>`});
    if(d.kind==='cliff'&&feature.properties?.downhillSide)for(const line of coordinatesForGeometry(feature.geometry))for(const point of sampleLine(line,context,paperMm(d.tagSpacingMm,context.scale))){const side=String(feature.properties.downhillSide).toLowerCase()==='right'||Number(feature.properties.downhillSide)>0?1:-1,angle=point.angle+side*Math.PI/2,len=lineWidth(d.tagLengthMm),dx=Math.cos(angle)*len,dy=Math.sin(angle)*len;elements.push({layer:layer(d.colour),markup:`<path d="M${point.x},${point.y}L${point.x+dx},${point.y+dy}" stroke="${stroke(d.colour)}" stroke-width="${lineWidth(d.tagWidthMm)}" stroke-linecap="round"/>`})}
    if(d.kind==='styled-line')for(const line of coordinatesForGeometry(feature.geometry))for(const point of sampleLine(line,context,paperMm(d.styleSpacingMm,context.scale))){if(d.style==='dots')elements.push({layer:layer(d.colour),markup:`<circle cx="${point.x}" cy="${point.y}" r="${lineWidth(d.styleDiameterMm)/2}" fill="${stroke(d.colour)}"/>`});else{const len=lineWidth(d.tagLengthMm)/2,dx=Math.cos(point.angle+Math.PI/3)*len,dy=Math.sin(point.angle+Math.PI/3)*len;elements.push({layer:layer(d.colour),markup:`<path d="M${point.x-dx},${point.y-dy}L${point.x+dx},${point.y+dy}" stroke="${stroke(d.colour)}" stroke-width="${lineWidth(d.tagWidthMm)}"/>`})}}
    return elements;
  }
  function buildVectorSvg(features,options){
    const context={...options,scale:number(options.scale)||10000,declination:number(options.declination),center:{lat:number(options.center.lat),lng:number(options.center.lng)},widthMm:number(options.widthMm),heightMm:number(options.heightMm)},groups=registry.colourOrder.map(()=>[]),north=registry.technical['601'],spacing=north.spacingGroundMetres*1000/context.scale,northWidth=paperMm(north.preferredColour==='blue'?north.lineWidthBlueMm:north.lineWidthBlackMm,context.scale),northColour=colour(north.preferredColour);
    for(let x=context.widthMm/2%spacing;x<context.widthMm;x+=spacing)groups[registry.colourOrder.indexOf(north.preferredColour)].push(`<path d="M${x},0V${context.heightMm}" stroke="${northColour}" stroke-width="${northWidth}"/>`);
    for(let x=context.widthMm/2%spacing-spacing;x>=0;x-=spacing)groups[registry.colourOrder.indexOf(north.preferredColour)].push(`<path d="M${x},0V${context.heightMm}" stroke="${northColour}" stroke-width="${northWidth}"/>`);
    for(const feature of features||[]){const bounds=paperBounds(feature.geometry,context);if(bounds&&(bounds.right<0||bounds.bottom<0||bounds.left>context.widthMm||bounds.top>context.heightMm))continue;for(const item of vectorElements(feature,context))groups[Math.max(0,item.layer)].push(item.markup);const label=feature.properties?.mapText,labelCoordinate=feature.properties?.labelCoordinate;if(label&&Array.isArray(labelCoordinate)){const p=paperProject(labelCoordinate,context),height=paperMm(feature.properties?.textHeightMm||registry.textRules.minimumSansHeightMm,context.scale);groups[registry.colourOrder.indexOf(feature.properties?.textColour||'black')].push(`<text x="${p.x}" y="${p.y}" font-family="${svgEscape(registry.textRules.fontFamily)}" font-size="${height}" text-anchor="middle" data-orientation="magnetic-north">${svgEscape(label)}</text>`)}}
    const content=groups.map((items,index)=>items.length?`<g data-colour="${registry.colourOrder[index]}" style="mix-blend-mode:${registry.overprint.previewBlendMode}">${items.join('')}</g>`:'').join('');
    return`<svg xmlns="${NS}" viewBox="0 0 ${context.widthMm} ${context.heightMm}" width="${context.widthMm}mm" height="${context.heightMm}mm" role="img" aria-label="Normstyrd orienteringskarta"><metadata>${svgEscape(JSON.stringify({standard:registry.standard,symbolRegistryVersion:registry.registryVersion,scale:context.scale,declination:context.declination,colourSpace:'IOF CMYK definitions with RGB screen preview'}))}</metadata><defs><clipPath id="map-clip"><rect width="${context.widthMm}" height="${context.heightMm}"/></clipPath>${patternDefs(context.scale)}</defs><rect width="100%" height="100%" fill="white"/><g clip-path="url(#map-clip)">${content}</g></svg>`;
  }
  root.OMAPMAKER_ISOM_RENDERER={definition,factor,paperMm,pixelsPerPaperMm,lineStyles,areaStyle,pointMarkup,preflight,buildVectorSvg,paperProject,geometryPath,colour};
})(window);
