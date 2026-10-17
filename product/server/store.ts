/** Shared storage for multi-instance deployments (Vercel). Session records are written with
 * optimistic concurrency (ETag `ifMatch`), so two instances can never silently overwrite each
 * other; media is private and only served through the reviewer-authenticated API. */

export class StoreConflict extends Error { constructor(id: string) { super(`Session ${id} changed concurrently`); this.name = 'StoreConflict'; } }

export interface SharedStore {
  readonly name: string;
  getRecord(id: string): Promise<{ json: string; etag: string } | undefined>;
  /** `ifMatch` undefined = create only (fails if it exists). Returns the new ETag. Throws StoreConflict. */
  putRecord(id: string, json: string, ifMatch: string | undefined): Promise<string>;
  deleteRecord(id: string): Promise<void>;
  listRecords(): Promise<Array<{ id: string; etag: string }>>;
  putMedia(sessionId: string, name: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getMedia(sessionId: string, name: string): Promise<Buffer | undefined>;
  deleteMedia(sessionId: string, name: string): Promise<void>;
  deleteSessionMedia(sessionId: string): Promise<void>;
  /** Cheap probe for /api/health. */
  ping(): Promise<void>;
}

const recordPath = (id: string) => `sessions/${id}.json`;
/** Blob returns a weak ETag (W/"…") on compressed reads of larger blobs, but conditional writes only
 * match the strong form. Every ETag is normalised to the strong form. */
export const strongEtag = (etag: string | undefined) => (etag ?? '').replace(/^W\//, '');
const mediaPath = (sid: string, name: string) => `media/${sid}/${name}`;

/** Vercel Blob (private). Needs BLOB_READ_WRITE_TOKEN (added when a Blob store is connected to the project). */
export class BlobStore implements SharedStore {
  readonly name = 'vercel-blob';
  private sdk?: typeof import('@vercel/blob');
  private async blob() { return this.sdk ??= await import('@vercel/blob'); }
  private async read(path: string): Promise<{ bytes: Buffer; etag: string } | undefined> {
    const { get } = await this.blob();
    const result = await get(path, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) return undefined;
    const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
    return { bytes, etag: strongEtag(result.blob.etag) };
  }
  async getRecord(id: string) {
    const r = await this.read(recordPath(id));
    return r ? { json: r.bytes.toString('utf8'), etag: r.etag } : undefined;
  }
  async putRecord(id: string, json: string, ifMatch: string | undefined): Promise<string> {
    const { put, BlobPreconditionFailedError, BlobError } = await this.blob();
    try {
      const res = await put(recordPath(id), json, { access: 'private', contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 0,
        ...(ifMatch ? { ifMatch: strongEtag(ifMatch), allowOverwrite: true } : { allowOverwrite: false }) });
      return strongEtag((res as { etag?: string }).etag);
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new StoreConflict(id);
      // Create-only write of an existing record is also a conflict.
      if (!ifMatch && error instanceof BlobError && /exist/i.test((error as Error).message)) throw new StoreConflict(id);
      throw error;
    }
  }
  async deleteRecord(id: string) { const { del } = await this.blob(); await del(recordPath(id)); }
  async listRecords() {
    const { list } = await this.blob();
    const out: Array<{ id: string; etag: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'sessions/', cursor, limit: 1000 });
      for (const b of page.blobs) { const m = /^sessions\/([a-f0-9]{24})\.json$/.exec(b.pathname); if (m) out.push({ id: m[1]!, etag: strongEtag(b.etag) }); }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }
  async putMedia(sid: string, name: string, bytes: Uint8Array, contentType: string) {
    const { put } = await this.blob();
    await put(mediaPath(sid, name), Buffer.from(bytes), { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true });
  }
  async getMedia(sid: string, name: string) { return (await this.read(mediaPath(sid, name)))?.bytes; }
  async deleteMedia(sid: string, name: string) { const { del } = await this.blob(); await del(mediaPath(sid, name)); }
  async deleteSessionMedia(sid: string) {
    const { list, del } = await this.blob();
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: `media/${sid}/`, cursor, limit: 1000 });
      if (page.blobs.length) await del(page.blobs.map(b => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  async ping() { const { list } = await this.blob(); await list({ prefix: 'sessions/', limit: 1 }); }
}

/** In-memory shared store with the same conditional-write semantics (tests: several instances, one store). */
export class MemoryStore implements SharedStore {
  readonly name = 'memory';
  private records = new Map<string, { json: string; etag: string }>();
  private media = new Map<string, Buffer>();
  private n = 0;
  /** Like Vercel Blob, reads return a weak ETag for anything over 1 KB. */
  async getRecord(id: string) { const r = this.records.get(id); return r ? { json: r.json, etag: r.json.length > 1024 ? `W/${r.etag}` : r.etag } : undefined; }
  async putRecord(id: string, json: string, ifMatch: string | undefined) {
    const cur = this.records.get(id);
    if (ifMatch === undefined ? cur !== undefined : cur?.etag !== ifMatch) throw new StoreConflict(id);   // strong comparison only
    const etag = `"e${++this.n}"`;
    this.records.set(id, { json, etag });
    return etag;
  }
  async deleteRecord(id: string) { this.records.delete(id); }
  async listRecords() { return [...this.records].map(([id, r]) => ({ id, etag: r.etag })); }
  async putMedia(sid: string, name: string, bytes: Uint8Array) { this.media.set(mediaPath(sid, name), Buffer.from(bytes)); }
  async getMedia(sid: string, name: string) { return this.media.get(mediaPath(sid, name)); }
  async deleteMedia(sid: string, name: string) { this.media.delete(mediaPath(sid, name)); }
  async deleteSessionMedia(sid: string) { for (const k of [...this.media.keys()]) if (k.startsWith(`media/${sid}/`)) this.media.delete(k); }
  async ping() { /* always reachable */ }
  get mediaCount() { return this.media.size; }
}

/** Supabase: session records in Postgres (table `sg_sessions`, optimistic concurrency on `version`)
 * and media in a private Storage bucket. Plain REST through fetch; no per-request quota like Blob's.
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only). Schema: product/server/supabase.sql. */
export class SupabaseStore implements SharedStore {
  readonly name = 'supabase';
  private readonly base: string;
  constructor(url: string, private readonly key: string, private readonly bucket = 'switchguard-media', private readonly http: typeof fetch = fetch) {
    this.base = url.replace(/\/+$/, '');
  }
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys only in apikey.
    return { apikey: this.key, ...(this.key.startsWith('eyJ') ? { authorization: `Bearer ${this.key}` } : {}), ...extra };
  }
  private async req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    return this.http(`${this.base}${path}`, { ...init, headers: this.headers(init.headers) });
  }
  private async fail(res: Response, what: string): Promise<never> {
    throw new Error(`Supabase ${what} failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  private rows = (q: string) => `/rest/v1/sg_sessions?${q}`;
  private object = (sid: string, name: string) => `/storage/v1/object/${this.bucket}/media/${sid}/${encodeURIComponent(name)}`;

  async getRecord(id: string) {
    const res = await this.req(this.rows(`id=eq.${encodeURIComponent(id)}&select=json,version`));
    if (!res.ok) return this.fail(res, 'read');
    const [row] = await res.json() as Array<{ json: string; version: number }>;
    return row ? { json: row.json, etag: String(row.version) } : undefined;
  }
  async putRecord(id: string, json: string, ifMatch: string | undefined): Promise<string> {
    if (ifMatch === undefined) {
      const res = await this.req(this.rows(''), { method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ id, json, version: 1 }) });
      if (res.status === 409) throw new StoreConflict(id);
      if (!res.ok) return this.fail(res, 'create');
      return '1';
    }
    const version = Number(strongEtag(ifMatch).replace(/"/g, ''));
    if (!Number.isInteger(version)) throw new StoreConflict(id);
    const res = await this.req(this.rows(`id=eq.${encodeURIComponent(id)}&version=eq.${version}`), {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({ json, version: version + 1, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return this.fail(res, 'update');
    const updated = await res.json() as unknown[];
    if (!updated.length) throw new StoreConflict(id);   // someone else wrote first (or it was deleted)
    return String(version + 1);
  }
  async deleteRecord(id: string) {
    const res = await this.req(this.rows(`id=eq.${encodeURIComponent(id)}`), { method: 'DELETE' });
    if (!res.ok) await this.fail(res, 'delete');
  }
  async listRecords() {
    const out: Array<{ id: string; etag: string }> = [];
    for (let from = 0; ; from += 1000) {
      const res = await this.req(this.rows(`select=id,version&order=id&offset=${from}&limit=1000`));
      if (!res.ok) return this.fail(res, 'list');
      const page = await res.json() as Array<{ id: string; version: number }>;
      for (const r of page) out.push({ id: r.id, etag: String(r.version) });
      if (page.length < 1000) return out;
    }
  }
  async putMedia(sid: string, name: string, bytes: Uint8Array, contentType: string) {
    const res = await this.req(this.object(sid, name), { method: 'POST', headers: { 'content-type': contentType, 'x-upsert': 'true' }, body: new Blob([new Uint8Array(bytes)]) });
    if (!res.ok) await this.fail(res, 'media upload');
  }
  async getMedia(sid: string, name: string) {
    const res = await this.req(this.object(sid, name));
    if (res.status === 400 || res.status === 404) return undefined;   // Storage reports a missing object as 400 or 404
    if (!res.ok) return this.fail(res, 'media read');
    return Buffer.from(await res.arrayBuffer());
  }
  private async removeObjects(paths: string[]) {
    if (!paths.length) return;
    const res = await this.req(`/storage/v1/object/${this.bucket}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) });
    if (!res.ok) await this.fail(res, 'media delete');
  }
  async deleteMedia(sid: string, name: string) { await this.removeObjects([`media/${sid}/${name}`]); }
  async deleteSessionMedia(sid: string) {
    for (;;) {
      const res = await this.req(`/storage/v1/object/list/${this.bucket}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: `media/${sid}`, limit: 1000, offset: 0 }) });
      if (!res.ok) return this.fail(res, 'media list');
      const names = (await res.json() as Array<{ name: string }>).map(o => `media/${sid}/${o.name}`);
      await this.removeObjects(names);
      if (names.length < 1000) return;
    }
  }
  async ping() {
    const res = await this.req(this.rows('select=id&limit=1'));
    if (!res.ok) await this.fail(res, 'ping');
  }
}
