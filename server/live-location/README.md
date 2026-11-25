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

3. **Binding.** This is done once. In the Worker, go to Settings, then Bindings, and add a D1 database with the variable name `DB` and the database `morzine-live`.

`schema.sql` is the same as the one-line command, with comments.

## Rules

- **Hours.** Sharing works from 6:00 to 20:00, French time. After hours it works only with the hidden switch in the app, which turns itself off at midnight.
- **What the map shows.** It shows the latest position of everyone who shared since 6:00 this morning. People who stopped sending are drawn in light purple, with the time since their last position.
- **Emergency record (`track` table).** It keeps every position from the last 2 hours, and one position per 20 minutes for 2 days. Older positions are deleted. Nobody can see this record in the app. See EMERGENCY.md.
- **Outside the ski area.** Positions outside the ski area are never stored. No IP addresses are stored.

## Free plan

About 30 people sending every 3 minutes, plus checking the others every minute, comes to roughly 34,000 requests a day. The free plan allows 100,000 requests a day, and 100,000 database row writes a day.
