import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, inspectWav, PcmWindowAssembler, type PcmClip } from '../src/media/wav.js';
import { ContextBuffer } from '../src/media/context-buffer.js';

test('each assembled window is independently decodable and preserves the session clock', () => {
  const clips: PcmClip[] = [];
  const assembler = new PcmWindowAssembler(16000, 7000, clip => clips.push(clip), () => assert.fail('unexpected gap'));
  // One incoming block crosses two output boundaries and leaves a short final fragment.
  assembler.push(new Float32Array(16000 * 16), 12000);
  assembler.flush();
  assert.deepEqual(clips.map(c => [c.startMs, c.endMs, c.final]), [[12000, 19000, false], [19000, 26000, false], [26000, 28000, true]]);
  for (const clip of clips) {
    const wav = inspectWav(encodeWav(clip.samples, clip.sampleRate));
    assert.equal(wav.durationMs, clip.endMs - clip.startMs);
    assert.equal(wav.sampleCount, clip.samples.length);
  }
});

test('WAV validation rejects truncation and inconsistent format fields', () => {
  const bytes = encodeWav(new Float32Array(16000), 16000);
  assert.throws(() => inspectWav(bytes.slice(0, -1)));
  const corrupted = bytes.slice();
  new DataView(corrupted.buffer).setUint32(28, 1, true);
  assert.throws(() => inspectWav(corrupted));
  assert.throws(() => inspectWav(new Uint8Array([1, 2, 3])));
});

test('capture gaps flush short fragments rather than silently joining disconnected audio', () => {
  const clips: PcmClip[] = [], gaps: number[][] = [];
  const assembler = new PcmWindowAssembler(16000, 7000, c => clips.push(c), (a,b) => gaps.push([a,b]));
  assembler.push(new Float32Array(16000 * 2), 1000);
  assembler.push(new Float32Array(16000 * 7), 6000);
  assert.deepEqual(gaps, [[3000, 6000]]);
  assert.deepEqual(clips.map(c => [c.startMs,c.endMs,c.final]), [[1000,3000,true],[6000,13000,false]]);
});

test('backward capture clocks stop the stream and never emit a negative gap', () => {
  const gaps: number[][] = [];
  const assembler = new PcmWindowAssembler(16000, 7000, () => {}, (a,b) => gaps.push([a,b]));
  assembler.push(new Float32Array(16000), 5000);
  assert.throws(() => assembler.push(new Float32Array(16000), 3000), /backward/);
  assert.deepEqual(gaps, [[3000,6000]]);
});

test('video context reports missing intervals and evicts to its byte and time limits', () => {
  const buffer = new ContextBuffer(20000, 6);
  const chunk = (id: string, startMs: number, endMs: number) => ({id,startMs,endMs,blob:new Blob(['abc']),mimeType:'video/webm'});
  buffer.add(chunk('first',0,5000));
  buffer.add(chunk('second',7000,10000));
  assert.deepEqual(buffer.context({startMs:0,endMs:10000},0).gaps,[{startMs:5000,endMs:7000}]);
  assert.deepEqual(buffer.add(chunk('third',10000,15000)),['first']);
  assert.equal(buffer.byteLength,6);
  assert.equal(buffer.context({startMs:7000,endMs:15000},0).complete,true);
  assert.deepEqual(buffer.evict(40000),['second','third']);
  assert.equal(buffer.context({startMs:7000,endMs:15000},0,40000).complete,false);
});
