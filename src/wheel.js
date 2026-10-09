// Reading a wheel the desk downloaded (#8), without executing anything: a bounded zip reader (central directory,
// stored/deflate only, uncompressed sizes capped against zip bombs) and the wheel's RECORD, cross-checked file by file.
// The result is the exact inventory pip will install into site-packages — what the workspace venv is later verified
// against — plus the startup hooks (.pth, sitecustomize, usercustomize) a wheel would add.
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64url');

/** Central directory entries: [{ name, method, csize, size, offset }]. */
function entries(buf) {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw err('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw err('zip64 wheels are not supported');
  const out = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw err('corrupt zip central directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    if (flags & 1) throw err(`encrypted entry ${name}`);
    out.push({ name, method, csize, size, offset });
    p += 46 + nl + xl + cl;
  }
  return out;
}
function data(buf, e, maxSize) {
  const lh = e.offset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw err(`corrupt local header for ${e.name}`);
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (e.size > maxSize) throw err(`${e.name} unpacks to more than ${maxSize} bytes`);
  const out = e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }) : null;
  if (!out) throw err(`${e.name} uses an unsupported compression method (${e.method})`);
  if (out.length !== e.size) throw err(`${e.name} does not unpack to its declared size`);
  return out;
}
const SAFE_PATH = (p) => p && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((x) => x === '..' || x === '.' ) && !/[\0-\x1f]/.test(p);

/**
 * The install inventory of one wheel: { distInfo, files: [{ path, sha256, size }] (paths relative to site-packages),
 * outside: [paths installed elsewhere: scripts, headers, data], startup: [site-packages-level .pth / *customize.py] }.
 * Every archive member must be in RECORD with a matching sha256 and size (and vice versa).
 */
export function wheelInventory(file, { maxEntries = 50_000, maxUnpacked = 1_000_000_000, xy = '3' } = {}) {
  const buf = fs.readFileSync(file);
  const list = entries(buf);
  if (list.length > maxEntries) throw err(`more than ${maxEntries} files in the wheel`);
  const distInfos = [...new Set(list.map((e) => e.name.split('/')[0]).filter((d) => d.endsWith('.dist-info')))];
  if (distInfos.length !== 1) throw err(`expected exactly one .dist-info directory, found ${distInfos.length}`);
  const distInfo = distInfos[0];
  const recEntry = list.find((e) => e.name === `${distInfo}/RECORD`);
  if (!recEntry) throw err('the wheel has no RECORD');
  const record = new Map();
  for (const line of data(buf, recEntry, 64_000_000).toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^("?)(.*?)\1,(sha256=([A-Za-z0-9_-]+))?,(\d*)$/);
    if (!m) throw err(`unreadable RECORD line: ${line.slice(0, 120)}`);
    record.set(m[2], { hash: m[4] || null, size: m[5] === '' ? null : Number(m[5]) });
  }
  let total = 0;
  const files = [], outside = [], startup = [];
  const dataDir = `${distInfo.slice(0, -'.dist-info'.length)}.data/`;
  for (const e of list) {
    if (e.name.endsWith('/')) continue; // directory entry
    if (!SAFE_PATH(e.name)) throw err(`unsafe path in the wheel: ${e.name.slice(0, 120)}`);
    if ([`${distInfo}/RECORD`, `${distInfo}/RECORD.jws`, `${distInfo}/RECORD.p7s`].includes(e.name)) continue;
    total += e.size;
    if (total > maxUnpacked) throw err(`the wheel unpacks to more than ${maxUnpacked} bytes`);
    const body = data(buf, e, maxUnpacked);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const r = record.get(e.name);
    if (!r || r.hash !== b64(sha) || (r.size != null && r.size !== body.length)) throw err(`${e.name} does not match the wheel's RECORD`);
    record.delete(e.name);
    let dest = e.name;
    if (e.name.startsWith(dataDir)) {
      const [, scheme, ...rest] = e.name.slice(dataDir.length - 1).split('/');
      if (scheme === 'purelib' || scheme === 'platlib') dest = rest.join('/');
      else {
        // Where pip puts the other schemes, relative to the venv root (verified there after the install).
        const rel = rest.join('/');
        const distName = distInfo.slice(0, -'.dist-info'.length).replace(/-[^-]+$/, '');
        const where = scheme === 'scripts' ? `bin/${rel}` : scheme === 'headers' ? `include/site/python${xy}/${distName}/${rel}` : scheme === 'data' ? rel : null;
        if (!where || !rel || !SAFE_PATH(where)) throw err(`unsafe or unknown install location in the wheel: ${e.name.slice(0, 120)}`);
        const nl = body.indexOf(10);
        const shebang = scheme === 'scripts' && /^#!pythonw?\b/.test(body.subarray(0, Math.max(0, nl)).toString('latin1'));
        outside.push({ path: e.name, scheme, dest: where, sha256: sha, size: body.length, shebang,
          rest_sha256: shebang ? crypto.createHash('sha256').update(body.subarray(nl + 1)).digest('hex') : null });
        continue;
      }
    }
    files.push({ path: dest, sha256: sha, size: body.length });
    if (!dest.includes('/') && (dest.endsWith('.pth') || dest === 'sitecustomize.py' || dest === 'usercustomize.py')) startup.push(dest);
  }
  for (const [k] of record) if (![`${distInfo}/RECORD`, `${distInfo}/RECORD.jws`, `${distInfo}/RECORD.p7s`].includes(k)) throw err(`RECORD lists ${k}, which the wheel does not contain`);
  return { distInfo, files, outside, startup, unpacked: total };
}
