// Procedural "human bot" portraits: an illustrated person with a small robotic tell (antenna tip and eye glints
// in the colour of the model that powers the seat). Deterministic per seat id, built with DOM APIs (no innerHTML).

const NS = 'http://www.w3.org/2000/svg';
const MODEL_GLOW = { fable: '#c084fc', opus: '#fb923c', sonnet: '#60a5fa', haiku: '#4ade80' };
const SKIN = ['#f1c7a5', '#e0ac85', '#c98e66', '#a86f4c', '#7d4f33', '#f5d0b9'];
const HAIR = ['#1f1a17', '#3b2a20', '#6b4a2f', '#a0703f', '#d9b26f', '#8c8f99', '#b8452e'];

// Per-seat look: hair style, accessory. Unknown seats get a seeded look.
const LOOKS = {
  pm: { hair: 'bob', acc: 'round-glasses', hairColor: 4 },
  manager: { hair: 'side', acc: 'collar', hairColor: 1 },
  'principal-be': { hair: 'crop', acc: 'square-glasses', hairColor: 5 },
  'senior-be': { hair: 'curly', acc: 'none', hairColor: 0 },
  'principal-fe': { hair: 'bun', acc: 'round-glasses', hairColor: 6 },
  'senior-fe': { hair: 'long', acc: 'none', hairColor: 2 },
  dba: { hair: 'buzz', acc: 'beanie', hairColor: 1 },
  junior: { hair: 'swoop', acc: 'cap', hairColor: 3 },
  qa: { hair: 'side', acc: 'monocle', hairColor: 0 },
  sre: { hair: 'curly', acc: 'headphones', hairColor: 2 },
  support: { hair: 'none', acc: 'headset', hairColor: 5 },
};

function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
  return Math.abs(x);
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid) n.append(kid);
  return n;
}

function hairShape(style, color) {
  switch (style) {
    case 'bob': return el('path', { d: 'M17 33c-2-14 6-22 15-22s17 8 15 22c-1 5-2 8-4 9l-1-14c-6 1-14-1-19-6-1 4-3 8-4 20-2-1-2-4-2-9z', fill: color });
    case 'side': return el('path', { d: 'M18 29c0-11 7-17 15-17 9 0 14 6 14 14-7-1-14-4-18-9-2 4-6 8-11 12z', fill: color });
    case 'crop': return el('path', { d: 'M19 27c0-9 6-14 13-14s13 5 13 14c-4-4-9-6-13-6s-9 2-13 6z', fill: color });
    case 'curly': return el('g', { fill: color }, [[20, 22], [25, 16], [32, 14], [39, 16], [44, 22], [46, 28], [18, 28]].map(([cx, cy]) => el('circle', { cx, cy, r: 6 })));
    case 'bun': return el('g', { fill: color }, el('circle', { cx: 32, cy: 10, r: 6 }), el('path', { d: 'M18 30c-1-11 6-17 14-17s15 6 14 17c-4-5-9-8-14-8s-10 3-14 8z' }));
    case 'long': return el('path', { d: 'M16 44c-3-20 3-31 16-31s19 11 16 31l-4-2c1-8 0-14-2-18-6 0-13-3-16-7-2 5-5 9-6 25z', fill: color });
    case 'buzz': return el('path', { d: 'M19 27c1-8 6-13 13-13s12 5 13 13c-4-3-8-4-13-4s-9 1-13 4z', fill: color, opacity: '.75' });
    case 'swoop': return el('path', { d: 'M18 28c0-10 6-16 15-16 7 0 13 4 14 11-8-3-17 0-24 7-2-1-4-1-5-2z', fill: color });
    default: return null;
  }
}

function accessory(kind, glow) {
  const stroke = '#0b0d12';
  switch (kind) {
    case 'round-glasses': return el('g', { fill: 'none', stroke, 'stroke-width': 1.6 }, el('circle', { cx: 26, cy: 33, r: 4.6 }), el('circle', { cx: 38, cy: 33, r: 4.6 }), el('path', { d: 'M30.6 33h2.8' }));
    case 'square-glasses': return el('g', { fill: 'none', stroke, 'stroke-width': 1.6 }, el('rect', { x: 21, y: 29.5, width: 9, height: 7, rx: 1.5 }), el('rect', { x: 34, y: 29.5, width: 9, height: 7, rx: 1.5 }), el('path', { d: 'M30 33h4' }));
    case 'monocle': return el('g', { fill: 'none', stroke: '#e5c07b', 'stroke-width': 1.6 }, el('circle', { cx: 38, cy: 33, r: 5 }), el('path', { d: 'M42 37l3 9' }));
    case 'cap': return el('g', {}, el('path', { d: 'M18 25c1-8 7-13 14-13s13 5 14 13z', fill: '#2563eb' }), el('path', { d: 'M40 24c5 0 9 1 11 3l-11 1z', fill: '#1d4ed8' }));
    case 'beanie': return el('g', {}, el('path', { d: 'M18 27c0-10 6-16 14-16s14 6 14 16z', fill: '#0f766e' }), el('rect', { x: 17, y: 24, width: 30, height: 5, rx: 2.5, fill: '#14b8a6' }));
    case 'headphones': return el('g', {}, el('path', { d: 'M17 33c0-11 7-18 15-18s15 7 15 18', fill: 'none', stroke: '#ef4444', 'stroke-width': 3 }),
      el('rect', { x: 14, y: 29, width: 6, height: 11, rx: 3, fill: '#b91c1c' }), el('rect', { x: 44, y: 29, width: 6, height: 11, rx: 3, fill: '#b91c1c' }),
      el('circle', { cx: 47, cy: 34.5, r: 1.3, fill: glow }));
    case 'collar': return el('path', { d: 'M26 52l6 6 6-6-2-3h-8z', fill: '#e5e7eb' });
    case 'headset': return el('g', {}, el('path', { d: 'M18 34c0-10 6-17 14-17s14 7 14 17', fill: 'none', stroke: '#1f2937', 'stroke-width': 3 }),
      el('rect', { x: 15, y: 31, width: 5, height: 9, rx: 2.5, fill: '#1f2937' }), el('rect', { x: 44, y: 31, width: 5, height: 9, rx: 2.5, fill: '#1f2937' }),
      el('path', { d: 'M46 40c0 5-4 8-9 8', fill: 'none', stroke: '#1f2937', 'stroke-width': 2 }), el('circle', { cx: 36, cy: 48, r: 2, fill: glow }),
      el('rect', { x: 21, y: 29, width: 22, height: 7, rx: 3.5, fill: '#0b1220', opacity: '.85' }), el('rect', { x: 23, y: 31.5, width: 18, height: 2, rx: 1, fill: glow, opacity: '.9' }));
    default: return null;
  }
}

