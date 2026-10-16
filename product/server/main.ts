import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DetectifClient } from '../../src/server/detectif.js';
import { createProductApp } from './app.js';
import { SwitchGuardService, defaultConfig } from './service.js';

// dist/product/server/main.js → repo root is four levels up.
const root = resolve(fileURLToPath(import.meta.url), '../../../../..');

/** Fails fast with a readable message instead of misbehaving later. */
function configError(message: string): never { console.error(`Configuration error: ${message}`); process.exit(2); }
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) configError(`${name} must be a number between ${min} and ${max} (got "${raw}")`);
  return n;
}

const port = intEnv('PORT', 3000, 1, 65535);
const bind = process.env.BIND_HOST ?? '127.0.0.1';
const production = process.env.NODE_ENV === 'production';
const reviewerToken = process.env.REVIEWER_TOKEN || randomBytes(18).toString('base64url');
if (production && !process.env.REVIEWER_TOKEN) configError('set REVIEWER_TOKEN in production');
if (process.env.REVIEWER_TOKEN && process.env.REVIEWER_TOKEN.length < 16) configError('REVIEWER_TOKEN must be at least 16 characters');
const allowedHosts = (process.env.ALLOWED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (production && bind !== '127.0.0.1' && !allowedHosts.length) configError('set ALLOWED_HOSTS (your public host name) when serving publicly');

const dataDir = resolve(process.env.DATA_DIR ?? resolve(root, 'product/data'));
try {
  mkdirSync(join(dataDir, 'sessions'), { recursive: true }); mkdirSync(join(dataDir, 'media'), { recursive: true });
  const probe = join(dataDir, `.write-probe-${process.pid}`); writeFileSync(probe, 'ok'); rmSync(probe);
} catch (error) { configError(`DATA_DIR ${dataDir} is not writable (${(error as Error).message})`); }

const config = {
  ...defaultConfig(dataDir),
  windowMs: intEnv('WINDOW_MS', 7000, 5000, 60000),
  mediaRetentionHours: intEnv('MEDIA_RETENTION_HOURS', 24, 1, 24 * 365),
  maxTargetedChecks: intEnv('TARGETED_CHECKS', 8, 0, 200),
  sessionRetentionDays: intEnv('SESSION_RETENTION_DAYS', 30, 0, 3650),
  lowCreditThreshold: intEnv('LOW_CREDIT_THRESHOLD', 300, 0, 1_000_000),
};
const client = new DetectifClient(process.env.DETECTIF_API_TOKEN || process.env.DETECTIF_API_KEY || undefined);
const service = new SwitchGuardService(client, config);
service.load();
const purged = service.sweepRetention();

const server = createProductApp(service, { reviewerToken, root, allowedHosts, trustProxy: process.env.TRUST_PROXY === '1', accessLog: process.env.ACCESS_LOG !== '0' });

// Housekeeping: media retention every 5 minutes, whole-session expiry every hour.
const sweep = setInterval(() => { try { service.sweepRetention(); } catch (error) { console.error('Retention sweep failed', error); } }, 5 * 60_000);
const expire = () => service.expireSessions().then(r => { if (r.deleted || r.failed) console.log(`Session expiry: ${r.deleted} deleted, ${r.failed} to retry`); }, error => console.error('Session expiry failed', error));
const expiry = setInterval(() => void expire(), 60 * 60_000);
sweep.unref(); expiry.unref(); void expire();

server.on('error', (error: NodeJS.ErrnoException) => {
  configError(error.code === 'EADDRINUSE' ? `port ${port} is already in use` : `server error: ${error.message}`);
});
server.listen(port, bind, () => {
  console.log(`SwitchGuard: http://${bind === '0.0.0.0' ? 'localhost' : bind}:${port}`);
  console.log(`DetectifAI credentials: ${client.configured ? 'configured (server-side only)' : 'MISSING — checks will be reported as failed, never as passed'}`);
  console.log(process.env.REVIEWER_TOKEN ? 'Reviewer token: from REVIEWER_TOKEN' : `Reviewer token (this run only): ${reviewerToken}`);
  console.log(`Media retention: ${config.mediaRetentionHours} h; session retention: ${config.sessionRetentionDays || 'off'} days; purged at startup: ${purged}; sessions loaded: ${service.records.size}`);
});

// ---------- crash safety and graceful shutdown ----------
let stopping = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Shutting down (${reason})…`);
  const hardStop = setTimeout(() => { service.flush(); process.exit(code); }, 10_000);
  hardStop.unref();
  server.close();
  try { await service.idle(); } catch { /* flushed below */ }
  service.flush();
  await service.voice.close().catch(() => undefined);
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// A stray rejection in a background task must not take the server down.
process.on('unhandledRejection', (error) => console.error('Unhandled rejection (server keeps running):', error));
// An exception that escaped every handler leaves unknown state: save what we have and let the supervisor restart us.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception, saving and restarting:', error);
  try { service.flush(); } catch { /* best effort */ }
  void shutdown('uncaught exception', 1);
});
