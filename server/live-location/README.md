# Live location sharing server

A Cloudflare Worker (`worker.js`) with a D1 database bound as `DB`. It runs on the free plan.
The site calls it from `site/js/share.js` (`API_DEPLOYED`).

Deployed at `https://morzine-live.ophirmil1234.workers.dev/pos`, database `morzine-live`.

## Set up or update

1. **Tables.** In the Cloudflare dashboard, go to Storage & databases, then D1, then `morzine-live`, then Console. Paste this one line. The console joins pasted lines into one, so comments would break it.

   ```sql
   CREATE TABLE IF NOT EXISTS pos (id TEXT PRIMARY KEY, pub TEXT NOT NULL, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, acc INTEGER NOT NULL, t INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS pos_t ON pos (t); CREATE TABLE IF NOT EXISTS track (id TEXT NOT NULL, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, acc INTEGER NOT NULL, t INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS track_t ON track (t); CREATE INDEX IF NOT EXISTS track_id_t ON track (id, t); CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
   ```

2. **Code.** Go to Workers & Pages, then `morzine-live`, then Edit code. Replace everything with `worker.js` and click Deploy.

   Pinned places (added 26 Nov 2026), also one line:

   ```sql
   CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, emoji TEXT NOT NULL, color TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, updated INTEGER NOT NULL); INSERT OR IGNORE INTO places VALUES ('house-1', 'House', '1130 Route de la Côte, 74110 La Côte-d''Arbroz, France', '🏠', '#B45309', 46.1901, 6.673783, 0);
   ```

3. **Binding.** This is done once. In the Worker, go to Settings, then Bindings, and add a D1 database with the variable name `DB` and the database `morzine-live`.

`schema.sql` is the same as the one-line command, with comments.

## Rules

- **Hours.** Sharing works from 6:00 to 20:00, French time. After hours it works only with the hidden switch in the app, which turns itself off at midnight.
- **What the map shows.** It shows the latest position of everyone who shared since 6:00 this morning. People who stopped sending are drawn in light purple, with the time since their last position.
- **Emergency record (`track` table).** It keeps every position from the last 2 hours, and one position per 20 minutes for 2 days. Older positions are deleted. Nobody can see this record in the app. See EMERGENCY.md.
- **Outside the ski area.** Positions outside the ski area are never stored. No IP addresses are stored.

## Free plan

About 30 people with one request every 3 minutes for 14 hours comes to roughly 8,400 requests a day, plus one small places request each time someone opens the map. The free plan allows 100,000 requests a day, and 100,000 database row writes a day.

## Admin page (`admin-worker.js`, Worker `morzine-admin`)

The admin page is at `https://morzine-admin.ophirmil1234.workers.dev/`. The map site's `/admin/` link sends you there. **For now it has no login (the owner's choice, 26 Nov 2026):** anyone with the address can open it, and the page shows a red warning bar. To turn the login on, set up Cloudflare Access for the Worker's workers.dev address and add the variables `TEAM_DOMAIN` and `POLICY_AUD`. The Worker then checks the Access token on every request.

It can:
- show who is sharing right now
- show the emergency record of one person, as a path on the map coloured by time, with the time of each point
- switch location sharing on or off for everyone
- add, edit and delete pinned places (name, description, emoji, colour, position)
- delete all location data (it asks twice)

**Editing it.** Change `admin/page.html` or `admin/worker-src.js`. Then run `python -I tools/build_admin_worker.py` and paste the built `admin-worker.js` into the Worker.

**Its settings in Cloudflare:**
- the D1 binding `DB` (`morzine-live`)
- later, for the login: the variables `TEAM_DOMAIN` (for example `myteam.cloudflareaccess.com`) and `POLICY_AUD` (the Access application's AUD tag), and Cloudflare Access turned on for its workers.dev address

**Testing locally without the login.** Run `python -I tools/live_dev_server.py --seed` and open `http://127.0.0.1:8787/admin`.
