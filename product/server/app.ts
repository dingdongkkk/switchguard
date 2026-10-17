import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { PipelineError, object } from '../../src/server/detectif.js';
import { fail, type ProductRecord, type SwitchGuardService } from './service.js';

const MAX_AUDIO = 12 * 1024 * 1024;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json', '.wasm': 'application/wasm' };
/** Official MediaPipe gesture model, fetched by the candidate's browser (no video leaves the browser). */
export const GESTURE_MODEL_ORIGIN = 'https://storage.googleapis.com';

export interface AppOptions {
  reviewerToken: string;
  /** Directory containing product/ (repo root). */
  root: string;
  /** Extra host names allowed besides loopback (e.g. a deployed domain). */
  allowedHosts?: string[];
  /** Honour X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  trustProxy?: boolean;
  /** One JSON line per API request (no tokens, keys or query strings). */
  accessLog?: boolean;
  /** Judge demo: requests with `x-demo: 1` (and no reviewer token) may create and work with demo
   * sessions only. Real sessions stay behind the reviewer token. */
  judgeDemo?: boolean;
  /** Shared secret for the scheduled housekeeping route (Vercel Cron). */
  cronSecret?: string;
  /** Per-IP limits; tests lower them. */
  limits?: { burst?: number; perSecond?: number; reviewerFailures?: number; lockoutMs?: number };
}

/** Per-IP token bucket and failed-reviewer-token counter. */
class Throttle {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private failures = new Map<string, { count: number; first: number; lockedUntil?: number }>();
  constructor(private readonly burst: number, private readonly perSecond: number, private readonly maxFailures: number, private readonly lockoutMs: number) {
    setInterval(() => this.cleanup(), 60_000).unref();
  }
  take(ip: string): boolean {
    const now = Date.now(), b = this.buckets.get(ip) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond); b.at = now;
    if (b.tokens < 1) { this.buckets.set(ip, b); return false; }
    b.tokens -= 1; this.buckets.set(ip, b); return true;
  }
  locked(ip: string): boolean { const f = this.failures.get(ip); return !!f?.lockedUntil && f.lockedUntil > Date.now(); }
  fail(ip: string): void {
    const now = Date.now(), f = this.failures.get(ip);
    if (!f || now - f.first > this.lockoutMs) { this.failures.set(ip, { count: 1, first: now }); return; }
    f.count++;
    if (f.count >= this.maxFailures) f.lockedUntil = now + this.lockoutMs;
  }
  private cleanup(): void {
    const now = Date.now();
    for (const [ip, b] of this.buckets) if (now - b.at > 120_000) this.buckets.delete(ip);
    for (const [ip, f] of this.failures) if ((f.lockedUntil ?? f.first + this.lockoutMs) < now) this.failures.delete(ip);
  }
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  // Refuse declared oversize bodies before reading a byte of them.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) fail('payload_too_large', 'Request body is too large', 413);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail('payload_too_large', 'Request body is too large', 413); chunks.push(chunk); }
  if (!chunks.length) {
    // Some hosts (Vercel's Node helpers) buffer the body before the handler runs; use their copy.
    const pre = (req as { body?: unknown }).body;
    const buf = Buffer.isBuffer(pre) ? pre : typeof pre === 'string' ? Buffer.from(pre) : pre && typeof pre === 'object' ? Buffer.from(JSON.stringify(pre)) : undefined;
    if (buf) { if (buf.length > limit) fail('payload_too_large', 'Request body is too large', 413); return buf; }
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage): Promise<Record<string, any>> {
  const bytes = await readBody(req, 64 * 1024);
  if (!bytes.length) return {};
  try { return object(JSON.parse(bytes.toString('utf8'))); } catch { return fail('invalid_json', 'Invalid JSON body'); }
}
function captureMeta(req: IncomingMessage): Record<string, any> {
  try { return object(JSON.parse(decodeURIComponent(String(req.headers['x-capture-metadata'] ?? '')))); } catch { return fail('invalid_metadata', 'Missing or invalid X-Capture-Metadata header'); }
}
interface Reply { status: number; body?: unknown; raw?: Buffer; headers?: Record<string, string> }
function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

