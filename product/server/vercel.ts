/** Vercel Function entry. One service per warm instance; all session state lives in the shared
 * Vercel Blob store (conditional writes), background DetectifAI checks run under waitUntil, and the
 * daily housekeeping runs from Vercel Cron. Static pages are served by Vercel's CDN. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { DetectifClient } from '../../src/server/detectif.js';
import { createRequestHandler } from './app.js';
import { SwitchGuardService, defaultConfig } from './service.js';
import { BlobStore } from './store.js';

const num = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const configProblems: string[] = [];
if (!process.env.REVIEWER_TOKEN || process.env.REVIEWER_TOKEN.length < 16) configProblems.push('REVIEWER_TOKEN (at least 16 characters) is not set');
if (!process.env.BLOB_READ_WRITE_TOKEN) configProblems.push('No Vercel Blob store is connected (BLOB_READ_WRITE_TOKEN missing)');

const service = new SwitchGuardService(new DetectifClient(process.env.DETECTIF_API_TOKEN || process.env.DETECTIF_API_KEY || undefined), {
  ...defaultConfig('/tmp/switchguard'),
  windowMs: num('WINDOW_MS', 7000, 5000, 60000),
  mediaRetentionHours: num('MEDIA_RETENTION_HOURS', 24, 1, 24 * 365),
  maxTargetedChecks: num('TARGETED_CHECKS', 8, 0, 200),
  sessionRetentionDays: num('SESSION_RETENTION_DAYS', 30, 0, 3650),
  lowCreditThreshold: num('LOW_CREDIT_THRESHOLD', 300, 0, 1_000_000),
  sharedStore: new BlobStore(),
  inlineVoice: true,
});

const hosts = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL, ...(process.env.ALLOWED_HOSTS ?? '').split(',')]
  .map(h => (h ?? '').trim().toLowerCase()).filter(Boolean);
const handle = createRequestHandler(service, {
  // Never fall back to a guessable token: without REVIEWER_TOKEN nobody can sign in as a reviewer.
  reviewerToken: process.env.REVIEWER_TOKEN && process.env.REVIEWER_TOKEN.length >= 16 ? process.env.REVIEWER_TOKEN : randomBytes(32).toString('hex'),
  root: process.cwd(),
  allowedHosts: hosts,
  trustProxy: true, judgeDemo: process.env.JUDGE_DEMO === '1',
  accessLog: process.env.ACCESS_LOG !== '0',
  cronSecret: process.env.CRON_SECRET,
});

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (configProblems.length && req.url?.startsWith('/api/health')) {
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, configuration: configProblems }));
    return;
  }
  await handle(req, res);
  // Provider checks and voice screening started by this request finish after the response.
  waitUntil(service.idle());
}
