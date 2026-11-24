#!/usr/bin/env node
// Kymo mock API server (no dependencies). Implements SPEC.md §2 (auth, loosely) and §4 (read API)
// with synthetic data so the web UI can be developed without the Rust server.
//
//   node mock/server.mjs [--port=8080] [--fresh] [--strict] [--latency=MS]
//
//   default   : seeded users, passkeys are not enforced for the admin (so the UI can be driven
//               by a browser without an authenticator).
//   --strict  : enforce passkey 2FA for the admin as in the spec (login -> enroll_passkey).
//   --fresh   : start with no users; a setup token is printed (implies --strict).
//
// Seeded test accounts (mock only):
//   admin / adminadmin123   (admin)
//   alice / alicealice123
//
// Any passkey is accepted: the mock only checks that clientDataJSON carries the expected
// challenge and type, which validates the browser-side base64url conversion.
// If ../dist exists it is also served with SPA fallback (to test the production build on :8080).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.replace(/^--/, '').split('=');
    return [m[0], m[1] ?? true];
  }),
);
const PORT = Number(args.port || process.env.PORT || 8080);
const FRESH = !!args.fresh;
const STRICT = FRESH || !!args.strict;
const LATENCY = Number(args.latency || 0);
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

// ---------------------------------------------------------------------------------------------
// helpers
const nowIso = () => new Date().toISOString();
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const randTok = (n = 32) => b64url(crypto.randomBytes(n));
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const base62 = (n) => Array.from(crypto.randomBytes(n), (b) => BASE62[b % 62]).join('');

class HttpError extends Error {
  constructor(status, code, msg) {
    super(msg || code);
    this.status = status;
    this.code = code;
  }
}
const err = (status, code, msg) => {
  throw new HttpError(status, code, msg);
};

function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = a.match(re) || [];
  const bx = b.match(re) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    if (x === y) continue;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return ax.length - bx.length;
}

// ---------------------------------------------------------------------------------------------
// state
let nextId = 1;
const id = () => nextId++;
const db = {
  users: [],
  sessions: new Map(), // token -> {userId, state, challenge?}
  invites: [],
  resets: [],
  tokens: [],
  projects: [],
  experiments: [],
  settings: { passkey_required_for_all: false },
  setupToken: null,
};

function addUser(username, password, isAdmin, display) {
  const u = {
    id: id(),
    username,
    display_name: display || username,
    is_admin: isAdmin,
    disabled: false,
    created_at: nowIso(),
    password,
    passkeys: [],
    last_login_at: null,
  };
  db.users.push(u);
  return u;
}

// --- synthetic metric data ----------------------------------------------------------------
function hash3(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c ^ 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296; // [0,1)
}

function makeKeys(nLayers) {
  const keys = [
    { key: 'train/loss', kind: 'loss', stride: 1 },
    { key: 'train/lr', kind: 'lr', stride: 1 },
    { key: 'train/grad_norm', kind: 'grad', stride: 1 },
    { key: 'train/tokens_per_sec', kind: 'tput', stride: 1 },
    { key: 'train/ppl', kind: 'ppl', stride: 1 },
    { key: 'train/loss_scale', kind: 'scale', stride: 1 },
    { key: 'eval/loss', kind: 'loss', stride: 1000, off: 0.08 },
    { key: 'eval/acc', kind: 'acc', stride: 1000 },
    { key: 'eval/ppl', kind: 'ppl', stride: 1000, off: 0.08 },
    { key: 'sys/gpu_util', kind: 'util', stride: 10 },
    { key: 'sys/mem_gb', kind: 'mem', stride: 10 },
    { key: 'epoch', kind: 'epoch', stride: 100 },
  ];
  for (let l = 0; l < nLayers; l++) {
    for (const m of ['attn_entropy', 'grad_norm', 'act_rms', 'weight_norm']) {
      keys.push({ key: `layer${l}/${m}`, kind: 'layer_' + m, stride: 10, layer: l });
    }
  }
  return keys;
}

