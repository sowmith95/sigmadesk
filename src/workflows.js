// Which GitHub Actions workflows would a merge into the base branch trigger? (sowmith95/sigmadesk#3)
// A tiny, dependency-free reader for the `on:` block of a workflow file plus GitHub's filter-pattern semantics.
// Anything it cannot read with confidence is reported as unparseable, and callers treat that as "deploys".

/**
 * GitHub filter pattern → RegExp. `*` = anything but `/`, `**` = anything, `?` / `+` = zero-or-one / one-or-more of the
 * preceding character, `[...]` = character class, `\` escapes. A leading `**​/` also matches at the repo root.
 */
export function filterToRegExp(pattern) {
  let re = '';
  const p = String(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) { re += p[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue; }
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      continue;
    }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?' || c === '+') { re += re ? c : `\\${c}`; continue; } // quantifier on the preceding character
    if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end > i) { re += `[${p.slice(i + 1, end).replace(/\\/g, '\\\\')}]`; i = end; continue; }
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's'); // dotAll: a path may contain a newline
}

/** Ordered evaluation: a later `!pattern` excludes what earlier patterns included, and a later pattern can re-include. */
export function matchesFilters(value, patterns) {
  let hit = false;
  for (const raw of patterns || []) {
    const neg = String(raw).startsWith('!');
    if (filterToRegExp(neg ? String(raw).slice(1) : raw).test(value)) hit = !neg;
  }
  return hit;
}

