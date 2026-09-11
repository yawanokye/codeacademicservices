'use strict';

const fs = require('fs');
const zlib = require('zlib');

function parseJpeg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('Invalid JPEG image.');
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = buffer.readUInt16BE(offset);
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      const height = buffer.readUInt16BE(offset + 3), width = buffer.readUInt16BE(offset + 5), components = buffer[offset + 7];
      if (!width || !height || ![1,3].includes(components)) throw new Error('Unsupported JPEG signature image.');
      return { width, height, components, data:buffer };
    }
    offset += length;
  }
  throw new Error('JPEG dimensions could not be read.');
}

function paeth(a,b,c) {
  const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
  return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
}

function parsePng(buffer) {
  const signature=Buffer.from([137,80,78,71,13,10,26,10]);
  if (!Buffer.isBuffer(buffer) || buffer.length<33 || !buffer.subarray(0,8).equals(signature)) throw new Error('Invalid PNG image.');
  let offset=8,width=0,height=0,bitDepth=0,colourType=0,interlace=0;const idat=[];
  while(offset+12<=buffer.length){
    const length=buffer.readUInt32BE(offset),type=buffer.toString('ascii',offset+4,offset+8),data=buffer.subarray(offset+8,offset+8+length);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);bitDepth=data[8];colourType=data[9];interlace=data[12];}
    else if(type==='IDAT')idat.push(data);
    else if(type==='IEND')break;
    offset+=12+length;
  }
  if(!width||!height||bitDepth!==8||![2,6].includes(colourType)||interlace!==0)throw new Error('Use a non-interlaced 8-bit RGB or RGBA PNG signature image.');
  const source=zlib.inflateSync(Buffer.concat(idat)),bpp=colourType===6?4:3,stride=width*bpp;
  if(source.length!==(stride+1)*height)throw new Error('PNG signature data is incomplete.');
  const decoded=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){
    const sourceRow=y*(stride+1),targetRow=y*stride,filter=source[sourceRow];
    for(let x=0;x<stride;x++){
      const raw=source[sourceRow+1+x],left=x>=bpp?decoded[targetRow+x-bpp]:0,up=y?decoded[targetRow-stride+x]:0,upLeft=y&&x>=bpp?decoded[targetRow-stride+x-bpp]:0;
      decoded[targetRow+x]=(raw+(filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,upLeft):NaN))&255;
      if(filter>4)throw new Error('Unsupported PNG filter.');
    }
  }
  const rgb=Buffer.alloc(width*height*3);
  for(let src=0,dst=0;src<decoded.length;src+=bpp,dst+=3){
    if(bpp===3){rgb[dst]=decoded[src];rgb[dst+1]=decoded[src+1];rgb[dst+2]=decoded[src+2];continue;}
    const alpha=decoded[src+3]/255;
    rgb[dst]=Math.round(decoded[src]*alpha+255*(1-alpha));rgb[dst+1]=Math.round(decoded[src+1]*alpha+255*(1-alpha));rgb[dst+2]=Math.round(decoded[src+2]*alpha+255*(1-alpha));
  }
  return {width,height,components:3,data:zlib.deflateSync(rgb)};
}