// value at point index i (step = i*stride). returns NaN occasionally for grad norms.
function valueAt(exp, k, ki, step) {
  const s = exp.seed;
  const r = hash3(s, ki, step) * 2 - 1;
  const r2 = hash3(s + 17, ki, step);
  const T = exp.totalSteps;
  const x = step / T;
  const q = exp.quality; // 0.8..1.2 multiplicative (lower is better)
  switch (k.kind) {
    case 'loss': {
      const base = (1.7 + (k.off || 0)) * q + 6.5 * Math.pow(1 + step / 2000, -0.45);
      let v = base * (1 + 0.035 * r);
      if (r2 < 0.0004) v += 1.5 + 3 * r2 * 2500;
      return v;
    }
    case 'ppl': {
      const base = (1.7 + (k.off || 0)) * q + 6.5 * Math.pow(1 + step / 2000, -0.45);
      return Math.exp(Math.min(base * (1 + 0.02 * r), 12));
    }
    case 'acc':
      return Math.min(0.99, 0.25 + 0.6 * (1 - Math.pow(1 + step / 5000, -0.6)) / q + 0.01 * r);
    case 'lr': {
      const warm = exp.config.warmup;
      const peak = exp.config.lr;
      if (step < warm) return (peak * step) / warm;
      return peak * (0.1 + 0.9 * 0.5 * (1 + Math.cos((Math.PI * (step - warm)) / Math.max(1, T - warm))));
    }
    case 'grad': {
      if (r2 < 0.00002) return NaN;
      const v = 0.4 + 2.0 * Math.exp(-step / 3000) + 0.25 * Math.exp(1.2 * r);
      return r2 > 0.9995 ? v * 12 : v;
    }
    case 'tput':
      return 182000 * (1 + 0.03 * r) * (r2 < 0.002 ? 0.4 : 1) * (1 / q);
    case 'scale':
      return Math.pow(2, 16 - Math.floor(hash3(s, ki, Math.floor(step / 25000)) * 4));
    case 'util':
      return Math.min(100, 92 + 6 * r - (r2 < 0.01 ? 40 : 0));
    case 'mem':
      return 61.2 + 0.4 * Math.sin(step / 5000) + 0.05 * r + 2 * x;
    case 'epoch':
      return (step / T) * exp.config.epochs;
    case 'layer_attn_entropy':
      return 2.2 + 1.4 * Math.exp(-step / (4000 + k.layer * 300)) - 0.01 * k.layer + 0.05 * r;
    case 'layer_grad_norm': {
      if (r2 < 0.00002) return NaN;
      return (0.02 + 0.3 * Math.exp(-step / 5000)) * (1 + k.layer / 20) * Math.exp(0.3 * r);
    }
    case 'layer_act_rms':
      return 1 + 0.02 * k.layer + 0.3 * Math.log1p(step / 10000) + 0.03 * r;
    case 'layer_weight_norm':
      return 20 + k.layer * 0.5 + 8 * (1 - Math.exp(-step / 50000)) + 0.02 * r;
    default:
      return r;
  }
}

function tsAt(exp, step) {
  return exp.startTs + step * exp.secPerStep + hash3(exp.seed, 999, step) * exp.secPerStep * 0.5;
}

function lastStepOf(exp) {
  if (exp.status !== 'running') return exp.totalSteps;
  const elapsed = Date.now() / 1000 - exp.startTs;
  const s = Math.floor(elapsed / exp.secPerStep);
  if (s >= exp.totalSteps) return exp.totalSteps;
  return Math.max(0, s);
}

// points of a key: steps 0, stride, ..., <= last
function seriesInfo(exp, k) {
  const last = lastStepOf(exp);
  const n = Math.floor(last / k.stride) + 1;
  return { n, last: (n - 1) * k.stride };
}

