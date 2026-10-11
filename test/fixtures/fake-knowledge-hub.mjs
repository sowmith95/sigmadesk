#!/usr/bin/env node
// A stand-in for the KnowledgeHub `knowledge-hub` CLI (#10) so tests never touch the real store. It speaks the same
// machine-readable contract (search --json, ingest-text --json with exit 0/2/3, doc-status --json). Its "store" and its
// behaviour live in the JSON file named by KB_SQLITE_PATH (the desk passes that variable explicitly), and every call is
// appended to <that file>.log: argv, the environment it received, stdin, start and end times.
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = process.env.KB_SQLITE_PATH;
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const save = (s) => fs.writeFileSync(file, JSON.stringify(s));
const argv = process.argv.slice(2);
const st = load();
const start = Date.now();
let stdin = '';
const log = (extra = {}) => fs.appendFileSync(`${file}.log`, `${JSON.stringify({ argv, env: process.env, stdin, start, end: Date.now(), ...extra })}\n`);
process.on('SIGTERM', () => { log({ killed: 'SIGTERM' }); process.exit(143); });
const target = st.targets?.[argv[0]] ?? st.target ?? { collection: 'knowledge_hub', embedding_model: 'nomic-embed-text', embedding_dim: 768, chunk_size: 256, chunk_overlap: 32, fingerprint: 'fp-test-0001' };
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const all = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const docId = (url) => `doc-${sha(url).slice(0, 12)}`;

async function main() {
  const cmd = argv[0];
  const mode = st.mode?.[cmd] ?? st.mode?.all ?? 'ok';
  const wait = st.sleep?.[cmd] ?? st.sleepMs;
  if (wait) await sleep(wait);
  if (mode === 'crash') { process.stderr.write('Traceback: qdrant_client ConnectionRefusedError: [Errno 61] Connection refused api_key=sk-ant-FAKESECRETVALUE000111222\n'); log(); process.exit(1); }
  if (cmd === 'search') {
    if (mode === 'utf8') { process.stderr.write('€'.repeat(100)); process.stdout.write('€'.repeat(2000)); log(); return; }
    if (mode === 'badjson') { process.stdout.write('Results:\n1. something\n'); log(); return; }
    if (mode === 'huge') { process.stdout.write('{"contract":1,"results":['); for (let i = 0; i < 2000; i++) process.stdout.write(`${JSON.stringify({ doc_id: `d${i}`, excerpt: 'x'.repeat(1000) })},`); log(); return; }
    const ns = all('--namespace');
    const sep = argv.indexOf('--');
    const query = sep >= 0 ? argv.slice(sep + 1).join(' ') : argv.slice(1).filter((a) => !a.startsWith('--')).join(' ');
    const n = Number(opt('--excerpt-chars') || 1200);
    // A healthy store filters by namespace BEFORE ranking; ignoreFilter simulates one that does not (defence in depth).
    const pool = (st.results || []).filter((r) => st.ignoreFilter || (ns.length && ns.includes(r.namespace)));
    const results = pool.slice(0, Number(opt('--top-k') || 10)).map((r) => ({ chunk_index: 0, source_type: 'markdown', similarity: 0.8, authored_at: null, chunk_count: 1, ...r,
      excerpt: String(r.text ?? r.excerpt ?? '').slice(0, n), truncated: String(r.text ?? r.excerpt ?? '').length > n, text: undefined }));
    process.stdout.write(`${JSON.stringify({ contract: mode === 'contract2' ? 2 : 1, query, namespace: ns, target, results })}\n`);
    log();
    return;
  }
  if (cmd === 'doc-status') {
    const url = opt('--url');
    const d = (st.docs || {})[url];
    process.stdout.write(`${JSON.stringify(d ? { url, doc_id: docId(url), exists: true, title: d.title, source_type: 'markdown', namespace: d.namespace, content_hash: d.content_hash, chunk_count: d.chunk_count, chunks_in_store: d.chunk_count, ingested_at: d.at, consistent: true, target } : { url, doc_id: docId(url), exists: false, target })}\n`);
    log();
    return;
  }
  if (cmd === 'ingest-text') {
    stdin = fs.readFileSync(0, 'utf8');
    const url = opt('--url'), hash = sha(stdin);
    const docs = st.docs || {};
    const have = docs[url];
    if (mode === 'refuse' || (have && have.content_hash !== hash && !argv.includes('--replace'))) { process.stderr.write(`knowledge-hub: ${url} already holds different content\n`); log(); process.exit(2); }
    const present = !!(have && have.content_hash === hash);
    if (!present) { docs[url] = { title: opt('--title'), namespace: opt('--namespace'), content_hash: hash, chunk_count: 2, at: new Date().toISOString(), writes: (have?.writes || 0) + 1 }; st.docs = docs; st.embeds = (st.embeds || 0) + 1; save(st); }
    if (mode === 'writeThenCrash' && !present) { process.stderr.write('Killed: the process died after writing\n'); log(); process.exit(137); }
    const verified = mode !== 'mismatch';
    process.stdout.write(`${JSON.stringify({ doc_id: docId(url), url, verified, reason: verified ? null : 'chunk text mismatch', chunk_count: 2, chunks_in_store: verified ? 2 : 1, title: opt('--title'), source_type: opt('--type'), namespace: opt('--namespace'), content_hash: hash, already_present: present, is_update: false, target })}\n`);
    log();
    process.exit(verified ? 0 : 3);
  }
  process.stderr.write(`knowledge-hub: unknown command ${cmd}\n`);
  log();
  process.exit(2);
}
await main();
