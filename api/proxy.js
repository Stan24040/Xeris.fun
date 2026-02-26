/**
 * xeris.fun — Vercel Edge Proxy
 * Routes HTTPS frontend requests to the HTTP Xeris node,
 * bypassing browser mixed-content restrictions.
 *
 * Endpoints:
 *   GET/POST /api/proxy?target=rpc          → node:50008/rpc  (JSON-RPC)
 *   GET      /api/proxy?target=api&path=... → node:50008/{path}
 *   GET/POST /api/proxy?target=net&path=... → node:56001/{path}
 */

const NODE = '138.197.116.81';
const PORTS = { rpc: 50008, api: 50008, net: 56001 };
const PATHS = { rpc: '/rpc', api: '', net: '' };

const ALLOWED_ORIGINS = [
  'https://xeris.fun',
  'https://www.xeris.fun',
];

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // ── Route ──
  const { target, path: extraPath = '' } = req.query;
  const port = PORTS[target];
  if (!port) {
    res.status(400).json({ error: 'Invalid target. Use rpc, api, or net.' });
    return;
  }

  // Sanitise extra path — allow only safe characters
  const safePath = extraPath.replace(/[^a-zA-Z0-9/_.\-]/g, '');
  const basePath = PATHS[target];
  const upstreamURL = `http://${NODE}:${port}${basePath}${safePath}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const upstreamRes = await fetch(upstreamURL, {
      method:  req.method,
      headers: { 'Content-Type': 'application/json' },
      body:    req.method !== 'GET' && req.method !== 'HEAD'
               ? JSON.stringify(req.body)
               : undefined,
      signal:  controller.signal,
    });

    clearTimeout(timeout);

    const data = await upstreamRes.text();

    res.setHeader('Content-Type', 'application/json');
    res.status(upstreamRes.status).send(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      res.status(504).json({ error: 'Upstream timeout' });
    } else {
      res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
    }
  }
}