const summaryCache = new Map();
function summarize(exp, ki) {
  const k = exp.keys[ki];
  const { n, last } = seriesInfo(exp, k);
  const ck = `${exp.id}|${ki}|${n}`;
  const c = summaryCache.get(ck);
  if (c) return c;
  let min = Infinity, max = -Infinity;
  const S = Math.min(n, 400);
  for (let j = 0; j < S; j++) {
    const i = Math.floor((j * (n - 1)) / Math.max(1, S - 1));
    const v = valueAt(exp, k, ki, i * k.stride);
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const lv = valueAt(exp, k, ki, last);
  const out = {
    key: k.key,
    count: n,
    first_step: 0,
    last_step: last,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    last_value: Number.isFinite(lv) ? lv : null,
    last_ts: tsAt(exp, last),
  };
  if (summaryCache.size > 20000) summaryCache.clear();
  summaryCache.set(ck, out);
  return out;
}

const SAMPLES_PER_BUCKET = 32;
function querySeries(exp, ki, maxPoints, stepMin, stepMax) {
  const k = exp.keys[ki];
  const { n } = seriesInfo(exp, k);
  let i0 = 0, i1 = n - 1;
  if (stepMin != null) i0 = Math.max(i0, Math.ceil(stepMin / k.stride));
  if (stepMax != null) i1 = Math.min(i1, Math.floor(stepMax / k.stride));
  const out = { experiment_id: exp.id, key: k.key, total: Math.max(0, i1 - i0 + 1), downsampled: false, step: [], value: [], ts: [] };
  if (i1 < i0) return out;
  const total = i1 - i0 + 1;
  const fin = (v) => (Number.isFinite(v) ? v : null);
  if (total <= maxPoints) {
    for (let i = i0; i <= i1; i++) {
      const st = i * k.stride;
      out.step.push(st);
      out.value.push(fin(valueAt(exp, k, ki, st)));
      out.ts.push(tsAt(exp, st));
    }
    return out;
  }
  out.downsampled = true;
  out.min = [];
  out.max = [];
  const s0 = i0 * k.stride, s1 = i1 * k.stride;
  const width = (s1 - s0 + 1) / maxPoints;
  for (let b = 0; b < maxPoints; b++) {
    const lo = s0 + b * width, hi = s0 + (b + 1) * width; // [lo, hi)
    const a = Math.ceil(lo / k.stride);
    const z = Math.min(i1, Math.ceil(hi / k.stride) - 1);
    if (z < a) continue;
    const cnt = z - a + 1;
    const S = Math.min(cnt, SAMPLES_PER_BUCKET);
    let sum = 0, nn = 0, mn = Infinity, mx = -Infinity;
    for (let j = 0; j < S; j++) {
      const i = S === 1 ? a : a + Math.floor((j * (cnt - 1)) / (S - 1));
      const v = valueAt(exp, k, ki, i * k.stride);
      if (Number.isFinite(v)) {
        sum += v;
        nn++;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    out.step.push(a * k.stride);
    out.value.push(nn ? sum / nn : null);
    out.min.push(nn ? mn : null);
    out.max.push(nn ? mx : null);
    out.ts.push(tsAt(exp, z * k.stride));
  }
  return out;
}

// --- seed ------------------------------------------------------------------------------------
function seedData() {
  const admin = addUser('admin', 'adminadmin123', true, 'Admin');
  const alice = addUser('alice', 'alicealice123', false, 'Alice');
  const now = Date.now() / 1000;
  const mkProject = (owner, name, description, shared) => {
    const p = { id: id(), owner_id: owner.id, name, description, shared, created_at: new Date((now - 86400 * 30) * 1000).toISOString() };
    db.projects.push(p);
    return p;
  };
  const mkExp = (p, name, o) => {
    const startTs = o.startTs;
    const e = {
      id: id(),
      project_id: p.id,
      name,
      status: o.status,
      config: o.config,
      tags: o.tags || [],
      notes: o.notes || '',
      created_at: new Date(startTs * 1000).toISOString(),
      host: o.host || 'node-' + Math.floor(Math.random() * 40),
      seed: o.seed,
      quality: o.quality,
      totalSteps: o.totalSteps,
      secPerStep: o.secPerStep,
      startTs,
      keys: o.keys,
      keyIndex: new Map(o.keys.map((k, i) => [k.key, i])),
    };
    if (o.status !== 'running') e.updated_at = new Date((startTs + o.totalSteps * o.secPerStep) * 1000).toISOString();
    db.experiments.push(e);
    return e;
  };

  const big = mkProject(admin, 'llm-pretrain', '7B decoder-only pretraining sweeps', false);
  const keys200 = makeKeys(47);
  const lrs = [3e-4, 6e-4, 1e-4, 3e-4, 1.5e-4, 6e-4, 3e-4, 2e-4, 4e-4, 3e-4];
  for (let i = 0; i < 10; i++) {
    const running = i >= 8;
    const total = 1_000_000;
    const sps = running ? 0.005 : 0.3; // running: 200 steps/s
    const start = running ? now - (i === 8 ? 600_000 : 350_000) * sps : now - 86400 * (20 - i);
    mkExp(big, `7b-lr${lrs[i].toExponential(0).replace('+', '')}-r${i}`, {
      status: running ? 'running' : i === 3 ? 'failed' : i === 5 ? 'crashed' : 'finished',
      seed: 1000 + i,
      quality: 0.85 + ((i * 37) % 10) / 25,
      totalSteps: i === 3 ? 420_000 : total,
      secPerStep: sps,
      startTs: start,
      keys: keys200,
      tags: [i % 2 ? 'baseline' : 'ablation', ...(i > 6 ? ['v2'] : [])],
      config: {
        lr: lrs[i],
        batch_size: [512, 1024, 2048][i % 3],
        warmup: 2000 + 500 * (i % 4),
        epochs: 1,
        optimizer: i % 3 === 0 ? 'adamw' : 'lion',
        seed: i,
        model: { d_model: 4096, n_layers: 32, n_heads: 32, rope_theta: i % 2 ? 10000 : 500000 },
        data: { dataset: 'fineweb-edu', tokens: '2T' },
      },
      host: `gpu-node-${10 + i}`,
    });
  }
  const vision = mkProject(admin, 'vision-sweep', 'ViT-B/16 ImageNet hyperparameter sweep', true);
  const keys30 = makeKeys(4).slice(0, 30);
  for (let i = 0; i < 6; i++) {
    mkExp(vision, `vit-b16-wd${(0.05 * (i + 1)).toFixed(2)}`, {
      status: i === 5 ? 'running' : 'finished',
      seed: 2000 + i,
      quality: 0.9 + i / 30,
      totalSteps: 100_000,
      secPerStep: i === 5 ? 0.02 : 0.5,
      startTs: i === 5 ? now - 40_000 * 0.02 : now - 86400 * (10 - i),
      keys: keys30,
      tags: ['vit'],
      config: { lr: 1e-3, weight_decay: 0.05 * (i + 1), batch_size: 4096, warmup: 5000, epochs: 300, model: { patch: 16, dim: 768 } },
    });
  }
  const rl = mkProject(alice, 'rl-agents', 'PPO on procgen', true);
  for (let i = 0; i < 4; i++) {
    mkExp(rl, `ppo-seed${i}`, {
      status: 'finished',
      seed: 3000 + i,
      quality: 1 + i / 20,
      totalSteps: 50_000,
      secPerStep: 1,
      startTs: now - 86400 * (5 - i),
      keys: makeKeys(0),
      tags: ['ppo'],
      config: { lr: 2.5e-4, gamma: 0.99, clip: 0.2, warmup: 100, epochs: 10 },
    });
  }
  mkProject(alice, 'scratch', 'empty project', false);
}

if (FRESH) {
  db.setupToken = randTok(24);
  console.log(`KYMO SETUP TOKEN: ${db.setupToken}  open http://localhost:5173/setup?token=${db.setupToken}`);
} else {
  seedData();
}

// ---------------------------------------------------------------------------------------------
// auth helpers
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function mustHavePasskey(u) {
  if (u.is_admin) return STRICT;
  return db.settings.passkey_required_for_all;
}

function newSession(res, user, state) {
  const tok = randTok(32);
  db.sessions.set(tok, { userId: user.id, state });
  res.setHeader('Set-Cookie', `kymo_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${14 * 86400}`);
  return state;
}

function ctxFor(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const t = db.tokens.find((x) => x.token === auth.slice(7));
    if (!t) err(401, 'invalid_token', 'invalid API token');
    const user = db.users.find((u) => u.id === t.user_id);
    if (!user || user.disabled) err(401, 'invalid_token', 'invalid API token');
    t.last_used_at = nowIso();
    return { user, state: 'full', bearer: true };
  }
  const tok = parseCookies(req).kymo_session;
  const s = tok && db.sessions.get(tok);
  if (!s) return { user: null, state: null, tok: null };
  const user = db.users.find((u) => u.id === s.userId);
  if (!user || user.disabled) {
    db.sessions.delete(tok);
    return { user: null, state: null, tok: null };
  }
  if (s.state === 'full' && mustHavePasskey(user) && user.passkeys.length === 0) s.state = 'enroll_passkey';
  return { user, state: s.state, tok, session: s };
}

function requireFull(ctx) {
  if (!ctx.user) err(401, 'unauthenticated', 'login required');
  if (ctx.state !== 'full') err(403, 'session_' + ctx.state, 'session not fully authenticated: ' + ctx.state);
}
function requireAdmin(ctx) {
  requireFull(ctx);
  if (ctx.bearer) err(403, 'forbidden', 'not allowed with API token');
  if (!ctx.user.is_admin) err(403, 'forbidden', 'admin only');
}
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 10) err(400, 'weak_password', 'password must be at least 10 characters');
}
function checkUsername(u) {
  if (typeof u !== 'string' || !/^[a-z0-9_.-]{2,32}$/.test(u)) err(400, 'invalid_username', 'username must match [a-z0-9_.-]{2,32}');
  if (db.users.some((x) => x.username === u)) err(409, 'username_taken', 'username already taken');
}

