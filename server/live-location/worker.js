// Live location sharing for the Morzine ski map (Cloudflare Worker + D1 database "DB").
//
// One endpoint, POST /pos, with a JSON body:
//   { id, name, lat, lon, acc, afterHours }   share my position, get everyone else who shares
//   { id, afterHours }                        get everyone else (only while I am sharing)
//   { id, stop: true }                        stop sharing: I disappear from the map at once
// Reply: { sharing, others: [{ k, name, lat, lon, acc, age }], closed?, outside? }
//
// Rules:
//   - Sharing works from 6:00 to 20:00, French time. After hours only with afterHours: true
//     (a hidden switch in the app).
//   - The map shows each person's latest position since 6:00 this morning.
//   - For emergencies the server keeps a record of positions (table "track"): every position for
//     the last 2 hours, one per 20 minutes for 2 days, nothing older. Nobody sees it in the app.
//     See EMERGENCY.md for how to look someone up.
//   - Positions outside the ski area are not stored. No IP addresses are stored.

const KEEP_MS = 2 * 24 * 3600 * 1000;   // nothing is kept longer than 2 days
const FULL_MS = 2 * 3600 * 1000;        // every position for the last 2 hours, then 1 per 20 min
const CLEAN_EVERY_MS = 10 * 60 * 1000;  // tidy the tables at most every 10 minutes
const MIN_GAP_MS = 20 * 1000;           // at most one stored position per phone every 20 s
const OPEN_HOUR = 6, CLOSE_HOUR = 20;   // French time
const MAX_OTHERS = 300;
const AREA = { w: 6.45, s: 46.03, e: 6.98, n: 46.32 };   // Morzine, Les Gets, Avoriaz and around
const ORIGINS = ['https://ophirmil12.github.io', 'http://127.0.0.1:8000', 'http://localhost:8000'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (new URL(request.url).pathname !== '/pos' || request.method !== 'POST') return reply({ error: 'not found' }, 404);

    let body;
    try { body = await request.json(); } catch (e) { return reply({ error: 'bad request' }, 400); }
    const id = String(body && body.id || '');
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply({ error: 'bad id' }, 400);

    const db = env.DB;
    const now = Date.now();
    await tidy(db, now);

    if (body.stop) {
      await db.prepare('DELETE FROM pos WHERE id = ?').bind(id).run();   // the emergency record stays
      return reply({ sharing: false, others: [] });
    }

    const paris = parisClock(now);
    const open = paris.hour >= OPEN_HOUR && paris.hour < CLOSE_HOUR;
    if (!open && body.afterHours !== true) return reply({ sharing: false, closed: true, others: [] });

    let outside = false;
    const lat = Number(body.lat), lon = Number(body.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      if (lat < AREA.s || lat > AREA.n || lon < AREA.w || lon > AREA.e) {
        outside = true;   // not stored, and I leave the map
        await db.prepare('DELETE FROM pos WHERE id = ?').bind(id).run();
      } else {
        const last = await db.prepare('SELECT t FROM pos WHERE id = ?').bind(id).first();
        if (!last || now - last.t >= MIN_GAP_MS) {
          const name = String(body.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
          const acc = Math.max(0, Math.min(10000, Math.round(Number(body.acc) || 0)));
          const la = round5(lat), lo = round5(lon);
          await db.batch([
            db.prepare(
              `INSERT INTO pos (id, pub, name, lat, lon, acc, t) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lon = excluded.lon,
                 acc = excluded.acc, t = excluded.t`
            ).bind(id, await publicKey(id), name, la, lo, acc, now),
            db.prepare('INSERT INTO track (id, name, lat, lon, acc, t) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(id, name, la, lo, acc, now)
          ]);
        }
      }
    }

    const me = await db.prepare('SELECT 1 AS ok FROM pos WHERE id = ?').bind(id).first();
    if (!me) return reply({ sharing: false, others: [], outside });
    // Everyone seen since 6:00 this morning (French time), newest first.
    const { results } = await db.prepare(
      'SELECT pub, name, lat, lon, acc, t FROM pos WHERE id != ? AND t >= ? ORDER BY t DESC LIMIT ?'
    ).bind(id, paris.lastOpening, MAX_OTHERS).all();
    const others = results.map((r) => ({
      k: r.pub, name: r.name, lat: r.lat, lon: r.lon, acc: r.acc, age: Math.round((now - r.t) / 1000)
    }));
    return reply({ sharing: true, others, outside });
  }
};

/** At most every 10 minutes: drop everything older than 2 days, and thin the emergency record
 *  older than 2 hours to the first position of each 20-minute slot per phone. */
async function tidy(db, now) {
  const m = await db.prepare("SELECT v FROM meta WHERE k = 'tidied'").first();
  if (m && now - m.v < CLEAN_EVERY_MS) return;
  await db.batch([
    db.prepare("INSERT INTO meta (k, v) VALUES ('tidied', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(now),
    db.prepare('DELETE FROM pos WHERE t < ?').bind(now - KEEP_MS),
    db.prepare('DELETE FROM track WHERE t < ?').bind(now - KEEP_MS),
    db.prepare(
      `DELETE FROM track WHERE t < ?1 AND rowid NOT IN
         (SELECT MIN(rowid) FROM track WHERE t < ?1 GROUP BY id, CAST(t / 1200000 AS INTEGER))`
    ).bind(now - FULL_MS)
  ]);
}

/** French time now: the hour, and the time (ms) of the most recent 6:00. */
function parisClock(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const sinceMidnight = ((hour * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000;
  const sinceOpening = sinceMidnight - OPEN_HOUR * 3600 * 1000;
  const lastOpening = now - (sinceOpening >= 0 ? sinceOpening : sinceOpening + 24 * 3600 * 1000);
  return { hour, lastOpening };
}

const round5 = (x) => Math.round(x * 1e5) / 1e5;

/** Short public key: other phones can tell the dots apart but never learn the secret id. */
async function publicKey(id) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('morzine-live:' + id));
  return [...new Uint8Array(hash).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
