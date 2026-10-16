import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, addWindow, applyResult, decide } from '../src/shared/decision.js';
import type { AudioWindow, WindowResult } from '../src/shared/contracts.js';
import {fixtureSession,fixtureWindow,fixtureResult} from './fixtures.js';
for (const [speaker, authenticity, expected] of [ ['match','real','consistent_with_enrolled_speaker'], ['no_match','real','needs_reverification'], ['match','fake','needs_reverification'], ['match','not_sure','inconclusive'] ] as const) {
  test(`${speaker} + ${authenticity}`, () => assert.equal(decide(applyResult(addWindow(fixtureSession(), fixtureWindow()), fixtureResult('w1', speaker, authenticity)), 9000).state, expected));
}
test('partial failure cannot produce a positive state, but fake remains flagged', () => {
  const s = addWindow(fixtureSession(), fixtureWindow()); const r = fixtureResult();
  r.speaker = {status:'failed',error:{code:'unavailable',message:'Unavailable'},provider:{}};
  assert.equal(decide(applyResult(s,r),9000).state,'inconclusive');
  r.authenticity = {...fixtureResult('w1','match','fake').authenticity};
  assert.equal(decide(applyResult(s,r),9000).state,'needs_reverification');
});
test('late older result preserves evidence without replacing the newer status', () => {
  let s = addWindow(addWindow(fixtureSession(),fixtureWindow()),fixtureWindow('w2',7000));
  s=applyResult(s,fixtureResult('w2')); s=applyResult(s,fixtureResult('w1','no_match'));
  assert.equal(decide(s,15000).latestWindowId,'w2'); assert.equal(decide(s,15000).state,'consistent_with_enrolled_speaker'); assert.equal(s.evidence.length,1);
});
test('a newer pending window, stale result and short fragment never report positive', () => {
  let s=applyResult(addWindow(fixtureSession(),fixtureWindow()),fixtureResult());
  assert.equal(decide(s,40000).state,'monitoring_interrupted');
  s=addWindow(s,fixtureWindow('w2',7000)); assert.equal(decide(s,15000).state,'checking');
  s.windows[1]!.coverage='skipped'; s.windows[1]!.reason='short_final_fragment'; assert.equal(decide(s,15000).state,'inconclusive');
});
test('interruption then resume requires newly captured evidence', () => {
  let s=applyResult(addWindow(fixtureSession(),fixtureWindow()),fixtureResult());
  s.interruptions.push({atMs:8000,kind:'interrupted',reason:'Microphone stopped'});
  assert.equal(decide(s,9000).state,'monitoring_interrupted');
  s.interruptions.push({atMs:10000,kind:'resumed',reason:'Microphone resumed'});
  assert.equal(decide(s,11000).state,'checking');
  s=applyResult(addWindow(s,fixtureWindow('w2',11000)),fixtureResult('w2'));
  assert.equal(decide(s,19000).state,'consistent_with_enrolled_speaker');
});
test('reverify uses original reference; success and reviewer resolution never erase previous flag', () => {
  let s=applyResult(addWindow(fixtureSession(),fixtureWindow()),fixtureResult('w1','no_match'));
  assert.throws(()=>addWindow(s,{...fixtureWindow('w2',7000,'reverify'),referenceId:'replacement'}));
  s=applyResult(addWindow(s,fixtureWindow('w2',7000,'reverify')),fixtureResult('w2'));
  s.resolutions.push({id:'review',evidenceId:s.evidence[0]!.id,reviewerId:'human',atMs:16000,disposition:'reviewed',notes:'Checked'});
  assert.equal(s.evidence.length,1); assert.equal(decide(s,15000).state,'consistent_with_enrolled_speaker');
  assert.equal(applyResult(s,fixtureResult('w2')).results.length,2);
});
