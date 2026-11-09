#!/usr/bin/env node
// Sums Claude Code transcript usage per role (controller, implementer, task reviewer, final reviewer, other).
// Usage: node usage.mjs <projectDir> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--sessions id,id] [--out file.md]
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!dir || !existsSync(dir)) {
  console.error('Usage: node usage.mjs <projectDir> [--from D] [--to D] [--sessions a,b] [--out file.md]');
  process.exit(2);
}
const from = flag('from');
const to = flag('to');
const wanted = flag('sessions')?.split(',');

const readJsonl = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ');

// Role comes from the dispatch description first, then the prompt head. Keywords only, never stored.
const classify = (description = '', prompt = '') => {
  const d = description.toLowerCase();
  const p = prompt.slice(0, 600).toLowerCase();
  const hay = `${d} ${p}`;
  const review = /review/.test(d) || /(code[- ]?review|spec[- ]?(compliance )?review|you are reviewing)/.test(p);
  if (review && /(final|whole|entire|overall)/.test(d)) return 'final reviewer';
  if (review) return 'task reviewer';
  if (/implement|task \d+|build/.test(d) || /you are implementing|implement task/.test(p)) return 'implementer';
  if (/final review/.test(hay)) return 'final reviewer';
  return 'other';
};

// Streamed duplicates share a message id, and later records carry the final counts, so keep the max per field.
const collect = (records) => {
  const byId = new Map();
  for (const r of records) {
    if (r.type !== 'assistant' || !r.message?.usage) continue;
    const m = r.message;
    if (m.model === '<synthetic>') continue;
    const u = m.usage;
    const cur = byId.get(m.id) ?? { model: m.model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    cur.input = Math.max(cur.input, u.input_tokens ?? 0);
    cur.cacheRead = Math.max(cur.cacheRead, u.cache_read_input_tokens ?? 0);
    cur.cacheWrite = Math.max(cur.cacheWrite, u.cache_creation_input_tokens ?? 0);
    cur.output = Math.max(cur.output, u.output_tokens ?? 0);
    byId.set(m.id, cur);
  }
  return [...byId.values()];
};

const sessions = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  const id = f.slice(0, -6);
  if (wanted && !wanted.includes(id)) continue;
  const recs = readJsonl(join(dir, f));
  const firstTs = recs.find((r) => r.timestamp)?.timestamp?.slice(0, 10);
  if (from && (!firstTs || firstTs < from)) continue;
  if (to && (!firstTs || firstTs > to)) continue;
  sessions.push({ id, firstTs, recs, file: f });
}

const rows = new Map();
const add = (role, entries, unit) => {
  for (const e of entries) {
    const key = `${role}\t${e.model}`;
    const r = rows.get(key) ?? { role, model: e.model, turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    r.turns++;
    r.input += e.input;
    r.cacheRead += e.cacheRead;
    r.cacheWrite += e.cacheWrite;
    r.output += e.output;
    rows.set(key, r);
  }
  if (unit) unit.count++;
};
const units = { implementer: { count: 0 }, 'task reviewer': { count: 0 }, 'final reviewer': { count: 0 } };

for (const s of sessions) {
  add('controller', collect(s.recs));
  const subDir = join(dir, s.id, 'subagents');
  if (!existsSync(subDir) || !statSync(subDir).isDirectory()) continue;
  for (const f of readdirSync(subDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const base = f.slice(0, -6);
    const metaPath = join(subDir, `${base}.meta.json`);
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
    const recs = readJsonl(join(subDir, f));
    const firstUser = recs.find((r) => r.type === 'user');
    const role = classify(meta.description, textOf(firstUser?.message?.content));
    add(role, collect(recs), units[role]);
  }
}

const order = ['controller', 'implementer', 'task reviewer', 'final reviewer', 'other'];
const list = [...rows.values()].sort(
  (a, b) => order.indexOf(a.role) - order.indexOf(b.role) || b.output - a.output,
);
const n = (x) => x.toLocaleString('en-US');
const sum = (arr, k) => arr.reduce((t, r) => t + r[k], 0);
const total = (r) => r.input + r.cacheRead + r.cacheWrite + r.output;

const out = [];
out.push('# Spike 0.7 usage baseline', '');
out.push('## Sessions used', '');
for (const s of sessions) out.push(`- ${s.id} (first record ${s.firstTs ?? 'unknown'})`);
out.push('', '## Usage by role', '');
out.push('| Role | Model | Turns | Input | Cache read | Cache write | Output |');
out.push('|---|---|---:|---:|---:|---:|---:|');
for (const r of list)
  out.push(`| ${r.role} | ${r.model} | ${n(r.turns)} | ${n(r.input)} | ${n(r.cacheRead)} | ${n(r.cacheWrite)} | ${n(r.output)} |`);
out.push(
  `| **Total** | | ${n(sum(list, 'turns'))} | ${n(sum(list, 'input'))} | ${n(sum(list, 'cacheRead'))} | ${n(sum(list, 'cacheWrite'))} | ${n(sum(list, 'output'))} |`,
);
const grand = list.reduce((t, r) => t + total(r), 0);
const ctl = list.filter((r) => r.role === 'controller');
const ctlAll = ctl.reduce((t, r) => t + total(r), 0);
const ctlFresh = sum(ctl, 'input') + sum(ctl, 'cacheWrite') + sum(ctl, 'output');
const grandFresh = sum(list, 'input') + sum(list, 'cacheWrite') + sum(list, 'output');
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '0.0');
out.push('', '## Controller share', '');
out.push(`- All tokens: ${pct(ctlAll, grand)}% (${n(ctlAll)} of ${n(grand)})`);
out.push(`- Excluding cache reads: ${pct(ctlFresh, grandFresh)}% (${n(ctlFresh)} of ${n(grandFresh)})`);
out.push('', '## Per-unit averages', '');
out.push('| Role | Units | Turns | Input | Cache read | Cache write | Output |');
out.push('|---|---:|---:|---:|---:|---:|---:|');
for (const role of Object.keys(units)) {
  const c = units[role].count;
  const rs = list.filter((r) => r.role === role);
  const avg = (k) => (c ? n(Math.round(sum(rs, k) / c)) : 'n/a');
  out.push(`| ${role} | ${c} | ${avg('turns')} | ${avg('input')} | ${avg('cacheRead')} | ${avg('cacheWrite')} | ${avg('output')} |`);
}
const text = out.join('\n') + '\n';
const outFile = flag('out');
if (outFile) writeFileSync(outFile, text);
else process.stdout.write(text);
