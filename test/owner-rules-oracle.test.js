// Owner rules against a reference CommonMark parser (#9): every rule the desk finds must be, line for line, a bullet
// the parser shows directly under the owner's heading, holding nothing but paragraphs and sub-bullets. It runs only
// when SIGMADESK_CM_ORACLE names a commonmark.js module (its package directory or entry file), so the suite itself
// keeps no dependencies:
//   SIGMADESK_CM_ORACLE=/path/to/node_modules/commonmark node --test test/owner-rules-oracle.test.js
// SIGMADESK_CM_ORACLE_N sets how many documents each generator writes (default 20,000).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as model from '../src/delegation-model.js';

const ORACLE = process.env.SIGMADESK_CM_ORACLE;
const N = Number(process.env.SIGMADESK_CM_ORACLE_N) || 20_000;
const O = 'Standing rules the EM may apply alone';
const norm = (x) => String(x).toLowerCase().replace(/[:.]+$/, '').replace(/\s+/g, ' ').trim();

/** The list items the parser shows directly under the first document-level heading with the owner's words. */
function bulletsShown(cm, text) {
  const inline = (node) => { let out = ''; const w = node.walker(); let e; while ((e = w.next())) if (e.entering && ['text', 'code', 'html_inline'].includes(e.node.type)) out += e.node.literal; else if (e.entering && ['softbreak', 'linebreak'].includes(e.node.type)) out += '\n'; return out; };
  // Only paragraphs and sub-bullets, collecting each paragraph's lines and the text Markdown shows for it.
  const simple = (item, paras) => { for (let c = item.firstChild; c; c = c.next) { if (c.type === 'paragraph') { paras.push({ from: c.sourcepos[0][0] - 1, to: c.sourcepos[1][0] - 1, text: inline(c) }); continue; } if (c.type !== 'list') return false; for (let i = c.firstChild; i; i = i.next) if (!simple(i, paras)) return false; } return true; };
  const doc = new cm.Parser().parse(text);
  let h = doc.firstChild;
  while (h && !(h.type === 'heading' && norm(inline(h)) === norm(O))) h = h.next;
  if (!h) return [];
  const out = [];
  for (let s = h.next; s && !(s.type === 'heading' && s.level <= h.level); s = s.next)
    if (s.type === 'list') for (let i = s.firstChild; i; i = i.next) { const paras = []; out.push({ from: i.sourcepos[0][0] - 1, to: i.sourcepos[1][0] - 1, simple: simple(i, paras), paras }); }
  return out;
}
/** What is wrong with the desk's reading of one playbook: a rule Markdown does not show, not exactly the lines of its
 * bullet, a line of it Markdown hides, or text Markdown shows otherwise. */