function pdfEscape(value){return String(value??'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[\r\n]+/g,' ');}
function ascii(value){return String(value??'').normalize('NFKD').replace(/[^\x20-\x7E]/g,' ');}
function wrap(value,max=82){
  const words=ascii(value).trim().split(/\s+/).filter(Boolean),lines=[];let line='';
  for(const word of words){const candidate=line?`${line} ${word}`:word;if(candidate.length>max&&line){lines.push(line);line=word;}else line=candidate;}
  if(line)lines.push(line);return lines.length?lines:[''];
}

function createApprovalPdf({signaturePath,data={}}={}) {
  const signatureBuffer=fs.readFileSync(signaturePath);let image,imageDictionary;
  if(signatureBuffer[0]===0xff&&signatureBuffer[1]===0xd8){image=parseJpeg(signatureBuffer);imageDictionary=`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.components===1?'DeviceGray':'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode`;}
  else{image=parsePng(signatureBuffer);imageDictionary=`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`;}
  const objects=[];const add=body=>{objects.push(Buffer.isBuffer(body)?body:Buffer.from(body));return objects.length;};
  const regular=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const bold=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const imageObject=add(Buffer.concat([Buffer.from(`<< ${imageDictionary} /Length ${image.data.length} >>\nstream\n`),image.data,Buffer.from('\nendstream')]));
  const commands=[];let y=796;
  const text=(value,{size=10,font='R',x=52,leading=size+4,colour='0.08 0.17 0.26'}={})=>{for(const line of wrap(value,Math.max(20,Math.floor((535-x)/(size*.52))))){commands.push(`BT /F${font} ${size} Tf ${colour} rg ${x} ${y} Td (${pdfEscape(line)}) Tj ET`);y-=leading;}};
  const rule=()=>{commands.push(`0.80 0.85 0.89 RG 0.8 w 52 ${y} m 543 ${y} l S`);y-=15;};
  text('UNIVERSITY OF CAPE COAST',{size:15,font:'B',colour:'0.03 0.17 0.30',leading:19});
  text('COLLEGE OF DISTANCE EDUCATION',{size:11,font:'B',colour:'0.70 0.48 0.05',leading:20});
  text('ELECTRONIC CLAIM APPROVAL FOR PAYMENT',{size:16,font:'B',colour:'0.03 0.17 0.30',leading:26});rule();
  const field=(label,value)=>{text(label,{size:8,font:'B',colour:'0.35 0.42 0.48',leading:11});text(value||'Not recorded',{size:10,font:'R',leading:17});};
  field('CLAIM REFERENCE',data.reference);field('ACTIVITY',data.workType);field('DEPARTMENT',data.department);field('CLAIMANT',`${data.claimantName||''}${data.staffId?` | ${data.staffId}`:''}${data.claimantEmail?` | ${data.claimantEmail}`:''}`);rule();
  text('PAYMENT DECISION',{size:11,font:'B',leading:17});
  field('QUANTITY',`${data.approvedQuantity||0} approved for payment out of ${data.claimedQuantity||0} claimed (${data.paymentType||'Payment decision'})`);
  if(data.adjustmentReason)field('RECONCILIATION / PART-PAYMENT REASON',data.adjustmentReason);
  const approvedUnits=Array.isArray(data.approvedUnits)?data.approvedUnits:[];
  if(approvedUnits.length){field('APPROVED ITEMS',approvedUnits.slice(0,8).join('; ')+(approvedUnits.length>8?`; plus ${approvedUnits.length-8} additional item(s) recorded in the audit history.`:''));}
  rule();
  text('CLAIMANT ELECTRONIC CERTIFICATION',{size:11,font:'B',leading:17});text(data.claimantCertification||'Not recorded',{size:9,leading:14});y-=3;rule();
  text('HEAD OF DEPARTMENT APPROVAL',{size:11,font:'B',leading:17});field('APPROVED BY',`${data.hodName||''}${data.hodEmail?` | ${data.hodEmail}`:''}`);field('APPROVAL DATE AND TIME',data.approvedAt);y-=3;
  const maxWidth=165,maxHeight=58,scale=Math.min(maxWidth/image.width,maxHeight/image.height,1),drawWidth=Math.max(40,image.width*scale),drawHeight=Math.max(15,image.height*scale);
  commands.push(`q ${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} 52 ${(y-drawHeight).toFixed(2)} cm /Im1 Do Q`);y-=drawHeight+14;text('Protected HoD signature image',{size:8,colour:'0.35 0.42 0.48',leading:15});rule();
  field('VERIFICATION CODE',data.verificationCode);text(`Verify at: ${data.verificationUrl||''}`,{size:9,leading:14});text(`Source fingerprint: ${String(data.sourceFingerprint||'').slice(0,32)}...`,{size:8,colour:'0.35 0.42 0.48',leading:12});
  y=Math.max(36,y-8);text('The original uploaded claim remains unchanged. Later claim or approved-data alterations invalidate this approval and require a fresh HoD decision.',{size:8,leading:11,colour:'0.35 0.42 0.48'});
  const stream=Buffer.from(commands.join('\n'));
  const content=add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]));
  const page=add(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 595 842] /Resources << /Font << /FR ${regular} 0 R /FB ${bold} 0 R >> /XObject << /Im1 ${imageObject} 0 R >> >> /Contents ${content} 0 R >>`);
  const pages=add(`<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  objects[page-1]=Buffer.from(objects[page-1].toString().replace('PAGES_REF',`${pages} 0 R`));
  const catalog=add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  const info=add(`<< /Title (${pdfEscape(`Approved claim ${data.reference||''}`)}) /Author (${pdfEscape(data.hodName||'University of Cape Coast')}) /Subject (Electronic approval for payment) /Creator (CoDE Academic Services Portal) >>`);
  const header=Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n','binary'),parts=[header],offsets=[0];let position=header.length;
  objects.forEach((body,index)=>{offsets.push(position);const block=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),body,Buffer.from('\nendobj\n')]);parts.push(block);position+=block.length;});
  const xref=position;let table=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)table+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  parts.push(Buffer.from(table),Buffer.from(`trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

module.exports={createApprovalPdf,parsePng,parseJpeg};