export function createRequestHandler(service: SwitchGuardService, options: AppOptions) {
  const allowed = new Set((options.allowedHosts ?? []).map(h => h.toLowerCase()));
  const publicDir = resolve(options.root, 'product/public');
  const distDir = resolve(options.root, 'product/dist');
  const vendorDir = resolve(options.root, 'node_modules/three/build');
  const mediapipeDir = resolve(options.root, 'node_modules/@mediapipe/tasks-vision');

  const limits = options.limits ?? {};
  const throttle = new Throttle(limits.burst ?? 300, limits.perSecond ?? 60, limits.reviewerFailures ?? 20, limits.lockoutMs ?? 600_000);
  const clientIp = (req: IncomingMessage) => {
    const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
  };
  /** A wrong reviewer token counts toward the per-IP lockout; a missing one does not (plain pages). */
  const isReviewer = (req: IncomingMessage) => {
    const given = String(req.headers['x-reviewer-token'] ?? '');
    const ok = equal(given, options.reviewerToken);
    if (!ok && given) throttle.fail(clientIp(req));
    return ok;
  };
  const isCandidate = (req: IncomingMessage, rec: ProductRecord) => equal(String(req.headers['x-session-key'] ?? ''), rec.candidateKey);
  const isJudge = (req: IncomingMessage) => !!options.judgeDemo && req.headers['x-demo'] === '1' && !req.headers['x-reviewer-token'];
  /** Full reviewer (token) or judge (demo sessions only). */
  function reviewer(req: IncomingMessage): 'full' | 'judge' {
    if (isReviewer(req)) return 'full';
    if (isJudge(req)) return 'judge';
    return fail('unauthorized', 'Reviewer token required', 401);
  }
  /** Unknown session and wrong key look identical, so session IDs cannot be probed. A judge sees
   * demo sessions only; anything else looks like it does not exist. */
  function session(req: IncomingMessage, id: string, who: 'reviewer' | 'candidate' | 'either' | 'candidate_or_sandbox_reviewer'): ProductRecord {
    const rec = service.records.get(id);
    const r = isReviewer(req) || (!!rec?.demo && isJudge(req)), c = rec ? isCandidate(req, rec) : false;
    const ok = rec && (who === 'reviewer' ? r : who === 'candidate' ? c : who === 'either' ? r || c : c || (r && rec.kind === 'sandbox'));
    if (!ok) fail(r || c || who !== 'reviewer' ? 'not_found' : 'unauthorized', r || c || who !== 'reviewer' ? 'Session not found' : 'Reviewer token required', r || c || who !== 'reviewer' ? 404 : 401);
    return rec!;
  }

  async function serveStatic(res: ServerResponse, path: string): Promise<boolean> {
    let file: string | undefined;
    if (/^\/vendor\/three\.(module|core)\.js$/.test(path)) file = resolve(vendorDir, path.slice('/vendor/'.length));
    else if (/^\/vendor\/mediapipe\/(vision_bundle\.mjs|wasm\/vision_wasm(_nosimd|_module)?_internal\.(js|wasm))$/.test(path)) file = resolve(mediapipeDir, path.slice('/vendor/mediapipe/'.length));
    else if (path === '/') file = resolve(publicDir, 'index.html');
    else if (/^\/[a-z0-9-]+\.(html|css|js)$/.test(path)) file = resolve(publicDir, path.slice(1));
    else if (/^\/js\/(product\/browser|src\/media|src\/shared)\/[A-Za-z0-9_-]+\.js(\.map)?$/.test(path)) file = resolve(distDir, path.slice('/js/'.length));
    if (!file || !(file.startsWith(publicDir + sep) || file.startsWith(distDir + sep) || file.startsWith(vendorDir + sep) || file.startsWith(mediapipeDir + sep))) return false;
    try {
      const bytes = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(bytes); return true;
    } catch { return false; }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now(), ip = clientIp(req);
    if (options.accessLog) res.on('finish', () => {
      const path = (req.url ?? '').split('?')[0]!;
      const routinePoll = req.method === 'GET' && /^\/api\/sessions\/[a-f0-9]{24}(\/candidate|\/clock)?$/.test(path) && res.statusCode < 400;
      if (path.startsWith('/api/') && !routinePoll && path !== '/api/health') {
        console.log(JSON.stringify({ t: new Date().toISOString(), ip, method: req.method, path, status: res.statusCode, ms: Date.now() - started }));
      }
    });
    res.setHeader('x-content-type-options', 'nosniff');
    const https = options.trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https' : (req.socket as { encrypted?: boolean }).encrypted === true;
    if (https) res.setHeader('strict-transport-security', 'max-age=15552000; includeSubDomains');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'microphone=(self), camera=(self)');
    res.setHeader('content-security-policy', `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' ${GESTURE_MODEL_ORIGIN}; media-src 'self' blob:; img-src 'self' blob: data:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    try {
      const host = String(req.headers.host ?? '').toLowerCase();
      const hostname = host.replace(/:\d+$/, '');
      if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname) && !allowed.has(hostname)) fail('host_not_allowed', 'Host not allowed (set ALLOWED_HOSTS for deployment)', 403);
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}` && origin !== `https://${host}`) fail('cross_origin', 'Cross-origin requests are not accepted', 403);
      const url = new URL(req.url ?? '/', `http://${host}`), path = url.pathname, method = req.method ?? 'GET';
      if (path.startsWith('/api/') && path !== '/api/health') {
        if (!throttle.take(ip)) { res.setHeader('retry-after', '5'); fail('rate_limited', 'Too many requests from this address; slow down and retry in a few seconds', 429); }
        if (throttle.locked(ip)) { res.setHeader('retry-after', '600'); fail('too_many_failed_logins', 'Too many wrong reviewer tokens from this address; try again in 10 minutes', 429); }
      }

      if (!path.startsWith('/api/')) {
        if (method === 'GET' && await serveStatic(res, path)) return;
        fail('not_found', 'Not found', 404);
      }
      if (path === '/api/health' && method === 'GET') { const h = await service.health(); send(res, h.ok ? 200 : 503, h); return; }
      // Scheduled housekeeping (Vercel Cron sends "Authorization: Bearer $CRON_SECRET").
      if (path === '/api/cron/sweep' && method === 'GET') {
        if (!options.cronSecret || !equal(String(req.headers.authorization ?? ''), `Bearer ${options.cronSecret}`)) fail('unauthorized', 'Cron secret required', 401);
        send(res, 200, await service.sweepAll()); return;
      }
      if (path === '/api/ops' && method === 'GET') { reviewer(req); await service.pullAll(); send(res, 200, await service.ops()); return; }
      if (path === '/api/demo' && method === 'GET') { send(res, 200, { enabled: !!options.judgeDemo }); return; }
      if (path === '/api/sessions' && method === 'GET') {
        const role = reviewer(req); await service.pullAll();
        send(res, 200, { sessions: service.summaries().filter(s => role === 'full' || s.demo), role }); return;
      }
      if (path === '/api/sessions' && method === 'POST') {
        const role = reviewer(req);
        if (role === 'judge') await service.pullAll();   // the demo-session cap counts every instance's sessions
        const rec = service.createSession({ ...(await json(req)), demo: role === 'judge' });
        await service.persistNew(rec.session.id);
        const view = service.reviewerView(rec);
        send(res, 201, { sessionId: rec.session.id, candidateKey: rec.candidateKey, candidateUrl: view.candidateUrl, view }); return;
      }
      const m = /^\/api\/sessions\/([a-f0-9]{24})(\/.*)?$/.exec(path);
      if (!m) fail('not_found', 'Route not found', 404);
      const id = m[1]!, sub = m[2] ?? '';
      const op = () => String(req.headers['x-operation-id'] ?? '');
      // The body is read once and memoised: a write that loses a race with another instance is replayed.
      let bodyCache: Buffer | undefined;
      const bodyOnce = async (limit: number) => bodyCache ??= await readBody(req, limit);
      const jsonOnce = async (): Promise<Record<string, any>> => {
        const bytes = await bodyOnce(64 * 1024);
        if (!bytes.length) return {};
        try { return object(JSON.parse(bytes.toString('utf8'))); } catch { return fail('invalid_json', 'Invalid JSON body'); }
      };
      const audio = async () => {
        if (req.headers['content-type'] !== 'audio/wav') fail('unsupported_media', 'Send canonical mono PCM16 audio/wav from the capture module', 415);
        return new Uint8Array(await bodyOnce(MAX_AUDIO));
      };
      const route = async (): Promise<Reply> => {
        let r: RegExpExecArray | null;

        if (sub === '' && method === 'GET') { const rec = session(req, id, 'reviewer'); service.touch(rec, 'reviewer'); return { status: 200, body: service.reviewerView(rec) }; }
        if (sub === '/join' && method === 'POST') { const rec = session(req, id, 'reviewer'); service.join(rec, await jsonOnce()); return { status: 200, body: service.reviewerView(rec) }; }
        if (sub === '/review-requests' && method === 'POST') {
          const rec = session(req, id, 'either'), body = await jsonOnce();
          const asCandidate = isCandidate(req, rec);
          service.createReviewRequest(rec, { requestedBy: asCandidate ? 'candidate' : 'reviewer', reason: body.reason, requesterName: asCandidate ? undefined : (typeof body.reviewerId === 'string' ? body.reviewerId.slice(0, 128) : undefined) });
          return { status: 200, body: asCandidate ? service.candidateView(rec) : service.reviewerView(rec) };
        }
        if ((r = /^\/review-requests\/([A-Za-z0-9-]+)\/versions$/.exec(sub)) && method === 'POST') {
          const rec = session(req, id, 'either'); await jsonOnce();
          const asCandidate = isCandidate(req, rec);
          service.newVersion(rec, r[1]!, asCandidate ? 'candidate' : 'reviewer');
          return { status: 200, body: asCandidate ? service.candidateView(rec) : service.reviewerView(rec) };
        }
        if (sub === '/gestures' && method === 'POST') { const rec = session(req, id, 'reviewer'); service.requestGesture(rec, await jsonOnce()); return { status: 200, body: service.reviewerView(rec) }; }
        if ((r = /^\/gestures\/([A-Za-z0-9-]+)\/report$/.exec(sub)) && method === 'POST') {
          const rec = session(req, id, 'candidate');
          const raw = await bodyOnce(400 * 1024);
          let body: Record<string, any>;
          try { body = object(JSON.parse(raw.toString('utf8'))); } catch { fail('invalid_json', 'Invalid JSON body'); }
          service.reportGesture(rec, r[1]!, body); return { status: 200, body: service.candidateView(rec) };
        }
        if ((r = /^\/review-requests\/([A-Za-z0-9-]+)\/close$/.exec(sub)) && method === 'POST') {
          const rec = session(req, id, 'reviewer'); service.closeReviewRequest(rec, r[1]!, await jsonOnce()); return { status: 200, body: service.reviewerView(rec) };
        }
        if (sub === '' && method === 'DELETE') { await service.deleteSession(session(req, id, 'reviewer')); return { status: 200, body: { deleted: true } }; }
        if (sub === '/candidate' && method === 'GET') { const rec = session(req, id, 'candidate'); service.touch(rec, 'candidate'); return { status: 200, body: service.candidateView(rec) }; }
        if (sub === '/clock' && method === 'GET') { const rec = session(req, id, 'either'); return { status: 200, body: { sessionMs: service.elapsed(rec) } }; }
        if (sub === '/consent' && method === 'POST') { const rec = session(req, id, 'candidate_or_sandbox_reviewer'); service.consent(rec, await jsonOnce()); return { status: 200, body: service.candidateView(rec) }; }
        if (sub === '/enrollment' && method === 'POST') {
          const rec = session(req, id, 'candidate_or_sandbox_reviewer');
          const bytes = await audio(), meta = captureMeta(req);   // content type is checked first
          return { status: 200, body: await service.enroll(rec, bytes, meta, op()) };
        }
        if (sub === '/control' && method === 'POST') { const rec = session(req, id, 'either'); service.control(rec, (await jsonOnce()).action); return { status: 200, body: service.candidateView(rec) }; }
        if (sub === '/answers/start' && method === 'POST') { const rec = session(req, id, 'either'); service.startAnswer(rec, (await jsonOnce()).questionId); return { status: 200, body: service.candidateView(rec) }; }
        if (sub === '/answers/end' && method === 'POST') { const rec = session(req, id, 'either'); await jsonOnce(); service.endAnswer(rec); return { status: 200, body: service.candidateView(rec) }; }
        if (sub === '/windows' && method === 'POST') {
          const rec = session(req, id, 'candidate_or_sandbox_reviewer');
          const bytes = await audio(), meta = captureMeta(req);   // content type is checked first
          return { status: 202, body: await service.submitWindow(rec, bytes, meta, op()) };
        }
        if (sub === '/transcript' && method === 'POST') { const rec = session(req, id, 'candidate'); return { status: 200, body: service.addTranscript(rec, await jsonOnce()) }; }
        if (sub === '/interruptions' && method === 'POST') { const rec = session(req, id, 'candidate'); service.candidateInterruption(rec, await jsonOnce()); return { status: 200, body: { ok: true } }; }
        if (sub === '/thumbnails' && method === 'POST') {
          const rec = session(req, id, 'candidate');
          if (req.headers['content-type'] !== 'image/jpeg') fail('unsupported_media', 'Thumbnails must be image/jpeg', 415);
          service.addThumbnail(rec, new Uint8Array(await bodyOnce(200_000)), req.headers['x-at-ms']); return { status: 200, body: { ok: true } };
        }
        if (sub === '/video' && method === 'POST') {
          const rec = session(req, id, 'candidate');
          const meta = captureMeta(req);
          return { status: 200, body: service.addVideoClip(rec, new Uint8Array(await bodyOnce(4 * 1024 * 1024)), meta, req.headers['content-type']) };
        }
        if ((r = /^\/evidence\/([^/]+)\/context$/.exec(sub)) && method === 'GET') {
          const rec = session(req, id, 'reviewer');
          const evidence = rec.session.evidence.find(e => e.id === decodeURIComponent(r![1]!));
          if (!evidence) fail('not_found', 'Evidence not found', 404);
          return { status: 200, body: service.videoContext(rec, evidence) };
        }
        if ((r = /^\/media\/([A-Za-z0-9.-]+)$/.exec(sub)) && method === 'GET') {
          const rec = session(req, id, 'reviewer');
          const media = await service.readMedia(rec, r[1]!);
          return { status: 200, raw: media.bytes, headers: { 'content-type': media.contentType, 'cache-control': 'no-store, private', 'content-disposition': 'inline' } };
        }
        if ((r = /^\/evidence\/([^/]+)\/resolutions$/.exec(sub)) && method === 'POST') {
          const rec = session(req, id, 'reviewer'); service.resolve(rec, decodeURIComponent(r[1]!), await jsonOnce()); return { status: 200, body: service.reviewerView(rec) };
        }
        // Kept for compatibility: a reviewer-issued phrase is always tracked as a re-evaluation request.
        if (sub === '/challenges' && method === 'POST') { const rec = session(req, id, 'reviewer'); const body = await jsonOnce(); service.createReviewRequest(rec, { requestedBy: 'reviewer', reason: body.reason }); return { status: 200, body: service.reviewerView(rec) }; }
        if ((r = /^\/challenges\/([A-Za-z0-9-]+)\/submit$/.exec(sub)) && method === 'POST') {
          const rec = session(req, id, 'candidate');
          const bytes = await audio(), meta = captureMeta(req);   // content type is checked first
          return { status: 200, body: await service.submitChallenge(rec, r[1]!, bytes, meta, req.headers['x-transcript'], op()) };
        }
        if ((r = /^\/challenges\/([A-Za-z0-9-]+)\/assist$/.exec(sub)) && method === 'POST') {
          const rec = session(req, id, 'reviewer'); service.assistChallenge(rec, r[1]!, await jsonOnce()); return { status: 200, body: service.reviewerView(rec) };
        }
        if (sub === '/export' && method === 'GET') {
          const rec = session(req, id, 'reviewer');
          return { status: 200, body: service.exportSession(rec), headers: { 'content-disposition': `attachment; filename="switchguard-${id}.json"` } };
        }
        if (sub === '/profile' && method === 'DELETE') { const rec = session(req, id, 'reviewer'); await service.deleteProfile(rec); return { status: 200, body: service.reviewerView(rec) }; }
        return fail('method_not_allowed', 'Unsupported route or method', 405);
      };
      // Reads see the latest stored copy; writes are applied to it and replayed if another instance won.
      const reply = method === 'GET' ? (await service.pull(id), await route()) : (await service.mutate(id, route))!;
      if (reply.raw) { res.writeHead(reply.status, reply.headers); res.end(reply.raw); return; }
      send(res, reply.status, reply.body, reply.headers);
    } catch (error) {
      const e = error instanceof PipelineError ? error : new PipelineError('internal_error', 'Unexpected server error', 500);
      if (!(error instanceof PipelineError)) console.error(error);
      if (e.code === 'payload_too_large' && !res.headersSent) {
        // Answer 413 and close the connection. Moderately oversized bodies are discarded so the client
        // can read the answer; anything huge is cut off instead of being read.
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared <= 64 * 1024 * 1024) req.resume();
        else { res.setHeader('connection', 'close'); res.on('finish', () => req.destroy()); }
      }
      if (!res.headersSent) send(res, e.status, { error: { code: e.code, message: e.message } }); else res.end();
    }
  }
  return handle;
}

/** Long-running Node server (local and container hosting). */
export function createProductApp(service: SwitchGuardService, options: AppOptions) {
  const handle = createRequestHandler(service, options);
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 180_000; server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;   // longer than typical load-balancer idle timeouts
  return server;
}