function canRead(ctx, p) {
  return ctx.user.is_admin || p.owner_id === ctx.user.id || p.shared;
}
function canWrite(ctx, p) {
  return ctx.user.is_admin || p.owner_id === ctx.user.id;
}
function getProject(ctx, pid, write = false) {
  const p = db.projects.find((x) => x.id === Number(pid));
  if (!p || !canRead(ctx, p)) err(404, 'not_found', 'project not found');
  if (write && !canWrite(ctx, p)) err(403, 'forbidden', 'read-only project');
  return p;
}
function getExp(ctx, eid, write = false) {
  const e = db.experiments.find((x) => x.id === Number(eid));
  if (!e) err(404, 'not_found', 'experiment not found');
  getProject(ctx, e.project_id, write);
  return e;
}

const userPublic = (u) => u && { id: u.id, username: u.username, display_name: u.display_name, is_admin: u.is_admin };
function projectJson(p) {
  const exps = db.experiments.filter((e) => e.project_id === p.id);
  const owner = db.users.find((u) => u.id === p.owner_id);
  let last = null;
  for (const e of exps) {
    const u = expUpdatedAt(e);
    if (!last || u > last) last = u;
  }
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    shared: p.shared,
    owner: { id: owner.id, username: owner.username },
    created_at: p.created_at,
    experiment_count: exps.length,
    last_activity: last,
  };
}
function expUpdatedAt(e) {
  if (e.status === 'running') {
    const last = lastStepOf(e);
    return new Date(tsAt(e, last) * 1000).toISOString();
  }
  return e.updated_at || e.created_at;
}
function expJson(e) {
  return {
    id: e.id,
    name: e.name,
    status: e.status === 'running' && lastStepOf(e) >= e.totalSteps ? 'finished' : e.status,
    tags: e.tags,
    notes: e.notes,
    created_at: e.created_at,
    updated_at: expUpdatedAt(e),
    host: e.host,
    config: e.config,
    metric_count: e.keys.length,
    last_step: lastStepOf(e),
  };
}

function challengeOf(cred) {
  try {
    const cd = JSON.parse(Buffer.from(cred.response.clientDataJSON, 'base64url').toString('utf8'));
    return cd;
  } catch {
    err(400, 'invalid_credential', 'cannot decode clientDataJSON');
  }
}

// ---------------------------------------------------------------------------------------------
// routes
const routes = [];
const route = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, fn });
};

route('GET', '/api/v1/auth/state', (ctx) => ({
  setup_required: db.users.length === 0,
  session_state: ctx.user ? ctx.state : null,
  user: ctx.user ? userPublic(ctx.user) : null,
  policy: { passkey_required_for_all: db.settings.passkey_required_for_all },
  version: '0.1.0-mock',
}));

route('POST', '/api/v1/auth/setup', (ctx, b, req, res) => {
  if (db.users.length > 0 || !db.setupToken) err(409, 'already_setup', 'setup already done');
  if (b.setup_token !== db.setupToken) err(403, 'invalid_setup_token', 'invalid setup token');
  checkUsername(b.username);
  checkPassword(b.password);
  const u = addUser(b.username, b.password, true, b.display_name);
  db.setupToken = null;
  seedForFreshAdmin(u);
  return { state: newSession(res, u, 'enroll_passkey') };
});

