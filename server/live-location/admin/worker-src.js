// Admin Worker for the Morzine ski map: the admin page and its data.
//
// Source file. Deploy the built file server/live-location/admin-worker.js, made by
// tools/build_admin_worker.py, which puts admin/page.html in place of __PAGE__.
//
// Login: OPTIONAL for now (owner's choice, 26 Nov 2026). With the variables TEAM_DOMAIN (for example
// "myteam.cloudflareaccess.com") and POLICY_AUD (the Access application's AUD tag) set, every request
// must carry a valid Cloudflare Access login. Without them the admin is OPEN to anyone who has the
// address, and the page shows a red warning bar. Set both before real visitors share their position.
// Needs: D1 binding DB (database morzine-live).
//
// Routes:  GET /                 the admin page
//          GET /api/state        sharing switch, people sharing now, people in the emergency record, places
//          GET /api/track?id=    the emergency record of one phone
//          POST /api/settings    { sharingOff }
//          POST /api/places      { id?, name, description, emoji, color, lat, lon }  (add or change)
//          POST /api/places/delete  { id }
//          POST /api/clear       { confirm: "DELETE ALL" }  deletes every position and the whole record

const PAGE = __PAGE__;
const KEEP_MS = 2 * 24 * 3600 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const loginOn = !!(env.TEAM_DOMAIN && env.POLICY_AUD);
    const user = loginOn ? await verifyAccess(request, env) : { email: '' };
    if (!user) {
      return new Response('Not allowed. Log in through Cloudflare Access, or the admin is not set up yet.',
        { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(PAGE, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer'
      } });
    }
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
    if (request.method === 'POST') {
      // Only the admin page itself may change things (blocks requests sent from other sites).
      if (request.headers.get('X-Admin') !== '1' || (request.headers.get('Origin') || url.origin) !== url.origin) {
        return json({ error: 'refused' }, 403);
      }
    }
    const db = env.DB;
    const now = Date.now();
    try {
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const off = await db.prepare("SELECT v FROM meta WHERE k = 'sharing_off'").first();
        const live = (await db.prepare('SELECT id, name, lat, lon, acc, t FROM pos ORDER BY t DESC').all()).results;
        const people = (await db.prepare(
          `SELECT id, MAX(name) AS name, MIN(t) AS first, MAX(t) AS last, COUNT(*) AS n
             FROM track WHERE t >= ? GROUP BY id ORDER BY last DESC`).bind(now - KEEP_MS).all()).results;
        const places = (await db.prepare('SELECT * FROM places ORDER BY name').all()).results;
        return json({ sharingOff: !!(off && off.v === 1), now, live, people, places, user: user.email || '', loginOn });
      }
      if (url.pathname === '/api/track' && request.method === 'GET') {
        const id = url.searchParams.get('id') || '';
        const { results } = await db.prepare(
          'SELECT name, lat, lon, acc, t FROM track WHERE id = ? ORDER BY t').bind(id).all();
        return json({ points: results });
      }
      if (request.method !== 'POST') return json({ error: 'not found' }, 404);
      const body = await request.json();
      if (url.pathname === '/api/settings') {
        await db.prepare("INSERT INTO meta (k, v) VALUES ('sharing_off', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
          .bind(body.sharingOff ? 1 : 0).run();
        return json({ ok: true });
      }
      if (url.pathname === '/api/places') {
        const p = cleanPlace(body);
        if (!p) return json({ error: 'Name, position and colour are needed.' }, 400);
        await db.prepare(
          `INSERT INTO places (id, name, description, emoji, color, lat, lon, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
             emoji = excluded.emoji, color = excluded.color, lat = excluded.lat, lon = excluded.lon,
             updated = excluded.updated`
        ).bind(p.id, p.name, p.description, p.emoji, p.color, p.lat, p.lon, now).run();
        return json({ ok: true, id: p.id });
      }
      if (url.pathname === '/api/places/delete') {
        await db.prepare('DELETE FROM places WHERE id = ?').bind(String(body.id || '')).run();
        return json({ ok: true });
      }
      if (url.pathname === '/api/clear') {
        if (body.confirm !== 'DELETE ALL') return json({ error: 'not confirmed' }, 400);
        await db.batch([db.prepare('DELETE FROM pos'), db.prepare('DELETE FROM track')]);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

function cleanPlace(b) {
  const text = (v, n) => String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, n);
  const lat = Number(b.lat), lon = Number(b.lon);
  const color = String(b.color || '');
  const name = text(b.name, 40);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  if (lat < 46.0 || lat > 46.35 || lon < 6.4 || lon > 7.0) return null;   // the map area and around
  const id = /^[a-z0-9-]{3,40}$/.test(b.id || '') ? b.id : 'place-' + crypto.randomUUID().slice(0, 8);
  return { id, name, description: text(b.description, 300), emoji: text(b.emoji, 8) || '📍', color,
    lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

// ------------------------------------------------------------------ Cloudflare Access token check
async function verifyAccess(request, env) {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
  const cookie = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || (cookie && cookie[1]);
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64text(parts[0]));
    const payload = JSON.parse(b64text(parts[1]));
    const team = String(env.TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/$/, '');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.POLICY_AUD)) return null;
    if (payload.iss !== `https://${team}`) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    const certs = await (await fetch(`https://${team}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } })).json();
    const jwk = (certs.keys || []).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64bytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
    return ok ? payload : null;
  } catch (e) {
    return null;
  }
}
function b64bytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function b64text(s) { return new TextDecoder().decode(b64bytes(s)); }
