// Public media only. Never upload source folders wholesale (they can contain secrets).
import {readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {crc32, inflateSync} from 'node:zlib';
import {put, head} from '@vercel/blob';

const root = resolve(process.env.NFT_ART_ROOT || '/Users/stacc/10k');
const out = resolve('artifacts/nft-publication');
const denominations = [1,2,5,10,20,50,100];
const sha = data => createHash('sha256').update(data).digest('hex');
const description = d => `Money Doubler $${d}: cartoon giveaway-scam parody art. This deltaLP edition uses an NFT-owned ERC-6551 account for delta-neutral strategy receipts. Account assets can be withdrawn by the current NFT owner; inspect current holdings before buying. The denomination is an art/mint-price target, not a dollar peg or redemption guarantee. No doubling, yield or risk-free return is promised.`;
mkdirSync(out,{recursive:true});
const lock = join(out,'publisher.lock');
// An existing lock requires checking that its PID is no longer running before removing it.
const fd = openSync(lock,'wx'); writeFileSync(fd,String(process.pid)); closeSync(fd);
process.on('exit',()=>{if(existsSync(lock))unlinkSync(lock);});
process.on('SIGINT',()=>process.exit(130));
process.on('SIGTERM',()=>process.exit(143));
function pngValid(b) {
  if(b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid PNG signature');
  let offset=8, ended=false; const idat=[];
  while(offset+12<=b.length){
    const length=b.readUInt32BE(offset),end=offset+8+length;
    if(end+4>b.length||crc32(b.subarray(offset+4,end))!==b.readUInt32BE(end))throw Error('PNG CRC/truncation');
    const type=b.toString('ascii',offset+4,offset+8);
    if(offset===8&&(type!=='IHDR'||!b.readUInt32BE(offset+8)||!b.readUInt32BE(offset+12)))throw Error('Invalid dimensions');
    if(type==='IDAT')idat.push(b.subarray(offset+8,end));
    offset=end+4;
    if(type==='IEND'){ended=true;break;}
  }
  if(!ended||offset!==b.length||!idat.length)throw Error('Incomplete PNG');
  inflateSync(Buffer.concat(idat),{maxOutputLength:64*1024*1024});
}
async function retry(fn){
  for(let i=0;;i++)try{return await fn();}catch(e){
    if(i===6)throw e;
    await new Promise(r=>setTimeout(r,Math.min(30000,1000*2**i)+Math.random()*500));
  }
}
async function publish(path,body,type) {
  return retry(async()=>{
    try{return await put(path,body,{access:'public',addRandomSuffix:false,allowOverwrite:false,contentType:type,cacheControlMaxAge:31536000});}
    catch(e){
      if(!String(e.message).includes('already exists'))throw e;
      const existing=await head(path);
      const r=await fetch(existing.url,{signal:AbortSignal.timeout(30000)});
      if(!r.ok||sha(Buffer.from(await r.arrayBuffer()))!==sha(body))throw Error('Immutable path content mismatch');
      return existing;
    }
  });
}
const journal=join(out,'uploaded.jsonl');
const done=new Map();
if(existsSync(journal))for(const line of readFileSync(journal,'utf8').trim().split('\n').filter(Boolean)){
  const row=JSON.parse(line);done.set(`${row.denomination}:${row.id}:${row.sourceHash}`,row);
}
let uploaded=0,verified=0;
const tick=setInterval(()=>console.log(JSON.stringify({at:new Date().toISOString(),uploaded,verified,resumed:done.size})),30000);
const summaries=[];
const completed=existsSync(join(out,'editions.json'))?JSON.parse(readFileSync(join(out,'editions.json'),'utf8')):[];
const uploadConcurrency=Number(process.env.NFT_UPLOAD_CONCURRENCY||32);
if(!Number.isSafeInteger(uploadConcurrency)||uploadConcurrency<1||uploadConcurrency>128)throw Error('Upload concurrency must be 1–128');
try {
  for(const denomination of denominations){
    const source=[];const traits=new Set();
    console.log(`Checking PNG integrity and provenance: $${denomination}`);
    for(let id=1;id<=10000;id++){
      const png=readFileSync(join(root,String(denomination),'png',`${id}.png`));pngValid(png);
      const metadata=readFileSync(join(root,String(denomination),'metadata',`${id}.json`));
      const parsed=JSON.parse(metadata);
      if(!parsed.name||!Array.isArray(parsed.attributes)||parsed.attributes.find(x=>x.trait_type==='Denomination')?.value!==`$${denomination}`)throw Error(`Invalid metadata ${denomination}/${id}`);
      const combination=JSON.stringify(parsed.attributes);
      if(traits.has(combination))throw Error(`Duplicate traits ${denomination}/${id}`);traits.add(combination);
      source.push({id,imageSha256:sha(png),sourceMetadataSha256:sha(metadata),bytes:png.length});
    }
    const sourceHash=sha(JSON.stringify(source));
    const prefix=`editions/${denomination}/${sourceHash}`;
    writeFileSync(join(out,`${denomination}-source.json`),JSON.stringify({denomination,sourceHash,source}));
    const prior=completed.find(x=>x.denomination===denomination&&x.sourceHash===sourceHash&&x.count===10000);
    if(prior&&source.every(x=>done.has(`${denomination}:${x.id}:${sourceHash}`))){
      // Preserve the original verification timestamp. Recheck the published
      // manifest, which commits every previously verified metadata/image hash.
      await retry(async()=>{
        const r=await fetch(prior.manifest,{signal:AbortSignal.timeout(30000)});
        if(!r.ok||`0x${sha(Buffer.from(await r.arrayBuffer()))}`!==prior.provenanceHash)throw Error('Completed manifest verification failed');
      });
      summaries.push(prior);verified+=10000;
      console.log(`Resumed verified edition $${denomination}`);continue;
    }
    let next=0;const rows=new Array(10000);
    await Promise.all(Array.from({length:uploadConcurrency},async()=>{
      while(next<source.length){
        const item=source[next++],id=item.id,key=`${denomination}:${id}:${sourceHash}`;
        if(done.has(key)){rows[id-1]=done.get(key);continue;}
        const png=readFileSync(join(root,String(denomination),'png',`${id}.png`));
        const original=readFileSync(join(root,String(denomination),'metadata',`${id}.json`));
        if(sha(png)!==item.imageSha256||sha(original)!==item.sourceMetadataSha256)throw Error('Source changed during publication');
        const image=await publish(`${prefix}/images/${id}.png`,png,'image/png');
        const metadata=Buffer.from(JSON.stringify({...JSON.parse(original),description:description(denomination),image:image.url,external_url:'https://deltalp.fun/#nft-editions'}));
        // tokenURI is baseURI + decimal token ID, with no extension.
        const token=await publish(`${prefix}/metadata/${id}`,metadata,'application/json');
        const row={denomination,id,sourceHash,image:image.url,metadata:token.url,imageSha256:item.imageSha256,metadataSha256:sha(metadata),bytes:item.bytes};
        appendFileSync(journal,JSON.stringify(row)+'\n');done.set(key,row);rows[id-1]=row;uploaded++;
      }
    }));
    // Read every metadata body and HEAD every referenced image from the public CDN.
    next=0;
    await Promise.all(Array.from({length:Math.min(96,uploadConcurrency*2)},async()=>{
      while(next<rows.length){const row=rows[next++];await retry(async()=>{
        const r=await fetch(row.metadata,{signal:AbortSignal.timeout(30000)});
        if(!r.ok||!r.headers.get('content-type')?.includes('application/json'))throw Error('Metadata HTTP/content type failed');
        const body=Buffer.from(await r.arrayBuffer());
        if(sha(body)!==row.metadataSha256||JSON.parse(body).image!==row.image)throw Error('Metadata content verification failed');
        const i=await fetch(row.image,{method:'HEAD',signal:AbortSignal.timeout(30000)});
        if(!i.ok||i.headers.get('content-type')!=='image/png'||Number(i.headers.get('content-length'))!==row.bytes)throw Error('Image URL verification failed');
        // Full remote image checksum for evenly spaced samples, including endpoints.
        if(row.id===1||row.id===10000||row.id%1000===0){const full=await fetch(row.image,{signal:AbortSignal.timeout(30000)});if(!full.ok||sha(Buffer.from(await full.arrayBuffer()))!==row.imageSha256)throw Error('Remote PNG checksum mismatch');}
      });verified++;}
    }));
    const collection=await publish(`${prefix}/collection.json`,Buffer.from(JSON.stringify({name:`Money Doubler $${denomination}`,description:description(denomination),image:rows[0].image,external_link:'https://deltalp.fun/#nft-editions',seller_fee_basis_points:1000,fee_recipient:'0xBfac70063f04e116F5a509cC746BEeb2F053467D'})),'application/json');
    const provenance=Buffer.from(JSON.stringify({version:1,denomination,sourceHash,records:rows}));
    const manifest=await publish(`${prefix}/manifest.json`,provenance,'application/json');
    const summary={denomination,count:rows.length,sourceHash,provenanceHash:`0x${sha(provenance)}`,baseURI:rows[0].metadata.replace(/1$/,''),contractURI:collection.url,preview:rows[0].image,manifest:manifest.url,verifiedAt:new Date().toISOString(),verification:'All metadata GET/hash + all image HEAD/size; 11 image GET/hash samples per edition'};
    summaries.push(summary);writeFileSync(join(out,'editions.json'),JSON.stringify(summaries,null,2));
    console.log(JSON.stringify({editionComplete:summary}));
  }
  console.log('All 70,000 metadata/image URL pairs published and verified.');
} finally {clearInterval(tick);}