function seedForFreshAdmin(u) {
  // give a fresh admin something to look at
  const before = db.users.length;
  const savedUsers = db.users.slice();
  seedData();
  // re-own seeded admin data by the new admin and drop the seeded users except alice
  const seededAdmin = db.users.find((x) => x.username === 'admin' && x !== u);
  for (const p of db.projects) if (seededAdmin && p.owner_id === seededAdmin.id) p.owner_id = u.id;
  db.users = db.users.filter((x) => x !== seededAdmin || savedUsers.includes(x));
  void before;
}

route('GET', '/api/v1/auth/invite/:token', (ctx, b, req, res, p) => {
  const inv = db.invites.find((i) => i.token === p.token && !i.used_at && new Date(i.expires_at) > new Date());
  return inv ? { valid: true, username: inv.username || undefined } : { valid: false };
});

route('POST', '/api/v1/auth/signup', (ctx, b, req, res) => {
  const inv = db.invites.find((i) => i.token === b.invite_token && !i.used_at && new Date(i.expires_at) > new Date());
  if (!inv) err(400, 'invalid_invite', 'invite is invalid or expired');
  if (inv.username && inv.username !== b.username) err(400, 'username_mismatch', 'this invite is for ' + inv.username);
  checkUsername(b.username);
  checkPassword(b.password);
  const u = addUser(b.username, b.password, false, b.display_name);
  inv.used_at = nowIso();
  return { state: newSession(res, u, mustHavePasskey(u) ? 'enroll_passkey' : 'full') };
});

route('POST', '/api/v1/auth/reset', (ctx, b) => {
  const r = db.resets.find((x) => x.token === b.reset_token && !x.used_at && new Date(x.expires_at) > new Date());
  if (!r) err(400, 'invalid_reset', 'reset link is invalid or expired');
  checkPassword(b.password);
  const u = db.users.find((x) => x.id === r.user_id);
  if (!u) err(400, 'invalid_reset', 'user gone');
  u.password = b.password;
  r.used_at = nowIso();
  for (const [k, s] of db.sessions) if (s.userId === u.id) db.sessions.delete(k);
  return { ok: true };
});

route('POST', '/api/v1/auth/login', (ctx, b, req, res) => {
  const u = db.users.find((x) => x.username === b.username);
  if (!u || u.password !== b.password || u.disabled) err(401, 'invalid_credentials', 'invalid username or password');
  u.last_login_at = nowIso();
  let state = 'full';
  if (u.passkeys.length > 0) state = 'passkey_required';
  else if (mustHavePasskey(u)) state = 'enroll_passkey';
  return { state: newSession(res, u, state) };
});

route('POST', '/api/v1/auth/logout', (ctx, b, req, res) => {
  if (ctx.tok) db.sessions.delete(ctx.tok);
  res.setHeader('Set-Cookie', 'kymo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return { ok: true };
});

route('POST', '/api/v1/auth/password', (ctx, b) => {
  requireFull(ctx);
  if (ctx.user.password !== b.old_password) err(403, 'invalid_credentials', 'current password is wrong');
  checkPassword(b.new_password);
  ctx.user.password = b.new_password;
  return { ok: true };
});

route('POST', '/api/v1/auth/passkey/register/start', (ctx, b, req) => {
  if (!ctx.user) err(401, 'unauthenticated', 'login required');
  if (ctx.state !== 'full' && ctx.state !== 'enroll_passkey') err(403, 'forbidden', 'not allowed in state ' + ctx.state);
  const challenge = randTok(32);
  ctx.session.challenge = { kind: 'register', challenge, at: Date.now() };
  const rpId = (req.headers.host || 'localhost').split(':')[0];
  return {
    publicKey: {
      rp: { name: 'Kymo', id: rpId },
      user: { id: b64url(Buffer.from('user-' + ctx.user.id)), name: ctx.user.username, displayName: ctx.user.display_name },
      challenge,
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 300000,
      attestation: 'none',
      excludeCredentials: ctx.user.passkeys.map((p) => ({ type: 'public-key', id: p.cred_id })),
      authenticatorSelection: { residentKey: 'discouraged', requireResidentKey: false, userVerification: 'preferred' },
      extensions: { credProps: true },
    },
  };
});

route('POST', '/api/v1/auth/passkey/register/finish', (ctx, b) => {
  if (!ctx.user) err(401, 'unauthenticated', 'login required');
  const ch = ctx.session?.challenge;
  if (!ch || ch.kind !== 'register' || Date.now() - ch.at > 300000) err(400, 'no_challenge', 'no pending registration');
  const c = b.credential;
  if (!c || c.type !== 'public-key' || !c.rawId || !c.response?.attestationObject) err(400, 'invalid_credential', 'malformed credential');
  const cd = challengeOf(c);
  if (cd.type !== 'webauthn.create' || cd.challenge !== ch.challenge) err(400, 'invalid_credential', 'challenge mismatch');
  ctx.session.challenge = null;
  const pk = { id: id(), name: String(b.name || 'passkey'), created_at: nowIso(), last_used_at: null, cred_id: c.rawId };
  ctx.user.passkeys.push(pk);
  if (ctx.session.state === 'enroll_passkey') ctx.session.state = 'full';
  return { id: pk.id, name: pk.name, created_at: pk.created_at };
});

route('POST', '/api/v1/auth/passkey/login/start', (ctx, b, req) => {
  if (!ctx.user || ctx.state !== 'passkey_required') err(403, 'forbidden', 'not in passkey_required state');
  const challenge = randTok(32);
  ctx.session.challenge = { kind: 'login', challenge, at: Date.now() };
  return {
    publicKey: {
      challenge,
      timeout: 300000,
      rpId: (req.headers.host || 'localhost').split(':')[0],
      allowCredentials: ctx.user.passkeys.map((p) => ({ type: 'public-key', id: p.cred_id })),
      userVerification: 'preferred',
    },
  };
});

route('POST', '/api/v1/auth/passkey/login/finish', (ctx, b) => {
  if (!ctx.user || ctx.state !== 'passkey_required') err(403, 'forbidden', 'not in passkey_required state');
  const ch = ctx.session.challenge;
  if (!ch || ch.kind !== 'login') err(400, 'no_challenge', 'no pending login');
  const c = b.credential;
  if (!c?.response?.signature || !c.response.authenticatorData) err(400, 'invalid_credential', 'malformed credential');
  const cd = challengeOf(c);
  if (cd.type !== 'webauthn.get' || cd.challenge !== ch.challenge) err(400, 'invalid_credential', 'challenge mismatch');
  const pk = ctx.user.passkeys.find((p) => p.cred_id === c.rawId);
  if (!pk) err(400, 'unknown_credential', 'unknown passkey');
  pk.last_used_at = nowIso();
  ctx.session.challenge = null;
  ctx.session.state = 'full';
  return { state: 'full' };
});

route('GET', '/api/v1/auth/passkeys', (ctx) => {
  requireFull(ctx);
  return ctx.user.passkeys.map(({ id, name, created_at, last_used_at }) => ({ id, name, created_at, last_used_at }));
});
route('DELETE', '/api/v1/auth/passkeys/:id', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const u = ctx.user;
  const i = u.passkeys.findIndex((x) => x.id === Number(p.id));
  if (i < 0) err(404, 'not_found', 'passkey not found');
  if (u.passkeys.length === 1 && mustHavePasskey(u)) err(409, 'last_passkey', 'cannot delete your last passkey');
  u.passkeys.splice(i, 1);
  return { ok: true };
});

