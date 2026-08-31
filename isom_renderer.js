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
      return{outer:{...base,weight:px(d.lineWidthMm,context)},parallelSeparationMm:d.lineCentreGapMm};
    }
    if(d.kind==='stairway')return{outer:{...base,weight:px(d.innerWidthMm+2*d.railWidthMm,context)},inner:{...base,color:colour('white'),weight:px(d.innerWidthMm,context)}};
    return{outer:base};
  }
  function areaStyle(symbol,properties={},context){
    const d=definition(symbol);if(!d)return{color:'#111',weight:1,fillColor:'#fff',fillOpacity:.15};
    const clear=d.outline&&!d.outlineConditional||d.outlineConditional==='clear'&&properties.boundary==='clear';
    const large=d.largeThresholdMetres&&number(properties.maximumDimensionMetres)>=d.largeThresholdMetres;
    const fill=large&&d.largeFill?d.largeFill:d.screenPreview||d.fill,hasFill=Boolean(fill)&&fill!=='none';
    return{color:clear?colour(d.outline):'transparent',weight:clear?px(d.outlineWidthMm||.1,context):0,dashArray:clear&&d.dashMm?dashPixels(d.dashMm,context):null,fillColor:hasFill?colour(fill):'transparent',fillOpacity:hasFill?1:0,opacity:1,lineCap:d.dashMm?'butt':'round',lineJoin:'round'};
  }
  function pointMarkup(symbol,context,properties={}){
    const d=definition(symbol),largeSupport=d?.kind==='double-line-with-supports'&&Boolean(properties.largeMast),supportSize=largeSupport?d?.largeSupportSizeMm:d?.supportWidthMm,pointScale=d?.kind==='boulder-cluster'&&number(properties.sizePercent)===120?1.2:1,stroke=colour(d?.colour||'black'),sw=paperMm(largeSupport?d?.largeSupportStrokeMm:d?.supportStrokeMm||d?.strokeWidthMm||.14,context.scale),glyphW=paperMm(supportSize||d?.widthMm||d?.diameterMm||.8,context.scale)*pointScale,glyphH=paperMm(supportSize||d?.heightMm||d?.diameterMm||.8,context.scale)*pointScale,w=Math.max(glyphW,paperMm(d?.maskWidthMm||d?.maskDiameterMm,context.scale)),h=Math.max(glyphH,paperMm(d?.maskHeightMm||d?.maskDiameterMm,context.scale)),pad=Math.max(sw,paperMm(d?.maskStrokeWidthMm||0,context.scale)/2,.08),view=`${-w/2-pad} ${-h/2-pad} ${w+2*pad} ${h+2*pad}`;let body='';
    if(d?.kind==='point-circle')body=`<circle cx="0" cy="0" r="${w/2}" fill="${stroke}"/>`;
    else if(d?.kind==='point-ring')body=`<circle cx="0" cy="0" r="${Math.max(.01,w/2-sw/2)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='elongated-knoll'){const ew=w*.3,eh=h*.4;body=`<ellipse cx="${-w*.35}" cy="${-h*.3}" rx="${ew/2}" ry="${eh/2}" fill="${stroke}" transform="rotate(-25 ${-w*.35} ${-h*.3})"/><ellipse cx="${w*.35}" cy="${-h*.3}" rx="${ew/2}" ry="${eh/2}" fill="${stroke}" transform="rotate(25 ${w*.35} ${-h*.3})"/><ellipse cx="0" cy="${h*.3}" rx="${ew/2}" ry="${eh/2}" fill="${stroke}"/>`}
    else if(d?.kind==='small-depression')body=`<path d="M${-w/2},${-h/2} C${-w*.28},${h/2} ${w*.28},${h/2} ${w/2},${-h/2}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
    else if(d?.kind==='pit')body=`<path d="M${-w/2},${-h/2} L0,${h/2} L${w/2},${-h/2}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="miter"/>`;
    else if(d?.kind==='rocky-pit'){const rotation=number(properties.orientationDegrees||properties.angleDegrees)-number(context.declination);body=`<g transform="rotate(${rotation})"><path d="M${-w/2},${-h/2} L0,${h/2} L${w/2},${-h/2}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="miter"/></g>`}
    else if(d?.kind==='dangerous-pit'){const inner=paperMm(d.innerDiameterMm,context.scale);body=`<circle cx="0" cy="0" r="${w/2}" fill="${stroke}"/><circle cx="0" cy="0" r="${inner/2}" fill="${colour(d.innerColour)}"/>`}
    else if(d?.kind==='boulder-cluster')body=`<path d="M0,${-h/2} L${w/2},${h/2} L${-w/2},${h/2} Z" fill="${stroke}"/>`;
    else if(d?.kind==='waterhole')body=`<path d="M${-w/2},${-h/2} V${h*.12} L0,${h/2} L${w/2},${h*.12} V${-h/2}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    else if(d?.kind==='spring')body=`<path d="M${-w/2},0 A${w/2},${h/2} 0 1 0 ${w/2},0 M${w*.2},${h*.2} L${w*.55},${h*.65}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='point-cross')body=`<path d="M${-w/2},${-h/2} L${w/2},${h/2} M${w/2},${-h/2} L${-w/2},${h/2}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='masked-ring'){const mask=paperMm(d.maskDiameterMm,context.scale),diameter=paperMm(d.diameterMm,context.scale);body=`${properties.omitMask?'':`<circle cx="0" cy="0" r="${mask/2}" fill="${colour(d.maskColour)}"/>`}<circle cx="0" cy="0" r="${Math.max(.01,diameter/2-sw/2)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`}
    else if(d?.kind==='point-ring-filled'){const diameter=paperMm(d.diameterMm,context.scale);body=`<circle cx="0" cy="0" r="${Math.max(.01,diameter/2-sw/2)}" fill="${colour(d.fill)}" stroke="${stroke}" stroke-width="${sw}"/>`}
    else if(d?.kind==='masked-point-cross'){const mw=paperMm(d.maskWidthMm,context.scale),mh=paperMm(d.maskHeightMm,context.scale),msw=paperMm(d.maskStrokeWidthMm,context.scale),gw=paperMm(d.widthMm,context.scale),gh=paperMm(d.heightMm,context.scale),path=(width,height)=>`M${-width/2},${-height/2} L${width/2},${height/2} M${width/2},${-height/2} L${-width/2},${height/2}`;body=`${properties.omitMask?'':`<path d="${path(mw,mh)}" stroke="${colour(d.maskColour)}" stroke-width="${msw}"/>`}<path d="${path(gw,gh)}" stroke="${stroke}" stroke-width="${sw}"/>`}
    else if(d?.kind==='high-tower'){const inner=paperMm(d.innerDiameterMm,context.scale);body=`<path d="M${-w/2},0H${w/2} M0,${-h/2}V${h/2}" stroke="${stroke}" stroke-width="${sw}"/><circle cx="0" cy="0" r="${inner/2}" fill="${stroke}"/>`}
    else if(d?.kind==='small-tower')body=`<path d="M${-w/2},${-h*.3}H${w/2} M0,${-h/2}V${h/2}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="butt"/>`;
    else if(d?.kind==='cairn'){const inner=paperMm(d.innerDiameterMm,context.scale);body=`<circle cx="0" cy="0" r="${Math.max(.01,w/2-sw/2)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/><circle cx="0" cy="0" r="${inner/2}" fill="${stroke}"/>`}
    else if(d?.kind==='fodder-rack'){const rise=paperMm(d.roofRiseMm,context.scale),joint=-h/2+rise;body=`<path d="M${-w/2},${-h/2} L0,${joint} L${w/2},${-h/2} M0,${joint}V${h/2}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="butt" stroke-linejoin="miter"/>`}
    else if(d?.kind==='crossing-point'){const spacing=paperMm(d.barSpacingMm,context.scale),length=paperMm(d.barLengthMm,context.scale),mask=paperMm(d.maskWidthMm,context.scale),maskHeight=Math.max(sw,paperMm(.3,context.scale)),rotation=-number(properties.angleDegrees)-number(context.declination);body=`<g transform="rotate(${rotation})">${properties.breakBarrier&&!properties.omitMask?`<rect x="${-mask/2}" y="${-maskHeight/2}" width="${mask}" height="${maskHeight}" fill="white"/>`:''}<path d="M${-spacing/2},${-length/2}V${length/2} M${spacing/2},${-length/2}V${length/2}" stroke="${stroke}" stroke-width="${sw}"/></g>`}
    else if(d?.kind==='line-with-supports')body=`<path d="M${-w/2},0H${w/2}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if(d?.kind==='double-line-with-supports')body=largeSupport?`<rect x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`:`<path d="M${-w/2},0H${w/2}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else body=`<circle cx="0" cy="0" r="${Math.max(.1,w/3)}" fill="${stroke}"/>`;
    if((d?.kind==='line-with-supports'||d?.kind==='double-line-with-supports')&&!largeSupport&&Number.isFinite(Number(properties.angleDegrees)))body=`<g transform="rotate(${90-number(properties.angleDegrees)-number(context.declination)})">${body}</g>`;
    const unit=pixelsPerPaperMm(context.map,context.scale,context.mode),visualWidth=(w+2*pad)*unit,visualHeight=(h+2*pad)*unit,size=Math.max(8,Math.max(visualWidth,visualHeight)+4),svg=`<svg class="symbol-svg" xmlns="${NS}" viewBox="${view}">${body}</svg>`,mapSvg=`<svg class="symbol-svg map-symbol-svg" xmlns="${NS}" viewBox="${view}" style="width:${visualWidth}px;height:${visualHeight}px">${body}</svg>`;
    return{html:svg,mapHtml:mapSvg,sizePx:size,visualWidthPx:visualWidth,visualHeightPx:visualHeight,widthMm:w,heightMm:h};
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
      const length=type?.includes('Line')?pathLengthMm(geometry,context):null,minimumLength=paperMm(d.minimumLengthMm,scale),minimumBox=(d.minimumBoxMm||[]).map(value=>paperMm(value,scale)),minimumWidth=paperMm(d.minimumWidthMm,scale),minimumArea=number(d.minimumAreaMm2)*factor(scale)**2;
      if(length!=null&&minimumLength&&length+1e-6<minimumLength)issues.push({severity:'warning',code:'minimum-length',symbol,featureId:feature.id||null,actualMm:length,requiredMm:minimumLength,message:`${label}: ${length.toFixed(2)} mm är kortare än minsta längd ${minimumLength.toFixed(2)} mm.`});
      if(bounds&&minimumBox.length===2&&(bounds.width+1e-6<minimumBox[0]||bounds.height+1e-6<minimumBox[1]))issues.push({severity:'warning',code:'minimum-area-box',symbol,featureId:feature.id||null,actualMm:[bounds.width,bounds.height],requiredMm:minimumBox,message:`${label}: ytan underskrider ${minimumBox[0].toFixed(2)} × ${minimumBox[1].toFixed(2)} mm.`});
      if(minimumBox.length===2&&type?.includes('Polygon')){const area=polygonAreaMm2(geometry,context),requiredArea=minimumBox[0]*minimumBox[1];if(area+1e-6<requiredArea)issues.push({severity:'warning',code:'minimum-area',symbol,featureId:feature.id||null,actualMm2:area,requiredMm2:requiredArea,message:`${label}: arean ${area.toFixed(2)} mm² underskrider riktvärdet ${requiredArea.toFixed(2)} mm².`})}
      if(minimumArea&&type?.includes('Polygon')){const area=polygonAreaMm2(geometry,context);if(area+1e-6<minimumArea)issues.push({severity:'warning',code:'minimum-area',symbol,featureId:feature.id||null,actualMm2:area,requiredMm2:minimumArea,message:`${label}: arean ${area.toFixed(2)} mm² underskrider minsta area ${minimumArea.toFixed(2)} mm².`})}
      if(bounds&&minimumWidth&&Math.min(bounds.width,bounds.height)+1e-6<minimumWidth)issues.push({severity:'warning',code:'minimum-width',symbol,featureId:feature.id||null,actualMm:Math.min(bounds.width,bounds.height),requiredMm:minimumWidth,message:`${label}: en dimension är mindre än ${minimumWidth.toFixed(2)} mm.`});
      if(d.minimumDashes&&length!=null){const pattern=(d.dashMm||[]).reduce((a,b)=>a+b,0)*factor(scale),count=pattern?Math.floor(length/pattern):0;if(count<d.minimumDashes)issues.push({severity:'warning',code:'minimum-dashes',symbol,featureId:feature.id||null,message:`${label}: för få hela streck för att symbolen ska kännas igen.`})}
      if(d.minimumDots&&length!=null){const repeat=paperMm(d.repeatMm||d.dotDiameterMm,scale),count=repeat?Math.floor(length/repeat):0;if(count<d.minimumDots)issues.push({severity:'warning',code:'minimum-dots',symbol,featureId:feature.id||null,message:`${label}: för få punkter för att symbolen ska kännas igen.`})}
      const directionProperty=d.directionProperty||'downhillSide';
      if(d.requiresDirection&&!feature.properties?.[directionProperty]){const message=directionProperty==='tagSide'?`${label}: taggsida saknas, så staketets taggar kan inte placeras säkert.`:directionProperty==='lowerSide'?`${label}: lägre sida saknas, så stödmurens halvpunkter kan inte riktas säkert.`:`${label}: fallriktning saknas, så taggar kan inte riktas säkert.`;issues.push({severity:'warning',code:'direction-missing',symbol,featureId:feature.id||null,message})}
      if(d.settings?.supports&&['manual','gps'].includes(feature.properties?.source)&&Number(feature.properties?.supportCount)===0)issues.push({severity:'warning',code:'support-missing',symbol,featureId:feature.id||null,message:`${label}: inga exakta stolp- eller mastlägen har placerats.`});
      if(d.kind==='crossing-point'&&!feature.properties?.parentObjectId)issues.push({severity:'warning',code:'crossing-unlinked',symbol,featureId:feature.id||null,message:`${label}: passagen är inte kopplad till någon barriärlinje.`});
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
      `<pattern id="p-vertical-green-407" patternUnits="userSpaceOnUse" width="${.84*f}" height="4"><rect width="100%" height="100%" fill="white"/><path d="M${.06*f},0V4" stroke="${c('green')}" stroke-width="${.12*f}"/></pattern>`,
      `<pattern id="p-vertical-green-409" patternUnits="userSpaceOnUse" width="${.42*f}" height="4"><rect width="100%" height="100%" fill="white"/><path d="M${.07*f},0V4" stroke="${c('green')}" stroke-width="${.14*f}"/></pattern>`,
      `<pattern id="p-cultivated" patternUnits="userSpaceOnUse" width="${.8*f}" height="${.8*f}"><rect width="100%" height="100%" fill="${c('yellow')}"/><circle cx="${.4*f}" cy="${.4*f}" r="${.1*f}" fill="${c('black')}"/></pattern>`
    ].join('');
  }
  function areaFill(symbol,d){if(symbol==='307'||symbol==='308')return'url(#p-marsh-solid)';if(symbol==='310')return'url(#p-marsh-dashed)';if(symbol==='402')return'url(#p-scattered-402)';if(symbol==='404')return'url(#p-scattered-404)';if(symbol==='407')return'url(#p-vertical-green-407)';if(symbol==='409')return'url(#p-vertical-green-409)';if(symbol==='412')return'url(#p-cultivated)';return colour(d.fill||'white')}
  function sampleLine(line,context,spacing,initialOffset=spacing/2){
    const points=line.map(p=>paperProject(p,context)),result=[];let next=initialOffset;
    for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],length=Math.hypot(b.x-a.x,b.y-a.y);while(next<=length){const t=next/length;result.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,angle:Math.atan2(b.y-a.y,b.x-a.x)});next+=spacing}next-=length}return result;
  }
  function vectorElements(feature,context){
    const symbol=symbolForFeature(feature),d=definition(symbol);if(!d)return[];const path=geometryPath(feature.geometry,context),f=factor(context.scale),elements=[],layer=name=>registry.colourOrder.indexOf(name);
    if(feature.geometry.type==='Point'){
      const p=paperProject(feature.geometry.coordinates,context),masked=['masked-ring','masked-point-cross'].includes(d.kind)||d.kind==='crossing-point'&&feature.properties?.breakBarrier,point=pointMarkup(symbol,{...context,map:{getCenter:()=>context.center,getZoom:()=>0},mode:'digital'},{...(feature.properties||{}),omitMask:masked}),markup=point.html.replace(/^<svg[^>]*>|<\/svg>$/g,'');
      const w=point.widthMm,h=point.heightMm,pad=Math.max(paperMm(d.supportStrokeMm||d.strokeWidthMm||.14,context.scale),.08);
      if(masked){const maskColour=d.maskColour||'white';let maskMarkup;if(d.kind==='masked-ring')maskMarkup=`<circle cx="0" cy="0" r="${paperMm(d.maskDiameterMm,context.scale)/2}" fill="${colour(maskColour)}"/>`;else if(d.kind==='crossing-point'){const mw=paperMm(d.maskWidthMm,context.scale),mh=Math.max(paperMm(d.strokeWidthMm,context.scale),paperMm(.3,context.scale)),rotation=-number(feature.properties?.angleDegrees)-number(context.declination);maskMarkup=`<rect x="${-mw/2}" y="${-mh/2}" width="${mw}" height="${mh}" fill="${colour(maskColour)}" transform="rotate(${rotation})"/>`}else{const mw=paperMm(d.maskWidthMm,context.scale),mh=paperMm(d.maskHeightMm,context.scale);maskMarkup=`<path d="M${-mw/2},${-mh/2} L${mw/2},${mh/2} M${mw/2},${-mh/2} L${-mw/2},${mh/2}" stroke="${colour(maskColour)}" stroke-width="${paperMm(d.maskStrokeWidthMm,context.scale)}"/>`}elements.push({layer:layer(maskColour),markup:`<svg x="${p.x-w/2-pad}" y="${p.y-h/2-pad}" width="${w+2*pad}" height="${h+2*pad}" viewBox="${-w/2-pad} ${-h/2-pad} ${w+2*pad} ${h+2*pad}" overflow="visible">${maskMarkup}</svg>`})}
      elements.push({layer:layer(d.colour||'black'),markup:`<svg x="${p.x-w/2-pad}" y="${p.y-h/2-pad}" width="${w+2*pad}" height="${h+2*pad}" viewBox="${-w/2-pad} ${-h/2-pad} ${w+2*pad} ${h+2*pad}" overflow="visible">${markup}</svg>`});return elements;
    }
    if(d.kind==='area'||d.kind==='pattern-area'||d.kind==='outline-area'){
      const showOutline=d.outline&&(!d.outlineConditional||feature.properties?.boundary==='clear'),large=d.largeThresholdMetres&&number(feature.properties?.maximumDimensionMetres)>=d.largeThresholdMetres,fill=large&&d.largeFill?colour(d.largeFill):areaFill(symbol,d),fillLayer=layer(large&&d.largeFill?d.largeFill:d.fill||d.patternColour||'white');elements.push({layer:fillLayer,markup:`<path d="${path}" fill="${fill}" fill-rule="evenodd"/>`});
      if(d.kind==='outline-area')elements.pop();
      const outlineDash=d.dashMm?` stroke-dasharray="${d.dashMm.map(value=>paperMm(value,context.scale)).join(' ')}"`:'';
      if(showOutline)elements.push({layer:layer(d.outline),markup:`<path d="${path}" fill="none" stroke="${colour(d.outline)}" stroke-width="${paperMm(d.outlineWidthMm,context.scale)}"${outlineDash} stroke-linejoin="round"/>`});return elements;
    }
    const stroke=name=>colour(name),lineWidth=value=>paperMm(value,context.scale),dash=d.kind==='dotted-line'?` stroke-dasharray="0 ${lineWidth(Math.max(0,(d.repeatMm||d.dotDiameterMm)-d.dotDiameterMm))}"`:d.dashMm?` stroke-dasharray="${d.dashMm.map(v=>paperMm(v,context.scale)).join(' ')}"`:'';
    if(d.kind==='cased-line'){
      const source=Math.max(0,number(feature.properties?.widthMetres||feature.properties?.renderWidthMetres||feature.properties?.estimatedWidthMetres))*1000/context.scale,inner=Math.max(paperMm(d.minimumInnerWidthMm,context.scale),source),outer=inner+2*paperMm(d.outlineWidthMm,context.scale);elements.push({layer:layer(d.outline),markup:`<g data-composite-symbol="${symbol}"><path d="${path}" fill="none" stroke="${stroke(d.outline)}" stroke-width="${outer}" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="${stroke(d.fill)}" stroke-width="${inner}" stroke-linejoin="round"/></g>`});return elements;
    }
    if(d.kind==='railway'){elements.push({layer:layer('black'),markup:`<g data-composite-symbol="${symbol}"><path d="${path}" fill="none" stroke="${stroke('black')}" stroke-width="${lineWidth(d.widthMm)}"/><path d="${path}" fill="none" stroke="white" stroke-width="${lineWidth(d.innerWidthMm)}" stroke-dasharray="${d.dashMm.map(v=>lineWidth(v)).join(' ')}"/></g>`});return elements}
    if(d.kind==='double-line-with-supports'){
      const offsetPath=direction=>coordinatesForGeometry(feature.geometry).map(line=>{
        const points=line.map(point=>paperProject(point,context)),offset=lineWidth(d.lineCentreGapMm)/2;
        return points.map((point,index)=>{const previous=points[Math.max(0,index-1)],next=points[Math.min(points.length-1,index+1)],dx=next.x-previous.x,dy=next.y-previous.y,length=Math.hypot(dx,dy)||1;return `${index?'L':'M'}${point.x-direction*dy/length*offset},${point.y+direction*dx/length*offset}`}).join(' ');
      }).join(' ');
      elements.push({layer:layer('black'),markup:`<g data-composite-symbol="${symbol}"><path d="${offsetPath(-1)}" fill="none" stroke="${stroke('black')}" stroke-width="${lineWidth(d.lineWidthMm)}"/><path d="${offsetPath(1)}" fill="none" stroke="${stroke('black')}" stroke-width="${lineWidth(d.lineWidthMm)}"/></g>`});return elements
    }
    if(d.kind==='stairway'){elements.push({layer:layer('black'),markup:`<g data-composite-symbol="${symbol}"><path d="${path}" fill="none" stroke="${stroke('black')}" stroke-width="${lineWidth(d.innerWidthMm+2*d.railWidthMm)}"/><path d="${path}" fill="none" stroke="white" stroke-width="${lineWidth(d.innerWidthMm)}"/></g>`});for(const line of coordinatesForGeometry(feature.geometry))for(const point of sampleLine(line,context,lineWidth(d.stepSpacingMm),lineWidth(d.stepSpacingMm)/2)){const angle=point.angle+Math.PI/2,len=lineWidth(d.innerWidthMm)/2,dx=Math.cos(angle)*len,dy=Math.sin(angle)*len;elements.push({layer:layer('black'),markup:`<path data-decoration-symbol="${symbol}" d="M${point.x-dx},${point.y-dy}L${point.x+dx},${point.y+dy}" stroke="${stroke('black')}" stroke-width="${lineWidth(d.stepWidthMm)}"/>`})}return elements}
    elements.push({layer:layer(d.colour||'black'),markup:`<path d="${path}" fill="none" stroke="${stroke(d.colour||'black')}" stroke-width="${lineWidth(d.widthMm||d.lineWidthMm||d.dotDiameterMm||.14)}"${dash} stroke-linecap="${d.kind==='dotted-line'?'round':'butt'}" stroke-linejoin="round"/>`});
    if(d.kind==='cliff'&&feature.properties?.downhillSide)for(const line of coordinatesForGeometry(feature.geometry))for(const point of sampleLine(line,context,paperMm(d.tagSpacingMm,context.scale))){const side=String(feature.properties.downhillSide).toLowerCase()==='right'||Number(feature.properties.downhillSide)>0?1:-1,angle=point.angle+side*Math.PI/2,len=lineWidth(d.tagLengthMm),dx=Math.cos(angle)*len,dy=Math.sin(angle)*len;elements.push({layer:layer(d.colour),markup:`<path d="M${point.x},${point.y}L${point.x+dx},${point.y+dy}" stroke="${stroke(d.colour)}" stroke-width="${lineWidth(d.tagWidthMm)}" stroke-linecap="round"/>`})}
    if(d.kind==='styled-line')for(const line of coordinatesForGeometry(feature.geometry)){
      const grouped=['grouped-dots','grouped-fence-tags','grouped-chevrons'].includes(d.style),spacing=lineWidth(grouped?d.groupSpacingMm:d.styleSpacingMm),offset=lineWidth(grouped?d.groupOffsetMm:(d.styleOffsetMm??d.styleSpacingMm/2)),centres=sampleLine(line,context,spacing,offset),within=lineWidth(d.withinGroupSpacingMm||0)/2,points=grouped?centres.flatMap(point=>[-within,within].map(distance=>({...point,x:point.x+Math.cos(point.angle)*distance,y:point.y+Math.sin(point.angle)*distance}))):centres;
      for(const point of points){
        if(['dots','grouped-dots'].includes(d.style))elements.push({layer:layer(d.colour),markup:`<circle data-decoration-symbol="${symbol}" cx="${point.x}" cy="${point.y}" r="${lineWidth(d.styleDiameterMm)/2}" fill="${stroke(d.colour)}"/>`});
        else if(d.style==='half-dots'&&feature.properties?.lowerSide){const side=feature.properties.lowerSide==='right'?1:-1,r=lineWidth(d.styleDiameterMm)/2,tangent={x:Math.cos(point.angle),y:Math.sin(point.angle)},normal={x:Math.cos(point.angle+side*Math.PI/2),y:Math.sin(point.angle+side*Math.PI/2)},center={x:point.x+normal.x*lineWidth(d.sideOffsetMm||0),y:point.y+normal.y*lineWidth(d.sideOffsetMm||0)},arc=[];for(let step=0;step<=8;step++){const a=Math.PI-step*Math.PI/8;arc.push({x:center.x+tangent.x*r*Math.cos(a)+normal.x*r*Math.sin(a),y:center.y+tangent.y*r*Math.cos(a)+normal.y*r*Math.sin(a)})}elements.push({layer:layer(d.colour),markup:`<path data-decoration-symbol="${symbol}" d="${arc.map((p,index)=>`${index?'L':'M'}${p.x},${p.y}`).join(' ')} Z" fill="${stroke(d.colour)}"/>`})}
        else if(['fence-tags','grouped-fence-tags'].includes(d.style)&&feature.properties?.tagSide){const side=feature.properties.tagSide==='right'?1:-1,angle=point.angle+side*Number(d.tagAngleDeg||60)*Math.PI/180,len=lineWidth(d.tagLengthMm),dx=Math.cos(angle)*len,dy=Math.sin(angle)*len;elements.push({layer:layer(d.colour),markup:`<path data-decoration-symbol="${symbol}" d="M${point.x},${point.y}L${point.x+dx},${point.y+dy}" stroke="${stroke(d.colour)}" stroke-width="${lineWidth(d.tagWidthMm)}" stroke-linecap="butt"/>`})}
        else if(['chevrons','grouped-chevrons'].includes(d.style)){const len=lineWidth(d.tagLengthMm),angle=Number(d.tagAngleDeg||45)*Math.PI/180;for(const direction of [-1,1]){const arm=point.angle+Math.PI+direction*angle,dx=Math.cos(arm)*len,dy=Math.sin(arm)*len;elements.push({layer:layer(d.colour),markup:`<path data-decoration-symbol="${symbol}" d="M${point.x},${point.y}L${point.x+dx},${point.y+dy}" stroke="${stroke(d.colour)}" stroke-width="${lineWidth(d.tagWidthMm)}" stroke-linecap="butt"/>`})}}
      }
    }
    return elements;
  }
  function buildVectorSvg(features,options){
    const context={...options,scale:number(options.scale)||10000,declination:number(options.declination),center:{lat:number(options.center.lat),lng:number(options.center.lng)},widthMm:number(options.widthMm),heightMm:number(options.heightMm)},groups=registry.colourOrder.map(()=>[]),north=registry.technical['601'],spacing=north.spacingGroundMetres*1000/context.scale,northWidth=paperMm(north.preferredColour==='blue'?north.lineWidthBlueMm:north.lineWidthBlackMm,context.scale),northColour=colour(north.preferredColour);
    for(let x=context.widthMm/2%spacing;x<context.widthMm;x+=spacing)groups[registry.colourOrder.indexOf(north.preferredColour)].push(`<path d="M${x},0V${context.heightMm}" stroke="${northColour}" stroke-width="${northWidth}"/>`);
    for(let x=context.widthMm/2%spacing-spacing;x>=0;x-=spacing)groups[registry.colourOrder.indexOf(north.preferredColour)].push(`<path d="M${x},0V${context.heightMm}" stroke="${northColour}" stroke-width="${northWidth}"/>`);
    const orderedFeatures=[...(features||[])].sort((a,b)=>(symbolForFeature(a)==='519'?1:0)-(symbolForFeature(b)==='519'?1:0));
    for(const feature of orderedFeatures){const bounds=paperBounds(feature.geometry,context);if(bounds&&(bounds.right<0||bounds.bottom<0||bounds.left>context.widthMm||bounds.top>context.heightMm))continue;for(const item of vectorElements(feature,context))groups[Math.max(0,item.layer)].push(item.markup);const label=feature.properties?.mapText,labelCoordinate=feature.properties?.labelCoordinate;if(label&&Array.isArray(labelCoordinate)){const p=paperProject(labelCoordinate,context),height=paperMm(feature.properties?.textHeightMm||registry.textRules.minimumSansHeightMm,context.scale);groups[registry.colourOrder.indexOf(feature.properties?.textColour||'black')].push(`<text x="${p.x}" y="${p.y}" font-family="${svgEscape(registry.textRules.fontFamily)}" font-size="${height}" text-anchor="middle" data-orientation="magnetic-north">${svgEscape(label)}</text>`)}}
    const content=groups.map((items,index)=>items.length?`<g data-colour="${registry.colourOrder[index]}" style="mix-blend-mode:${registry.overprint.previewBlendMode}">${items.join('')}</g>`:'').join('');
    return`<svg xmlns="${NS}" viewBox="0 0 ${context.widthMm} ${context.heightMm}" width="${context.widthMm}mm" height="${context.heightMm}mm" role="img" aria-label="Normstyrd orienteringskarta"><metadata>${svgEscape(JSON.stringify({standard:registry.standard,symbolRegistryVersion:registry.registryVersion,scale:context.scale,declination:context.declination,colourSpace:'IOF CMYK definitions with RGB screen preview'}))}</metadata><defs><clipPath id="map-clip"><rect width="${context.widthMm}" height="${context.heightMm}"/></clipPath>${patternDefs(context.scale)}</defs><rect width="100%" height="100%" fill="white"/><g clip-path="url(#map-clip)">${content}</g></svg>`;
  }
  root.OMAPMAKER_ISOM_RENDERER={definition,factor,paperMm,pixelsPerPaperMm,lineStyles,areaStyle,pointMarkup,preflight,buildVectorSvg,paperProject,geometryPath,colour};
})(window);
