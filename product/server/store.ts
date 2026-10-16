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