// tokens
route('POST', '/api/v1/tokens', (ctx, b) => {
  requireFull(ctx);
  if (ctx.bearer) err(403, 'forbidden', 'not allowed with API token');
  const token = 'kymo_' + base62(40);
  const t = { id: id(), user_id: ctx.user.id, name: String(b.name || 'token'), token, created_at: nowIso(), last_used_at: null };
  db.tokens.push(t);
  return { id: t.id, name: t.name, token, created_at: t.created_at };
});
route('GET', '/api/v1/tokens', (ctx) => {
  requireFull(ctx);
  if (ctx.bearer) err(403, 'forbidden', 'not allowed with API token');
  return db.tokens
    .filter((t) => t.user_id === ctx.user.id)
    .map((t) => ({ id: t.id, name: t.name, prefix: t.token.slice(0, 9), created_at: t.created_at, last_used_at: t.last_used_at }));
});
route('DELETE', '/api/v1/tokens/:id', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const i = db.tokens.findIndex((t) => t.id === Number(p.id) && t.user_id === ctx.user.id);
  if (i < 0) err(404, 'not_found', 'token not found');
  db.tokens.splice(i, 1);
  return { ok: true };
});

// admin
route('GET', '/api/v1/admin/users', (ctx) => {
  requireAdmin(ctx);
  return db.users.map((u) => ({ ...userPublic(u), disabled: u.disabled, created_at: u.created_at, passkey_count: u.passkeys.length, last_login_at: u.last_login_at }));
});
route('PATCH', '/api/v1/admin/users/:id', (ctx, b, req, res, p) => {
  requireAdmin(ctx);
  const u = db.users.find((x) => x.id === Number(p.id));
  if (!u) err(404, 'not_found', 'user not found');
  if (b.disabled != null) {
    if (u.id === ctx.user.id && b.disabled) err(400, 'self', 'cannot disable yourself');
    u.disabled = !!b.disabled;
    if (u.disabled) for (const [k, s] of db.sessions) if (s.userId === u.id) db.sessions.delete(k);
  }
  if (b.reset_passkeys) {
    u.passkeys = [];
    for (const s of db.sessions.values()) if (s.userId === u.id && mustHavePasskey(u)) s.state = 'enroll_passkey';
  }
  if (typeof b.display_name === 'string') u.display_name = b.display_name;
  return { ...userPublic(u), disabled: u.disabled, created_at: u.created_at, passkey_count: u.passkeys.length, last_login_at: u.last_login_at };
});
route('DELETE', '/api/v1/admin/users/:id', (ctx, b, req, res, p) => {
  requireAdmin(ctx);
  const uid = Number(p.id);
  if (uid === ctx.user.id) err(400, 'self', 'cannot delete yourself');
  if (!db.users.some((u) => u.id === uid)) err(404, 'not_found', 'user not found');
  db.users = db.users.filter((u) => u.id !== uid);
  const pids = new Set(db.projects.filter((x) => x.owner_id === uid).map((x) => x.id));
  db.projects = db.projects.filter((x) => !pids.has(x.id));
  db.experiments = db.experiments.filter((e) => !pids.has(e.project_id));
  for (const [k, s] of db.sessions) if (s.userId === uid) db.sessions.delete(k);
  db.tokens = db.tokens.filter((t) => t.user_id !== uid);
  return { ok: true };
});
route('POST', '/api/v1/admin/users/:id/reset-password', (ctx, b, req, res, p) => {
  requireAdmin(ctx);
  const u = db.users.find((x) => x.id === Number(p.id));
  if (!u) err(404, 'not_found', 'user not found');
  const token = randTok(24);
  const r = { token, user_id: u.id, expires_at: new Date(Date.now() + 72 * 3600e3).toISOString(), used_at: null };
  db.resets.push(r);
  return { url: `${origin(req)}/signup?reset=${token}`, token, expires_at: r.expires_at };
});
route('POST', '/api/v1/admin/invites', (ctx, b, req) => {
  requireAdmin(ctx);
  if (b.username != null && b.username !== '' && !/^[a-z0-9_.-]{2,32}$/.test(b.username)) err(400, 'invalid_username', 'invalid username');
  const token = randTok(24);
  const hours = Number(b.expires_hours || 72);
  const inv = { id: id(), token, username: b.username || null, expires_at: new Date(Date.now() + hours * 3600e3).toISOString(), used_at: null, created_at: nowIso() };
  db.invites.push(inv);
  return { id: inv.id, token, url: `${origin(req)}/signup?invite=${token}`, username: inv.username, expires_at: inv.expires_at };
});
route('GET', '/api/v1/admin/invites', (ctx) => {
  requireAdmin(ctx);
  return db.invites.map(({ id, username, expires_at, used_at, created_at }) => ({ id, username, expires_at, used_at, created_at })).reverse();
});
route('DELETE', '/api/v1/admin/invites/:id', (ctx, b, req, res, p) => {
  requireAdmin(ctx);
  db.invites = db.invites.filter((i) => i.id !== Number(p.id));
  return { ok: true };
});
route('GET', '/api/v1/admin/settings', (ctx) => {
  requireAdmin(ctx);
  return db.settings;
});
route('PUT', '/api/v1/admin/settings', (ctx, b) => {
  requireAdmin(ctx);
  db.settings.passkey_required_for_all = !!b.passkey_required_for_all;
  return db.settings;
});

