import crypto from 'node:crypto';
import path from 'node:path';

const COOKIE = 'anisync_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const hash = (value) => crypto.createHash('sha256').update(value).digest();

/** A shared password with signed, expiring cookies that survive server restarts. */
export function createAuth({ password, root }) {
  const key = hash(password);
  const attempts = new Map();
  const sign = (value) => crypto.createHmac('sha256', key).update(value).digest('base64url');

  function authenticated(req) {
    if (!password) return true;
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim())
      .find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!cookie) return false;
    const [expires, nonce, signature, extra] = cookie.split('.');
    if (extra || !/^\d+$/.test(expires) || !/^[a-f0-9]{32}$/.test(nonce || '') || !signature) return false;
    if (Number(expires) <= Date.now()) return false;
    return crypto.timingSafeEqual(hash(signature), hash(sign(`${expires}.${nonce}`)));
  }

  function sameOrigin(req) {
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  }

  function middleware(req, res, next) {
    if (!password) return next();
    // Even authenticated media must not be reused from a shared proxy cache.
    res.set('Cache-Control', 'private, no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
      return res.status(403).json({ error: 'Request must come from AniSync' });
    }
    if (req.path === '/api/login' && req.method === 'POST') {
      const now = Date.now();
      for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
      const ip = req.socket.remoteAddress;
      const entry = attempts.get(ip) || { count: 0, until: now + 60_000 };
      if (entry.count >= 10 || attempts.size >= 10_000 && !attempts.has(ip)) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
      }
      if (typeof req.body?.password !== 'string' || !crypto.timingSafeEqual(hash(req.body.password), key)) {
        entry.count++;
        attempts.set(ip, entry);
        return res.status(401).json({ error: 'Incorrect password' });
      }
      attempts.delete(ip);
      const value = `${now + SESSION_MS}.${crypto.randomBytes(16).toString('hex')}`;
      // TLS may terminate at Tailscale Serve or another reverse proxy.
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(COOKIE, `${value}.${sign(value)}`, {
        httpOnly: true, sameSite: 'strict', secure, maxAge: SESSION_MS, path: '/',
      });
      return res.json({ ok: true });
    }
    if (req.path === '/login' && ['GET', 'HEAD'].includes(req.method)) {
      if (authenticated(req)) return res.redirect('/');
      return res.sendFile(path.join(root, 'public', 'login.html'));
    }
    if (authenticated(req)) return next();
    // Docker can check liveness without a session; no room or media details leak.
    if (req.path === '/api/health' && req.method === 'GET') return res.json({ ok: true });
    if (req.path === '/' && ['GET', 'HEAD'].includes(req.method)) return res.redirect('/login');
    return res.status(401).json({ error: 'Password required' });
  }

  return { middleware, authenticated, sameOrigin };
}