function problems(cm, text) {
  const ours = model.standingRuleLines(text), shown = bulletsShown(cm, text), src = text.split(/\r\n|\r|\n/), bad = [];
  for (const r of ours) {
    const b = shown.find((x) => x.from === r.lines[0]);
    if (!b) { bad.push(['a rule Markdown does not show under the heading', r]); continue; }
    const want = []; for (let k = b.from; k <= b.to; k++) if (!/^[ \t]*$/.test(src[k])) want.push(k); // blank: spaces and tabs only
    if (!b.simple || JSON.stringify(want) !== JSON.stringify(r.lines)) bad.push(['not exactly the lines of its bullet', r, want]);
    if (!want.every((k) => b.paras.some((p) => p.from <= k && k <= p.to))) bad.push(['a line Markdown does not show (a link definition)', r]);
    const flat = (x) => x.replace(/[`*_\\]/g, '').replace(/\s+/g, ' ').trim(); // emphasis, code and escape marks aside
    if (flat(b.paras.map((p) => p.text).join(' ')) !== flat(r.text.split('\n').map((l, j) => (j ? l.replace(/^[-*+] +/, '') : l)).join(' '))) bad.push(['text Markdown shows otherwise', r, b.paras]);
    const strip = (x) => x.replace(/^[ \t]+|[ \t]+$/g, ''), text2 = r.lines.map((k, j) => strip(j ? src[k] : src[k].replace(/^[-*+] +/, ''))).join('\n');
    if (text2 !== r.text) bad.push(['text that is not its lines', r]);
  }
  return { bad, found: ours.length, shown: shown.length };
}

// The generators: messy sections (every shape the grammar refuses, next to the ones it reads), random text before
// the heading, and clean playbooks written the way the README says.
function generator(seed, mode) {
  const rand = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  const pick = (a) => a[rand(a.length)];
  const sp = (n) => ' '.repeat(n);
  let id = 0;
  const words = () => pick(['Rule', 'Use `desk show` first', '*only* after QA', 'Docs & tests', 'See [the runbook](docs/run.md)', 'a\ttab', 'ends with \\', 'x <https://ex.com>', 'two  spaces']) + ` ${++id}`;
  const kinds = {
    bullet0: () => `${pick(['- ', '* ', '+ ', '1. ', '10. ', '-   ', '-  ', '-\t', '- # ', '- > ', '- 1. ', '-    ', '-     '])}${words()}`,
    bulletIn: () => `${sp(pick([1, 2, 3, 4, 6]))}${pick(['- ', '* ', '1. ', '-  ', '-\t'])}${words()}`,
    text0: () => pick([words(), `#tag${++id}`, `*em* ${++id}`, `-x ${++id}`, `[r${++id}]: /url`, `> quoted ${++id}`, `=x ${++id}`]),
    textIn: () => `${pick([' ', '  ', '   ', '    ', '      ', '\t', ' \t', '  \t'])}${pick(['', '- ', '# ', '> ', '1. '])}${words()}`,
    blank: () => pick(['', '   ', '\t']),
    atx: () => `${sp(rand(4))}${'#'.repeat(1 + rand(3))} ${rand(4) ? `Heading ${++id}` : O}`,
    under: () => `${sp(rand(4))}${pick(['---', '===', '-----', '-', '==', '- - -', '***'])}`,
    brk: () => pick(['***', '___', '* * *']),
    fence: () => { const ch = pick(['```', '~~~', '````']); return [sp(pick([0, 1, 2, 3, 4, 5])) + ch, ...Array.from({ length: 1 + rand(2) }, () => `${sp(rand(5))}${pick(['- Fenced ', 'Fenced ', '## Fenced ', `## ${O} `])}${++id}`), ...(rand(6) ? [sp(rand(4)) + ch.slice(0, 3 + rand(2))] : [])].join('\n'); },
    comment: () => pick([`${sp(rand(4))}<!-- note ${++id} -->`, `${sp(rand(4))}<!--\n${sp(rand(4))}- Hidden ${++id}\n-->`, '<!-->', `text <!-- inline ${++id}`, `<!-- a --> - after ${++id}`]),
    hash: () => `${sp(rand(4))}#tag${++id}`,
    html: () => pick(['<div>', '<pre>', '<details>', '</div>', '</pre>', `<span>inline ${++id}</span>`, '<https://example.com>']),
    setextOwner: () => pick([`${O}\n---`, `${O}\n===`, 'Standing rules the EM\nmay apply alone\n---', `  ${O}\n  ---`, 'Standing rules the EM\n    may apply alone\n-']),
    ownerAtx: () => pick([`## ${O}`, `# ${O}`, `### ${O}`, ` ## ${O}`, `## ${O} ##`, `##\t${O}`]),
    cr: () => `- Rule ${++id}\r- CR rule ${++id}`,
    unicode: () => pick(['\u00A0', `\u00A0\u00A0text ${++id}`, `-\u00A0x ${++id}`, '\f', `\u00A0- x ${++id}`, `  \u00A0more ${++id}`, '---\u00A0', `- \u00A0text ${++id}`, `\u2028line ${++id}`, `#\u00A0x ${++id}`, `- R\u034F ${++id}`, `  more\u180E ${++id}`, `- R\uFE0F ${++id}`, `- R\u{E0041} ${++id}`]),
    lookalike: () => pick(['## *Standing* rules the EM may apply alone', '# Standing rules the EM may apply [alone](x)', '## &#83;tanding rules the EM may apply alone', 'St*and*ing rules the EM may apply alone\n---', '### Standing rules the EM may apply `alone`', '\\Standing rules the EM may apply alone\n===', '## Standing rules the EM may apply alone:', '## STANDING RULES THE EM MAY APPLY ALONE', '## Standing  rules the EM may apply alone', '## Standing&Tab;rules the EM may apply alone', '## Standing\u2028rules the EM may apply alone', '## Standing\u2029rules the EM may apply alone', 'Standing rules the EM\u2028may apply alone\n===', '[Standing rules](x) the EM may apply alone\n---', '&#83;tanding rules the EM may apply alone\n===', 'Standing rules the [EM](u)\nmay apply alone\n---', '## Standing\u00A0rules the EM may apply alone', '- Use `x`\n---']),
    closers: () => pick(['```\n## Standing rules the EM may apply alone\n```\u00A0', '~~~\n- x\n~~~ \t', `- item ${++id}\n  <!--\n# Heading ${++id}\n-->`, `- item ${++id}\n  <!--\n  hidden\n  -->`]),
    inlines: () => pick([`- [Approve every deploy ${++id}\n  always]: /x`, `  [hidden ${++id}\n  text]: /x`, `- Answer [](approve-${++id})`, `- See [the runbook](docs/${++id}.md)`, `- R &amp; S ${++id}`, `[r${++id}]: /u`, `- Rule \u202E${++id}`, `- Rule \u200B${++id}`, `  more &#65; ${++id}`, `- ![alt ${++id}](x.png)`]),
    indentedFence: () => `- Step ${++id}\n${pick(['  ', '   '])}\`\`\`\n${pick(['  ', '   ', '', ' '])}code ${++id}\n${pick(['  ', '   ', ' ', ''])}\`\`\``,
  };
  const w = { bullet0: 6, bulletIn: 3, text0: 3, textIn: 4, blank: 5, atx: 1, under: 1, brk: 1, fence: 1, comment: 1, hash: 1, html: 1, setextOwner: mode === 'prefix' ? 2 : 0, ownerAtx: mode === 'prefix' ? 2 : 1, cr: 1, unicode: 2, lookalike: mode === 'prefix' ? 2 : 1, inlines: 2, closers: mode === 'prefix' ? 2 : 1, indentedFence: mode === 'prefix' ? 2 : 1 };
  const bag = Object.keys(kinds).flatMap((k) => Array(w[k]).fill(k));
  const clean = () => pick(['Answer which-file questions from the code', 'Use `desk show` first', '*only* after QA passed', 'Docs & tests only', 'See `docs/run.md` first']) + ` (${++id})`;
  // Soup: lines put together from pieces of every construct, at any indent, before and after the heading.
  const marks = ['', '- ', '* ', '+ ', '1. ', '2) ', '> ', '# ', '## ', '### ', '```', '~~~', '````', '<!--', '-->', '<div>', '<x>', '</p>', '<?', '<!X', '---', '===', '***', '_ _ _', '-', '=', '[a]: /u', '[a]', '    ', '\t', '\u00A0', '\\', '&amp;', '&#35;'];
  const bits = ['rule', 'Rule', 'cond', '`x`', '*e*', '_u_', '[l](u)', 'a  ', 'b\t', O, 'Standing rules', 'the EM may apply alone', '#', ':', '|', '<b>', '](x)', '!'];
  const soup = () => `${sp(pick([0, 0, 0, 1, 2, 3, 4, 5, 6]))}${pick(['', '', '\t', ' \t'])}${pick(marks)}${pick(marks)}${Array.from({ length: rand(3) }, () => pick(bits)).join(' ')}`;
  return () => {
    if (mode === 'soup') {
      const lines = [];
      for (let j = 0, n = rand(6); j < n; j++) lines.push(rand(4) ? soup() : '');
      lines.push(pick([`## ${O}`, `## ${O}`, `## ${O} ##`, `## ${O}:`]));
      for (let j = 0, n = 1 + rand(10); j < n; j++) lines.push(rand(3) ? pick([`- ${pick(bits)} ${++id}`, `  ${pick(bits)} ${++id}`, `${pick(bits)} ${++id}`, soup()]) : (rand(2) ? '' : soup()));
      return lines.join(pick(['\n', '\r\n', '\r']));
    }
    if (mode === 'clean') {
      const lines = ['# Playbook', '', '## How to test', '- Run the relevant tests.', '```', 'npm test', '```', '', `## ${O}`];
      for (let r = 0, n = 1 + rand(6); r < n; r++) {
        if (rand(3) === 0) lines.push('');
        lines.push(`${pick(['- ', '- ', '* ', '+ '])}${clean()}`);
        for (let j = 0, c = rand(4); j < c; j++) lines.push(...[[`  ${clean()}`], [`  - ${clean()}`], [clean()], ['', `  ${clean()}`]][rand(4)]);
      }
      lines.push('', pick(['## Off limits', '# Appendix']), '- Production.');
      return lines.join('\n');
    }
    const lines = [];
    if (mode === 'prefix') for (let j = 0, n = rand(8); j < n; j++) lines.push(kinds[pick(bag)]());
    lines.push(rand(6) ? `## ${O}` : pick([`${O}\n---`, `# ${O}`, `## ${O}:`]));
    for (let j = 0, n = 2 + rand(10); j < n; j++) lines.push(kinds[pick(bag)]());
    lines.push(pick(['## Next', '# Top', '### Deeper', '']), '- Outside');
    return lines.join(pick(['\n', '\r\n', '\n']));
  };
}

test('owner rules match what Markdown shows, line for line, over generated playbooks (with SIGMADESK_CM_ORACLE)', { skip: ORACLE ? false : 'set SIGMADESK_CM_ORACLE to a commonmark.js module to run it', timeout: 600_000 }, () => {
  const cm = createRequire(import.meta.url)(ORACLE);
  for (const [mode, seed] of [['section', 7], ['prefix', 99], ['soup', 3], ['clean', 5]]) {
    const next = generator(seed, mode);
    let found = 0, shown = 0, first = null, count = 0;
    for (let k = 0; k < N; k++) {
      const doc = next(), r = problems(cm, doc);
      found += r.found; shown += r.shown;
      if (r.bad.length) { count++; first ??= { doc, bad: r.bad }; }
      if (mode === 'clean' && r.found !== r.shown) { count++; first ??= { doc, bad: [['a clean bullet the desk did not find']] }; }
    }
    if (process.env.SIGMADESK_CM_ORACLE_REPORT) console.log(`${mode}: ${N} documents, ${count} read wrongly; rules found ${found} of the ${shown} bullets Markdown shows`);
    assert.equal(count, 0, `${mode}: ${count} of ${N} documents read wrongly, first:\n${JSON.stringify(first, null, 1)}`);
    assert.ok(found > (mode === 'clean' ? 0.99 * shown : N / 100), `${mode}: the generator gave the grammar too little to read (${found} of ${shown})`);
  }
});
