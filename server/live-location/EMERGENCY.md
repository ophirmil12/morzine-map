# Finding a skier in an emergency

The quickest way is the admin page: `https://ophirmil12.github.io/morzine-map/admin/` (no login for now). Open the tab "Emergency record" and tap the person. Their path appears on the map, coloured by time, with the time of each point. The SQL below is the fallback.

The server keeps a record of the positions of everyone who shares:
- every position from the last 2 hours
- one position per 20 minutes for the 2 days before that

Older positions are deleted. Only people with access to the Cloudflare account can read the record.

To look someone up, open the Cloudflare dashboard. Go to Storage & databases, then D1, then `morzine-live`, then Console. Paste one of the queries below and change the name. Times are in UTC. French time is UTC+1 in winter.

**Last known position, by name.** The name is what the skier typed in the app.

```sql
SELECT name, lat, lon, acc, datetime(t / 1000, 'unixepoch') AS utc FROM pos WHERE name LIKE '%Dana%' ORDER BY t DESC;
```

**Everything recorded for that name, newest first.**

```sql
SELECT name, lat, lon, acc, datetime(t / 1000, 'unixepoch') AS utc FROM track WHERE name LIKE '%Dana%' ORDER BY t DESC;
```

**Everyone seen in the last hour.** Use this if the name is unknown.

```sql
SELECT name, lat, lon, acc, datetime(t / 1000, 'unixepoch') AS utc FROM pos WHERE t > (strftime('%s','now') - 3600) * 1000 ORDER BY t DESC;
```

To see a position on a map, paste `lat,lon` (for example `46.1795,6.7105`) into the search box of Google Maps or OpenStreetMap.

People who never set a name show as an empty name, and as "Skier" in the app. If someone is missing, ask their group which name they used in the app.