/** Build an avatar <svg>. presence: 'working' | 'meeting' | 'reviewing' | 'idle' | 'off' */
export function portrait(agent, { size = 40, presence = 'idle', title } = {}) {
  const look = LOOKS[agent.id] || { hair: ['crop', 'side', 'bob', 'curly'][hash(agent.id) % 4], acc: 'none', hairColor: hash(agent.id) % HAIR.length };
  const skin = SKIN[hash(`${agent.id}:skin`) % SKIN.length];
  const hairColor = HAIR[look.hairColor ?? 0];
  const glow = MODEL_GLOW[agent.model] || '#a3e635';
  const shirt = agent.color || '#64748b';
  const isBot = agent.id === 'support';
  const ring = { working: '#a3e635', meeting: '#38bdf8', reviewing: '#f59e0b', idle: '#334155', off: '#1f2937' }[presence] || '#334155';
  const uid = `p${hash(agent.id + size)}`;

  const svg = el('svg', { viewBox: '0 0 64 64', width: size, height: size, role: 'img', 'aria-label': title || `${agent.name}, ${agent.role}`, class: `portrait ${presence}` },
    el('title', {}, title || `${agent.name} · ${agent.role}`),
    el('defs', {}, el('clipPath', { id: uid }, el('circle', { cx: 32, cy: 32, r: 29 })),
      el('radialGradient', { id: `${uid}g`, cx: '50%', cy: '35%', r: '70%' }, el('stop', { offset: '0', 'stop-color': shirt, 'stop-opacity': '.35' }), el('stop', { offset: '1', 'stop-color': '#0b0f16' }))),
    el('circle', { cx: 32, cy: 32, r: 31, fill: `url(#${uid}g)`, stroke: ring, 'stroke-width': 2.5, class: 'ring' }),
    el('g', { 'clip-path': `url(#${uid})` },
      // antenna (the bot tell)
      el('path', { d: 'M32 13V6', stroke: '#94a3b8', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
      el('circle', { cx: 32, cy: 5.5, r: 2.6, fill: glow, class: 'antenna' }),
      // shoulders + neck
      el('path', { d: 'M10 64c1-10 9-15 22-15s21 5 22 15z', fill: shirt }),
      el('rect', { x: 28, y: 42, width: 8, height: 9, rx: 3, fill: skin }),
      // head
      el('ellipse', { cx: 32, cy: 32, rx: 13.5, ry: 15, fill: skin }),
      isBot ? el('path', { d: 'M18.6 30h-2.2M47.6 30h-2.2', stroke: '#94a3b8', 'stroke-width': 2 }) : el('g', {}, el('ellipse', { cx: 18.6, cy: 33, rx: 2, ry: 3, fill: skin }), el('ellipse', { cx: 45.4, cy: 33, rx: 2, ry: 3, fill: skin })),
      hairShape(look.hair, hairColor),
      // eyes with a model-coloured glint
      el('circle', { cx: 26, cy: 33, r: 1.9, fill: '#111827' }), el('circle', { cx: 38, cy: 33, r: 1.9, fill: '#111827' }),
      el('circle', { cx: 26.7, cy: 32.3, r: 0.7, fill: glow }), el('circle', { cx: 38.7, cy: 32.3, r: 0.7, fill: glow }),
      el('path', { d: 'M23 28.5c1.5-1 4-1 5 0M36 28.5c1.5-1 4-1 5 0', stroke: hairColor, 'stroke-width': 1.3, fill: 'none', 'stroke-linecap': 'round' }),
      // smile + cheeks
      el('path', { d: 'M27.5 39.5c2.6 2.6 6.4 2.6 9 0', stroke: '#7c2d12', 'stroke-width': 1.5, fill: 'none', 'stroke-linecap': 'round' }),
      el('circle', { cx: 23, cy: 38, r: 2, fill: '#f472b6', opacity: '.18' }), el('circle', { cx: 41, cy: 38, r: 2, fill: '#f472b6', opacity: '.18' }),
      accessory(look.acc, glow),
    ),
  );
  return svg;
}

export const PRESENCE_TEXT = {
  implement: 'Heads-down', qa: 'Testing', review: 'Reviewing', groom: 'Planning', research: 'Researching', triage: 'Triaging', consult: 'In a meeting',
};

export function presenceOf(agent) {
  if (agent.enabled === false) return { key: 'off', text: 'Off desk' };
  if (agent.meeting) return { key: 'meeting', text: 'In a meeting' };
  if (agent.status === 'working') {
    const k = agent.current_kind;
    return { key: k === 'qa' || k === 'review' ? 'reviewing' : 'working', text: PRESENCE_TEXT[k] || 'Working' };
  }
  return { key: 'idle', text: 'Available' };
}
