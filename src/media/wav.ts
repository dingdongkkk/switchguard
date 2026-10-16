/** Each call emits a complete, independent mono PCM16 RIFF/WAV. No transcoding or trimming. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Unsupported sample rate');
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  text(0,'RIFF'); view.setUint32(4,36+samples.length*2,true); text(8,'WAVE'); text(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  text(36,'data'); view.setUint32(40,samples.length*2,true);
  samples.forEach((sample,i)=>{ const v=Number.isFinite(sample)?Math.max(-1,Math.min(1,sample)):0;view.setInt16(44+i*2,v<0?v*32768:v*32767,true); });
  return new Uint8Array(buffer);
}
/** Narrow server boundary: only this canonical WAV layout is accepted.
 * Future uploads must be fully decoded/validated, not trusted by extension/MIME. */
export function inspectWav(bytes: Uint8Array) {
  if (bytes.byteLength < 46) throw new Error('Missing or truncated WAV audio');
  const v = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const text = (a:number,b:number)=>String.fromCharCode(...bytes.slice(a,b));
  if (text(0,4)!=='RIFF'||text(8,12)!=='WAVE'||text(12,16)!=='fmt '||text(36,40)!=='data'||v.getUint32(16,true)!==16||v.getUint16(20,true)!==1||v.getUint16(22,true)!==1||v.getUint16(34,true)!==16) throw new Error('Only canonical mono PCM16 WAV from the capture module is accepted');
  const sampleRate=v.getUint32(24,true), dataBytes=v.getUint32(40,true);
  if(sampleRate<8000||sampleRate>192000||v.getUint32(4,true)!==bytes.length-8||dataBytes!==bytes.length-44||dataBytes%2!==0||v.getUint16(32,true)!==2||v.getUint32(28,true)!==sampleRate*2) throw new Error('Invalid WAV lengths or format');
  return {sampleRate,sampleCount:dataBytes/2,durationMs:dataBytes/2/sampleRate*1000};
}
export interface PcmClip { samples: Float32Array<ArrayBuffer>; sampleRate: number; startMs: number; endMs: number; final: boolean }
export class PcmWindowAssembler {
  private parts: Float32Array[]=[]; private count=0; private startMs=0; private expectedMs?:number;
  readonly targetSamples:number;
  constructor(readonly sampleRate:number, windowMs:number, private emit:(clip:PcmClip)=>void, private gap:(startMs:number,endMs:number)=>void) {
    if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000)throw new Error('Unsupported sample rate');
    if(!Number.isFinite(windowMs)||windowMs<=4000||windowMs>60000)throw new Error('Analysis windows must be >4 and <=60 seconds');
    this.targetSamples=Math.round(windowMs*sampleRate/1000);
  }
  push(samples:Float32Array,startMs:number) {
    if(!Number.isFinite(startMs)||startMs<0)throw new Error('Invalid PCM timestamp');
    if(this.expectedMs!==undefined&&Math.abs(startMs-this.expectedMs)>30) {
      this.flush(true);this.gap(Math.min(this.expectedMs,startMs),Math.max(this.expectedMs,startMs));
      if(startMs<this.expectedMs)throw new Error('PCM clock moved backward; restart capture with a fresh time anchor');
    }
    let cursor=0;
    while(cursor<samples.length) {
      if(this.count===0)this.startMs=startMs+cursor/this.sampleRate*1000;
      const length=Math.min(this.targetSamples-this.count,samples.length-cursor);
      this.parts.push(samples.slice(cursor,cursor+length));this.count+=length;cursor+=length;
      if(this.count===this.targetSamples)this.flush(false);
    }
    this.expectedMs=startMs+samples.length/this.sampleRate*1000;
  }
  flush(final=true) {if(!this.count)return;const samples=new Float32Array(this.count);let offset=0;for(const p of this.parts){samples.set(p,offset);offset+=p.length;}
    const clip={samples,sampleRate:this.sampleRate,startMs:this.startMs,endMs:this.startMs+this.count/this.sampleRate*1000,final};this.parts=[];this.count=0;this.emit(clip);}
}
