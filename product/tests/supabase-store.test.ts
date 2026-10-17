/** SupabaseStore against an in-process fake of PostgREST + Storage (no network): conditional
 * writes, create-only conflicts, listing, media round trip and per-session media cleanup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StoreConflict, SupabaseStore } from '../server/store.js';

function fakeSupabase() {
  const rows = new Map<string, { id: string; json: string; version: number }>();
  const objects = new Map<string, Buffer>();
  const seen: string[] = [];
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', h = init?.headers as Record<string, string>;
    seen.push(h.apikey ?? "");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, '');
    if (url.pathname === '/rest/v1/sg_sessions') {
      const id = eq('id'), version = eq('version');
      if (method === 'GET') {
        if (id) { const r = rows.get(id); return json(r ? [{ json: r.json, version: r.version }] : []); }
        const all = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
        const off = Number(url.searchParams.get('offset') ?? 0), lim = Number(url.searchParams.get('limit') ?? 1000);
        return json(all.slice(off, off + lim).map(r => ({ id: r.id, version: r.version })));
      }
      if (method === 'POST') { const b = JSON.parse(String(init!.body)); if (rows.has(b.id)) return json({ code: '23505' }, 409); rows.set(b.id, b); return new Response(null, { status: 201 }); }
      if (method === 'PATCH') {
        const r = rows.get(id!); if (!r || String(r.version) !== version) return json([]);
        Object.assign(r, JSON.parse(String(init!.body))); return json([r]);
      }
      if (method === 'DELETE') { rows.delete(id!); return new Response(null, { status: 204 }); }
    }
    const obj = /^\/storage\/v1\/object\/switchguard-media\/(.+)$/.exec(url.pathname);
    if (obj) {
      const key = decodeURIComponent(obj[1]!);
      if (method === 'POST') { objects.set(key, Buffer.from(await (init!.body as Blob).arrayBuffer())); return json({ Key: key }); }
      const b = objects.get(key); return b ? new Response(new Uint8Array(b)) : json({ error: 'not_found' }, 400);
    }
    if (url.pathname === '/storage/v1/object/switchguard-media' && method === 'DELETE') {
      for (const p of JSON.parse(String(init!.body)).prefixes) objects.delete(p); return json([]);
    }
    if (url.pathname === '/storage/v1/object/list/switchguard-media') {
      const prefix = JSON.parse(String(init!.body)).prefix + '/';
      return json([...objects.keys()].filter(k => k.startsWith(prefix)).map(k => ({ name: k.slice(prefix.length) })));
    }
    return json({ error: 'unexpected' }, 500);
  };
  return { http, rows, objects, seen };
}

const ID = 'a'.repeat(24), ID2 = 'b'.repeat(24);

test('supabase store: create-only, conditional updates and listing', async () => {
  const f = fakeSupabase();
  const store = new SupabaseStore('https://x.supabase.co/', 'sb_secret_test', undefined, f.http);
  assert.equal(await store.getRecord(ID), undefined);
  const e1 = await store.putRecord(ID, '{"v":1}', undefined);
  await assert.rejects(store.putRecord(ID, '{"v":0}', undefined), StoreConflict, 'create of an existing record conflicts');
  const e2 = await store.putRecord(ID, '{"v":2}', e1);
  await assert.rejects(store.putRecord(ID, '{"v":"stale"}', e1), StoreConflict, 'stale version conflicts');
  assert.deepEqual(await store.getRecord(ID), { json: '{"v":2}', etag: e2 });
  await store.putRecord(ID2, '{}', undefined);
  assert.deepEqual((await store.listRecords()).map(r => r.id), [ID, ID2]);
  await store.deleteRecord(ID2);
  assert.equal(await store.getRecord(ID2), undefined);
  await store.ping();
  assert.ok(f.seen.every(k => k === 'sb_secret_test'));
});

test('supabase store: media round trip and per-session cleanup', async () => {
  const f = fakeSupabase();
  const store = new SupabaseStore('https://x.supabase.co', 'sb_secret_test', undefined, f.http);
  await store.putMedia(ID, 'w1.wav', new Uint8Array([1, 2, 3]), 'audio/wav');
  await store.putMedia(ID, 'v1.webm', new Uint8Array([4]), 'video/webm');
  await store.putMedia(ID2, 'w1.wav', new Uint8Array([9]), 'audio/wav');
  assert.deepEqual([...(await store.getMedia(ID, 'w1.wav'))!], [1, 2, 3]);
  assert.equal(await store.getMedia(ID, 'missing.wav'), undefined);
  await store.deleteMedia(ID, 'v1.webm');
  assert.equal(await store.getMedia(ID, 'v1.webm'), undefined);
  await store.deleteSessionMedia(ID);
  assert.equal(await store.getMedia(ID, 'w1.wav'), undefined);
  assert.deepEqual([...(await store.getMedia(ID2, 'w1.wav'))!], [9], 'other sessions untouched');
});
