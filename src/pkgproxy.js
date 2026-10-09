// The resolver's only way out (#8): a desk-owned HTTP CONNECT proxy that lives for one resolution. pip is started with
// `--proxy http://sigmadesk:<token>@127.0.0.1:<port>` and no other proxy settings, so every connection it makes — the index,
// metadata, wheels — must come through here, and here only:
//  - the per-resolution token must be presented (Proxy-Authorization), or 407;
//  - only CONNECT, only to an exact allowlisted hostname on port 443 (pypi.org, files.pythonhosted.org), never an IP;
//  - the name is resolved here and refused if any answer is private or reserved; the tunnel connects to the checked
//    address (TLS stays end to end between pip and PyPI: pip verifies the certificate);
//  - a byte cap over all tunnels and a lifetime cap; abort (revoke) or close tears everything down.
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { isPrivateAddress } from './netfetch.js';

export const RESOLVER_HOSTS = ['pypi.org', 'files.pythonhosted.org'];

let connector = (host, port, cb) => net.connect({ host, port }, cb); // tests replace it (no network in the suite)
let lookup = dns.lookup;
export function _setConnector(fn) { connector = fn || ((host, port, cb) => net.connect({ host, port }, cb)); }
export function _setLookup(fn) { lookup = fn || dns.lookup; }

/**
 * Start a proxy. Resolves { url (with the token), port, token, close(), stats: { bytes, refused: [] } }.
 * Options: hosts, maxBytes (all tunnels together), maxMs (lifetime), signal (closes it).
 */
export function startProxy({ hosts = RESOLVER_HOSTS, maxBytes = 500e6, maxMs = 300_000, signal = null } = {}) {
  const token = crypto.randomBytes(18).toString('hex');
  const stats = { bytes: 0, refused: [], tunnels: 0 };
  const sockets = new Set();
  const server = http.createServer((req, res) => { stats.refused.push(`${req.method} ${String(req.url).slice(0, 120)}: not CONNECT`); res.writeHead(405); res.end(); });
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };
  server.on('connection', track);
  const authOk = (h) => {
    const v = String(h || '');
    const m = v.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (!m) return false;
    // pip sends proxy credentials only with a password: the URL is http://sigmadesk:<token>@127.0.0.1:<port>.
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const a = Buffer.from(dec), b = Buffer.from(`sigmadesk:${token}`);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  server.on('connect', (req, client, head) => {
    track(client);
    const refuse = (code, why) => { stats.refused.push(`${req.url}: ${why}`); client.end(`HTTP/1.1 ${code} ${why}\r\nContent-Length: 0\r\n\r\n`); };
    if (!authOk(req.headers['proxy-authorization'])) return refuse(407, 'Proxy Authentication Required');
    const m = String(req.url).match(/^([a-z0-9.-]+):(\d+)$/i);
    const host = m?.[1].toLowerCase().replace(/\.$/, '');
    if (!m || net.isIP(host)) return refuse(403, 'Forbidden (hostnames only)');
    if (m[2] !== '443' || !hosts.includes(host)) return refuse(403, `Forbidden (${host}:${m[2]} is not allowed)`);
    lookup(host, { all: true, verbatim: true }, (e, list) => {
      if (client.destroyed) return;
      const addrs = (Array.isArray(list) ? list : []).filter(Boolean);
      if (e || !addrs.length) return refuse(502, 'Bad Gateway (cannot resolve)');
      if (addrs.some((a) => isPrivateAddress(a.address))) return refuse(403, 'Forbidden (private address)');
      const upstream = connector(addrs[0].address, 443, () => {
        stats.tunnels++;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        const count = (dir) => (chunk) => {
          stats.bytes += chunk.length;
          if (stats.bytes > maxBytes) { stats.refused.push(`byte cap (${maxBytes}) reached`); client.destroy(); upstream.destroy(); return; }
          (dir === 'up' ? upstream : client).write(chunk);
        };
        client.on('data', count('up'));
        upstream.on('data', count('down'));
        client.on('end', () => upstream.end());
        upstream.on('end', () => client.end());
      });
      track(upstream);
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', close);
    server.close();
    for (const s of sockets) s.destroy();
  };
  const timer = setTimeout(() => { stats.refused.push(`lifetime cap (${maxMs} ms) reached`); close(); }, maxMs);
  timer.unref?.();
  signal?.addEventListener?.('abort', close, { once: true });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://sigmadesk:${token}@127.0.0.1:${port}`, port, token, close, stats });
    });
  });
}
