import type { Interval } from '../shared/contracts.js';
export interface MediaChunk extends Interval { id: string; blob: Blob; mimeType: string }
/** Temporary bounded store; eviction is explicit to the caller. It is not retained evidence. */
export class ContextBuffer {
  private chunks: MediaChunk[]=[];
  constructor(readonly maxAgeMs=120_000, readonly maxBytes=32*1024*1024) {}
  get byteLength(){return this.chunks.reduce((sum,c)=>sum+c.blob.size,0);}
  add(chunk:MediaChunk):string[]{
    if(chunk.endMs<=chunk.startMs)throw new Error('Invalid media interval');
    this.chunks.push(chunk);this.chunks.sort((a,b)=>a.startMs-b.startMs);
    return this.evict(Math.max(...this.chunks.map(c=>c.endMs)));
  }
  evict(nowMs:number):string[]{const evicted:string[]=[];while(this.chunks.length&&(this.chunks[0]!.endMs<nowMs-this.maxAgeMs||this.byteLength>this.maxBytes)){evicted.push(this.chunks.shift()!.id);}return evicted;}
  context(interval:Interval,paddingMs=3000,nowMs=interval.endMs){
    this.evict(nowMs);const requested={startMs:Math.max(0,interval.startMs-paddingMs),endMs:interval.endMs+paddingMs};
    const clips=this.chunks.filter(c=>c.endMs>requested.startMs&&c.startMs<requested.endMs);
    const gaps:Interval[]=[];let cursor=requested.startMs;
    for(const c of clips){if(c.startMs>cursor)gaps.push({startMs:cursor,endMs:Math.min(c.startMs,requested.endMs)});cursor=Math.max(cursor,c.endMs);}
    if(cursor<requested.endMs)gaps.push({startMs:cursor,endMs:requested.endMs});
    return {requested,clips,gaps,complete:gaps.length===0};
  }
  clear(){this.chunks=[];}
}
