import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {put} from '@vercel/blob';
const sha=data=>createHash('sha256').update(data).digest('hex');
const records=JSON.parse(readFileSync('artifacts/nft-publication/editions.json','utf8'));
const denominations=[1,2,5,10];
const editions=denominations.map(d=>records.find(r=>r.denomination===d));
if(editions.some(e=>!e||e.count!==10000||!e.verifiedAt))throw Error('Four verified editions required');
for(const edition of editions){
 const r=await fetch(edition.manifest,{signal:AbortSignal.timeout(30000)});
 if(!r.ok||`0x${sha(Buffer.from(await r.arrayBuffer()))}`!==edition.provenanceHash)throw Error('Publication manifest mismatch');
}
const catalog={version:1,chainId:4663,denominations,supplyPerEdition:10000,totalNFTs:40000,totalWeight:180000,
 editions,deferredDenominations:[20,50,100],scope:'Published artwork and metadata only; deployment and funded readiness are separate.'};
const body=Buffer.from(JSON.stringify(catalog,null,2));
const hash=sha(body);
const blob=await put(`launches/four-editions/${hash}/catalog.json`,body,{access:'public',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json',cacheControlMaxAge:31536000});
const remote=await fetch(blob.url,{signal:AbortSignal.timeout(30000)});
if(!remote.ok||sha(Buffer.from(await remote.arrayBuffer()))!==hash)throw Error('Catalog readback failed');
mkdirSync('public',{recursive:true});
writeFileSync('public/nft-editions.json',JSON.stringify({...catalog,catalogURI:blob.url},null,2)+'\n');
console.log(JSON.stringify({catalog:blob.url,editions:4,verifiedMetadata:40000,verifiedImageUrls:40000}));