function origin(req) {
  // behind the Vite proxy the browser origin is in Origin/Referer
  const o = req.headers.origin;
  if (o) return o;
  const ref = req.headers.referer;
  if (ref) return new URL(ref).origin;
  return `http://${req.headers.host}`;
}

// projects
route('GET', '/api/v1/projects', (ctx) => {
  requireFull(ctx);
  return db.projects.filter((p) => canRead(ctx, p)).map(projectJson);
});
route('POST', '/api/v1/projects', (ctx, b) => {
  requireFull(ctx);
  if (typeof b.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(b.name)) err(400, 'invalid_name', 'name must match [A-Za-z0-9_.-]{1,64}');
  if (db.projects.some((p) => p.owner_id === ctx.user.id && p.name === b.name)) err(409, 'name_taken', 'project exists');
  const p = { id: id(), owner_id: ctx.user.id, name: b.name, description: b.description || '', shared: false, created_at: nowIso() };
  db.projects.push(p);
  return projectJson(p);
});
route('GET', '/api/v1/projects/:id', (ctx, b, req, res, p) => {
  requireFull(ctx);
  return projectJson(getProject(ctx, p.id));
});
route('PATCH', '/api/v1/projects/:id', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const pr = getProject(ctx, p.id, true);
  if (b.name != null) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(b.name)) err(400, 'invalid_name', 'name must match [A-Za-z0-9_.-]{1,64}');
    if (db.projects.some((x) => x !== pr && x.owner_id === pr.owner_id && x.name === b.name)) err(409, 'name_taken', 'project exists');
    pr.name = b.name;
  }
  if (b.description != null) pr.description = String(b.description);
  if (b.shared != null) pr.shared = !!b.shared;
  return projectJson(pr);
});
route('DELETE', '/api/v1/projects/:id', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const pr = getProject(ctx, p.id, true);
  db.projects = db.projects.filter((x) => x !== pr);
  db.experiments = db.experiments.filter((e) => e.project_id !== pr.id);
  return { ok: true };
});
route('GET', '/api/v1/projects/:id/experiments', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const pr = getProject(ctx, p.id);
  return db.experiments
    .filter((e) => e.project_id === pr.id)
    .sort((a, b2) => (a.created_at < b2.created_at ? 1 : -1))
    .map(expJson);
});
route('GET', '/api/v1/projects/:id/metric-keys', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const pr = getProject(ctx, p.id);
  const s = new Set();
  for (const e of db.experiments) if (e.project_id === pr.id) for (const k of e.keys) s.add(k.key);
  return [...s].sort(naturalCompare);
});

// experiments
route('GET', '/api/v1/experiments/:id', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const e = getExp(ctx, p.id);
  const pr = db.projects.find((x) => x.id === e.project_id);
  return { ...expJson(e), project: { id: pr.id, name: pr.name } };
});
route('PATCH', '/api/v1/experiments/:id', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const e = getExp(ctx, p.id, true);
  if (b.name != null) e.name = String(b.name).slice(0, 128);
  if (Array.isArray(b.tags)) e.tags = b.tags.map(String);
  if (b.notes != null) e.notes = String(b.notes);
  if (b.status != null) {
    if (!['running', 'finished', 'failed', 'crashed'].includes(b.status)) err(400, 'invalid_status', 'bad status');
    if (e.status === 'running' && b.status !== 'running') e.totalSteps = lastStepOf(e);
    e.status = b.status;
  }
  const pr = db.projects.find((x) => x.id === e.project_id);
  return { ...expJson(e), project: { id: pr.id, name: pr.name } };
});
route('DELETE', '/api/v1/experiments/:id', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const e = getExp(ctx, p.id, true);
  db.experiments = db.experiments.filter((x) => x !== e);
  return { ok: true };
});
route('GET', '/api/v1/experiments/:id/metrics', (ctx, b, req, res, p) => {
  requireFull(ctx);
  const e = getExp(ctx, p.id);
  return e.keys.map((_, i) => summarize(e, i)).sort((a, b2) => naturalCompare(a.key, b2.key));
});

