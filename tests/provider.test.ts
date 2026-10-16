import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BoundedQueue, DetectifClient, normalizeCombined, retryDelay, type ProviderResponse} from '../src/server/detectif.js';
import {fixtureWindow} from './fixtures.js';
const response=(body:Record<string,any>,status=200):ProviderResponse=>({body,status,attempts:1,submittedAtEpochMs:0,respondedAtEpochMs:1,requestId:'req_header'});
const speaker={decision:'match',similarity:.8,threshold:.53};
test('combined success uses final verdict, maps segments and keeps IDs/model/raw',()=>{
  const raw=response({result:speaker,operation_id:'op_voice',model:{name:'voice',version:'v1'},deepfake:{verdict:'real',score:.99,operation_id:'op_fake',model:{name:'fake',version:'v2'},config_version:'cfg',segments:[{start:1,end:5,score:.99},{start:6,end:30,score:.7}]}});
  const r=normalizeCombined(raw,fixtureWindow('w1',10000),18000);
  assert.equal(r.authenticity.status,'complete');if(r.authenticity.status==='complete'){assert.equal(r.authenticity.verdict,'real');assert.deepEqual(r.authenticity.segments.map(s=>[s.startMs,s.endMs]),[[11000,15000],[16000,17000]]);assert.equal(r.authenticity.provider.operationId,'op_fake');assert.equal(r.authenticity.provider.configVersion,'cfg');}
  assert.equal(r.speaker.provider.requestId,'req_header');assert.equal(r.raw,raw);
});
test('embedded deepfake error preserves completed speaker check',()=>{
  const r=normalizeCombined(response({result:speaker,deepfake:{operation_id:'op_failed',error:{code:'insufficient_credits',message:'No credits'}}}),fixtureWindow(),8000);
  assert.equal(r.speaker.status,'complete');assert.equal(r.authenticity.status,'failed');assert.equal(r.authenticity.provider.operationId,'op_failed');
});
test('verification error with deepfake partial survives non-2xx status',()=>{
  const r=normalizeCombined(response({error:{code:'insufficient_speech',message:'Not enough speech'},partial:{verdict:'fake',operation_id:'op_partial',segments:[]}},422),fixtureWindow(),8000);
  assert.equal(r.speaker.status,'inconclusive');assert.equal(r.authenticity.status,'complete');if(r.authenticity.status==='complete')assert.equal(r.authenticity.verdict,'fake');
});
test('missing or malformed success cannot become positive',()=>{
  const r=normalizeCombined(response({result:{decision:'match',similarity:'80%',threshold:.53},deepfake:{label:'genuine',score:.01}}),fixtureWindow(),8000);
  assert.notEqual(r.speaker.status,'complete');assert.notEqual(r.authenticity.status,'complete');
});
test('null segment data is ignored without losing verdict',()=>{
  const r=normalizeCombined(response({result:speaker,deepfake:{verdict:'real',segments:[null,7,{}, {start:0,end:2,score:.1}]}}),fixtureWindow(),8000);
  assert.equal(r.authenticity.status,'complete');if(r.authenticity.status==='complete')assert.equal(r.authenticity.segments.length,1);
});
test('retry honors Retry-After and reuses the key and combined-check field',async()=>{
  const calls:RequestInit[]=[],delays:number[]=[];
  const fetcher=async(_url:unknown,init?:RequestInit)=>{calls.push(init!);return calls.length===1?new Response(JSON.stringify({error:{code:'server_busy'}}),{status:503,headers:{'retry-after':'2'}}):new Response(JSON.stringify({result:speaker}),{status:200});};
  const client=new DetectifClient('server-secret',fetcher as typeof fetch,async ms=>{delays.push(ms);});
  const result=await client.verify('original',new Uint8Array([1,2]),'same-logical-key');
  assert.equal(result.attempts,2);assert.deepEqual(delays,[2000]);
  assert.equal((calls[0]!.headers as Record<string,string>)['Idempotency-Key'],(calls[1]!.headers as Record<string,string>)['Idempotency-Key']);
  assert.equal((calls[0]!.body as FormData).get('detect_deepfake'),'true');assert.equal((calls[0]!.body as FormData).get('speaker_id'),'original');
});
test('retry budget is finite; long Retry-After never causes an early retry',async()=>{
  let calls=0;const client=new DetectifClient('token',(async()=>{calls++;return new Response('{}',{status:503,headers:{'retry-after':'90'}});}) as typeof fetch,async()=>{throw new Error('Must not wait/retry early');});
  assert.equal((await client.verify('s',new Uint8Array([1]))).status,503);assert.equal(calls,1);
  calls=0;const capped=new DetectifClient('token',(async()=>{calls++;return new Response('{}',{status:500});}) as typeof fetch,async()=>{});
  assert.equal((await capped.verify('s',new Uint8Array([1]))).attempts,3);assert.equal(calls,3);
  assert.equal(retryDelay('Thu, 01 Jan 1970 00:00:03 GMT',0,1000),2000);
});
test('401/402/415 do not retry',async()=>{for(const status of [401,402,415]){let n=0;const c=new DetectifClient('token',(async()=>{n++;return new Response('{}',{status});}) as typeof fetch);await c.verify('s',new Uint8Array([1]));assert.equal(n,1);}});
test('bounded queue rejects overload and releases slots',async()=>{
  const q=new BoundedQueue(1,1);let release!:()=>void;const a=q.run(()=>new Promise<void>(r=>{release=r;}));const b=q.run(async()=>2);
  await assert.rejects(q.run(async()=>3),{code:'queue_full'});assert.deepEqual(q.stats,{active:1,waiting:1,concurrency:1,maxWaiting:1});release();await a;assert.equal(await b,2);assert.equal(q.stats.active,0);
});