// ---------------- minimal YAML (only what an `on:` block needs) ----------------
const stripComment = (line) => {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};
class Unparseable extends Error {}
const unquote = (s) => { const t = s.trim(); return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t; };
function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Unparseable('multi-line flow list');
    const items = []; let cur = ''; let q = null;
    for (const c of s.slice(1, -1)) {
      if (q) { cur += c; if (c === q) q = null; } else if (c === '"' || c === "'") { q = c; cur += c; } else if (c === ',') { items.push(cur); cur = ''; } else cur += c;
    }
    if (cur.trim()) items.push(cur);
    return items.map(unquote).filter((x) => x !== '');
  }
  if (s.startsWith('{') || s.startsWith('|') || s.startsWith('>') || s.startsWith('&') || s.startsWith('*')) throw new Unparseable(`unsupported YAML: ${s.slice(0, 20)}`);
  return unquote(s);
}
function parseBlock(lines, start, indent) {
  // returns [value, nextIndex]; value is an object (mapping) or array (list)
  let i = start; let out = null;
  while (i < lines.length) {
    const { ind, text } = lines[i];
    if (ind < indent) break;
    if (ind > indent) throw new Unparseable('unexpected indentation');
    if (text.startsWith('- ') || text === '-') {
      if (out && !Array.isArray(out)) throw new Unparseable('mixed list and mapping');
      out ||= [];
      const v = text.slice(1).trim();
      if (/^[^'"[{][^:]*:\s/.test(v) || /^[^'"[{][^:]*:$/.test(v)) {
        // "- key: value" starts a mapping item: re-read this line at the item's indent, plus its continuation lines.
        const itemIndent = ind + (text.length - text.slice(1).trimStart().length);
        lines[i] = { ind: itemIndent, text: v };
        const [item, n] = parseBlock(lines, i, itemIndent);
        out.push(item); i = n; continue;
      }
      out.push(scalar(v)); i += 1; continue;
    }
    const m = text.match(/^(['"]?)([^'":]+)\1\s*:(.*)$/);
    if (!m) throw new Unparseable(`cannot read: ${text.slice(0, 40)}`);
    if (Array.isArray(out)) throw new Unparseable('mixed list and mapping');
    out ||= {};
    const key = m[2].trim();
    if (m[3].trim()) { out[key] = scalar(m[3]); i += 1; continue; }
    if (i + 1 < lines.length && lines[i + 1].ind > ind) { const [v, n] = parseBlock(lines, i + 1, lines[i + 1].ind); out[key] = v; i = n; }
    else if (i + 1 < lines.length && lines[i + 1].ind === ind && lines[i + 1].text.startsWith('-') && !/^(on|true)$/.test(key)) {
      const [v, n] = parseBlock(lines, i + 1, ind); out[key] = v; i = n; // "key:\n- a" (list at the same indent)
    } else { out[key] = null; i += 1; }
  }
  return [out, i];
}

/** { name, on } where on = { push?: null | {branches, ...}, ... }, or null when the file cannot be read confidently. */
export function parseWorkflow(text) {
  try {
    const lines = String(text).replace(/\r/g, '').split('\n').map((l) => stripComment(l).replace(/\s+$/, ''))
      .filter((l) => l.trim() && l.trim() !== '---').map((l) => ({ ind: l.length - l.trimStart().length, text: l.trim() }));
    let name = null; let on;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].ind !== 0) continue;
      const m = lines[i].text.match(/^(['"]?)(name|on|true)\1\s*:(.*)$/);
      if (!m) continue;
      if (m[2] === 'name') { name = unquote(m[3]); continue; }
      const rest = m[3].trim();
      if (rest) {
        const v = scalar(rest);
        on = Object.fromEntries((Array.isArray(v) ? v : [v]).map((e) => [e, null]));
      } else {
        const next = lines[i + 1];
        if (!next || next.ind === 0) throw new Unparseable('empty on:');
        on = parseBlock(lines, i + 1, next.ind)[0];
        if (Array.isArray(on)) on = Object.fromEntries(on.map((e) => [e, null]));
      }
    }
    if (on === undefined) return null;
    return { name, on };
  } catch (err) {
    if (err instanceof Unparseable) return null;
    throw err;
  }
}

const list = (v) => (v == null ? null : Array.isArray(v) ? v.map(String) : [String(v)]);

/** Would a push of `files` to `branch` trigger this parsed workflow's push event? */
export function pushTriggers(wf, branch, files) {
  if (!wf?.on || !Object.prototype.hasOwnProperty.call(wf.on, 'push')) return false;
  const push = wf.on.push;
  if (push == null) return true; // `on: push` or `push:` with no filters
  if (typeof push !== 'object' || Array.isArray(push)) return true;
  const branches = list(push.branches); const branchesIgnore = list(push['branches-ignore']);
  const paths = list(push.paths); const pathsIgnore = list(push['paths-ignore']);
  const tagsOnly = (push.tags || push['tags-ignore']) && !branches && !branchesIgnore;
  if (tagsOnly) return false;
  if (branches && !matchesFilters(branch, branches)) return false;
  if (branchesIgnore && matchesFilters(branch, branchesIgnore)) return false;
  if (paths && !files.some((f) => matchesFilters(f, paths))) return false;
  if (pathsIgnore && files.length && files.every((f) => matchesFilters(f, pathsIgnore))) return false;
  return true;
}

/**
 * Does merging `files` into `branch` run a deploying workflow?
 * workflows: [{ file, text }]; registered: 'auto' (every workflow with a matching push trigger deploys) or a list of
 * workflow file names that deploy. A registered workflow that is missing or unreadable counts as deploying.
 */
export function deploysFor({ files, branch, workflows, registered = 'auto' }) {
  const hits = [];
  const byFile = new Map(workflows.map((w) => [w.file.split('/').pop(), w]));
  const chosen = Array.isArray(registered) && registered.length
    ? registered.map((f) => byFile.get(String(f).split('/').pop()) || { file: String(f), text: null, missing: true })
    : workflows;
  for (const w of chosen) {
    const parsed = w.text == null ? null : parseWorkflow(w.text);
    const label = parsed?.name || w.file.split('/').pop();
    if (!parsed) { hits.push({ file: w.file, name: label, reason: w.missing ? 'registered deploy workflow not found — assuming it deploys' : 'could not read its triggers — assuming it deploys' }); continue; }
    if (pushTriggers(parsed, branch, files)) hits.push({ file: w.file, name: label, reason: `runs on push to ${branch}` });
  }
  return { deploys: hits.length > 0, workflows: hits };
}