route('POST', '/api/v1/series/query', (ctx, b) => {
  requireFull(ctx);
  if (!Array.isArray(b.series)) err(400, 'bad_request', 'series must be an array');
  const mp = Math.max(1, Math.min(20000, Number(b.max_points || 2000)));
  const smin = b.step_min == null ? null : Number(b.step_min);
  const smax = b.step_max == null ? null : Number(b.step_max);
  const t0 = performance.now();
  const out = b.series.map((s) => {
    const e = db.experiments.find((x) => x.id === Number(s.experiment_id));
    if (!e) return { experiment_id: s.experiment_id, key: s.key, total: 0, downsampled: false, step: [], value: [], ts: [] };
    getProject(ctx, e.project_id);
    const ki = e.keyIndex.get(s.key);
    if (ki == null) return { experiment_id: e.id, key: s.key, total: 0, downsampled: false, step: [], value: [], ts: [] };
    return querySeries(e, ki, mp, smin, smax);
  });
  stats.queries++;
  stats.series += out.length;
  stats.ms += performance.now() - t0;
  return { series: out };
});

route('GET', '/api/v1/series/raw', (ctx, b, req, res, p, url) => {
  requireFull(ctx);
  const e = getExp(ctx, url.searchParams.get('experiment_id'));
  const key = url.searchParams.get('key');
  const ki = e.keyIndex.get(key);
  if (ki == null) err(404, 'not_found', 'no such series');
  const fmt = url.searchParams.get('format') || 'csv';
  const k = e.keys[ki];
  const { n } = seriesInfo(e, k);
  res.writeHead(200, {
    'Content-Type': fmt === 'json' ? 'application/json' : 'text/csv',
    'Content-Disposition': `attachment; filename="${e.name}-${key.replace(/\//g, '_')}.${fmt}"`,
  });
  let i = 0;
  if (fmt === 'json') res.write('{"step":[');
  else res.write('step,value,ts\n');
  const pump = () => {
    let chunk = '';
    const end = Math.min(n, i + 20000);
    for (; i < end; i++) {
      const st = i * k.stride;
      const v = valueAt(e, k, ki, st);
      if (fmt === 'json') chunk += (i ? ',' : '') + st;
      else chunk += `${st},${Number.isFinite(v) ? v : 'NaN'},${tsAt(e, st).toFixed(3)}\n`;
    }
    if (chunk && !res.write(chunk)) {
      if (i < n) return res.once('drain', pump);
    }
    if (i < n) return setImmediate(pump);
    if (fmt === 'json') {
      // second & third pass for value/ts (simple, it's a mock)
      const vals = [], tss = [];
      for (let j = 0; j < n; j++) {
        const v = valueAt(e, k, ki, j * k.stride);
        vals.push(Number.isFinite(v) ? v : null);
        tss.push(tsAt(e, j * k.stride));
      }
      res.end(`],"value":${JSON.stringify(vals)},"ts":${JSON.stringify(tss)}}`);
    } else res.end();
  };
  pump();
  return undefined; // streamed
});

const stats = { queries: 0, series: 0, ms: 0 };
setInterval(() => {
  if (stats.queries) {
    console.log(`[mock] series/query: ${stats.queries} req, ${stats.series} series, ${(stats.ms / stats.queries).toFixed(1)} ms avg`);
    stats.queries = stats.series = stats.ms = 0;
  }
}, 10000).unref();

// ---------------------------------------------------------------------------------------------
// http server
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('mock: no web/dist build (use the Vite dev server on :5173)');
  }
  let f = path.join(DIST, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  const ext = path.extname(f);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (pathname.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  res.writeHead(200, headers);
  fs.createReadStream(f).pipe(res);
}

function send(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json' };
  if (body.length > 4096 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    return res.end(zlib.gzipSync(body, { level: 1 }));
  }
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY));
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) err(404, 'not_found', 'no route ' + req.method + ' ' + url.pathname);
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = {};
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          err(400, 'bad_json', 'malformed JSON body');
        }
      }
      const ctx = ctxFor(req);
      if (req.method !== 'GET' && !ctx.bearer && req.headers['x-kymo-csrf'] !== '1') err(403, 'csrf', 'missing X-Kymo-CSRF header');
      const out = await r.fn(ctx, body, req, res, params, url);
      if (out !== undefined) send(req, res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) send(req, res, e.status, { error: e.message, code: e.code });
      else {
        console.error(e);
        send(req, res, 500, { error: String(e?.message || e), code: 'internal' });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`kymo mock API on http://localhost:${PORT} (${FRESH ? 'fresh' : 'seeded'}${STRICT ? ', strict passkeys' : ''})`);
  if (!FRESH) console.log('  users: admin / adminadmin123 (admin), alice / alicealice123');
});
