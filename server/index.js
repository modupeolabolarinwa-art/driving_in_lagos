// Lagos Driver server: static client, REST API (accounts + Brand Network admin), WebSocket game sync.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LD = require('../public/shared.js');
const { open } = require('./db');
const { createEconomy } = require('./economy');
const { createAds } = require('./ads');
const { createRealtime } = require('./realtime');
const { createJobs } = require('./jobs');
const os = require('os');

function start(opts = {}) {
  const PORT = Number(opts.port ?? process.env.PORT ?? 8080);
  const DB_FILE = opts.dbFile ?? process.env.DB_FILE ?? path.join(__dirname, '..', 'data', 'lagos-driver.db');
  let ADMIN_TOKEN = opts.adminToken ?? process.env.ADMIN_TOKEN;
  const log = opts.log ?? console;
  if (!ADMIN_TOKEN) {
    ADMIN_TOKEN = crypto.randomBytes(12).toString('hex');
    log.warn(`[admin] No ADMIN_TOKEN set. Using a one-off token for this run: ${ADMIN_TOKEN}`);
  }

  const db = open(DB_FILE);
  const ads = createAds(db);
  const jobs = createJobs(db, ads);
  const economy = createEconomy(db, undefined, jobs);
  // Brand artwork uploaded from the admin page lives next to the database file.
  const CREATIVES = DB_FILE === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'ld-creatives-')) : path.join(path.dirname(DB_FILE), 'creatives');
  fs.mkdirSync(CREATIVES, { recursive: true });
  const PUBLIC = path.join(__dirname, '..', 'public');
  const COLORS = ['#0f7a4a', '#1aa6a6', '#8e5bd6', '#d1495b', '#2f6fd6', '#e07a1f', '#6a994e', '#c2185b'];
  const BLOCKED_WORDS = ['fuck', 'shit', 'bitch', 'ashawo', 'mumu', 'olodo']; // starter list; extend for launch
  const signups = new Map(); // ip -> [timestamps]

  const q = {
    insPlayer: db.prepare('INSERT INTO players (id, token, name, color, created_at, email, pin_hash, marketing, consent_at) VALUES (?,?,?,?,?,?,?,?,?)'),
    byEmail: db.prepare('SELECT * FROM players WHERE email = ?'),
    setPin: db.prepare('UPDATE players SET pin_hash = ? WHERE id = ?'),
    byToken: db.prepare('SELECT * FROM players WHERE token = ?'),
    nameTaken: db.prepare('SELECT 1 FROM players WHERE lower(name) = lower(?)'),
    players: db.prepare('SELECT id, name, email, marketing, wallet, xp, points, reputation, banned, created_at, last_seen FROM players ORDER BY COALESCE(last_seen, created_at) DESC LIMIT 500'),
    allPlayers: db.prepare('SELECT name, email, marketing, consent_at, points, created_at, last_seen FROM players WHERE email IS NOT NULL ORDER BY created_at'),
    ban: db.prepare('UPDATE players SET banned = ? WHERE id = ?'),
    reports: db.prepare(`SELECT r.id, r.reason, r.created_at, a.name AS reporter, b.name AS target, b.id AS target_id
      FROM reports r JOIN players a ON a.id = r.reporter_id JOIN players b ON b.id = r.target_id ORDER BY r.id DESC LIMIT 100`),
    count: db.prepare('SELECT COUNT(*) AS n FROM players')
  };

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req, limit = 32 * 1024) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('bad json')); } });
  });
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const isAdmin = (req) => {
    const t = Buffer.from(bearer(req)), a = Buffer.from(ADMIN_TOKEN);
    return t.length === a.length && crypto.timingSafeEqual(t, a);
  };

  // PINs are stored as salted scrypt hashes, never as typed.
  const hashPin = (pin) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex'); };
  const pinOk = (pin, stored) => {
    if (!stored) return false;
    const [salt, hex] = stored.split(':'); const a = crypto.scryptSync(String(pin), salt, 32), b = Buffer.from(hex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
  const cleanEmail = (raw) => String(raw || '').trim().toLowerCase();
  const failedLogins = new Map(); // email or ip -> [timestamps]
  const tooMany = (key) => (failedLogins.get(key) || []).filter(t => Date.now() - t < 15 * 60_000).length >= 6;
  const noteFail = (key) => { const a = (failedLogins.get(key) || []).filter(t => Date.now() - t < 15 * 60_000); a.push(Date.now()); failedLogins.set(key, a); };
  const ipOf = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const me = (pl) => ({ token: pl.token, player: { id: pl.id, name: pl.name, email: pl.email } });

  function cleanName(raw) {
    const name = String(raw || '').trim().replace(/\s+/g, '_');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return { error: 'Use 3–16 letters, numbers or underscores.' };
    const low = name.toLowerCase();
    if (BLOCKED_WORDS.some(w => low.includes(w))) return { error: 'Pick a different driver name.' };
    if (q.nameTaken.get(name)) return { error: 'That driver name is taken.' };
    return { name };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/healthz') return json(res, 200, { ok: true });

      /* ---- Accounts ---- */
      // New driver: name, email and a 4-digit PIN so they can sign back in on any phone.
      if (p === '/api/signup' && req.method === 'POST') {
        const ip = ipOf(req);
        const recent = (signups.get(ip) || []).filter(t => Date.now() - t < 60_000);
        if (recent.length >= 10) return json(res, 429, { error: 'Too many new drivers from this connection. Try again in a minute.' });
        const body = await readBody(req);
        const email = cleanEmail(body.email), pin = String(body.pin || '');
        if (!EMAIL.test(email)) return json(res, 400, { error: 'Enter a valid email address.', field: 'email' });
        if (q.byEmail.get(email)) return json(res, 409, { error: 'This email already has a driver. Sign back in with your PIN.', field: 'email', existing: true });
        if (!/^\d{4}$/.test(pin)) return json(res, 400, { error: 'Choose a 4-digit PIN.', field: 'pin' });
        const r = cleanName(body.name);
        if (r.error) return json(res, 400, { error: r.error, field: 'name' });
        recent.push(Date.now()); signups.set(ip, recent);
        const id = crypto.randomUUID(), token = crypto.randomBytes(24).toString('hex'), at = new Date().toISOString();
        q.insPlayer.run(id, token, r.name, COLORS[Math.floor(Math.random() * COLORS.length)], at, email, hashPin(pin), body.marketing ? 1 : 0, body.marketing ? at : null);
        return json(res, 201, me(q.byToken.get(token)));
      }
      if (p === '/api/login' && req.method === 'POST') {
        const ip = ipOf(req), body = await readBody(req);
        const email = cleanEmail(body.email), pin = String(body.pin || '');
        if (tooMany(email) || tooMany(ip)) return json(res, 429, { error: 'Too many wrong PINs. Wait 15 minutes and try again.' });
        const pl = EMAIL.test(email) ? q.byEmail.get(email) : null;
        if (!pl || !pinOk(pin, pl.pin_hash)) { noteFail(email); noteFail(ip); return json(res, 401, { error: 'That email and PIN don’t match.' }); }
        if (pl.banned) return json(res, 403, { error: 'This driver was removed by a moderator.' });
        return json(res, 200, me(pl));
      }
      if (p === '/api/leaderboard') {
        const pl = q.byToken.get(bearer(req));
        return json(res, 200, economy.leaderboard(pl ? pl.id : null));
      }
      if (p === '/api/me') {
        const pl = q.byToken.get(bearer(req));
        if (!pl) return json(res, 401, { error: 'Sign in again.' });
        return json(res, 200, { id: pl.id, name: pl.name, email: pl.email, color: pl.color, wallet: pl.wallet, xp: pl.xp, points: pl.points, reputation: pl.reputation });
      }
      if (p === '/api/ads') return json(res, 200, { date: LD.isoDate(), campaigns: ads.list() });

      /* ---- Brand Network admin ---- */
      if (p.startsWith('/api/admin/')) {
        if (!isAdmin(req)) return json(res, 401, { error: 'Admin token missing or wrong.' });
        const parts = p.split('/').slice(3); // e.g. ['campaigns', 'c1']
        if (parts[0] === 'campaigns') {
          if (req.method === 'GET' && !parts[1]) return json(res, 200, { date: LD.isoDate(), campaigns: ads.list().map(c => ({ ...c, status: LD.status(c, LD.isoDate()) })) });
          if (req.method === 'POST' && !parts[1]) { const r = ads.create(await readBody(req)); return r.errors ? json(res, 400, { errors: r.errors }) : json(res, 201, r.campaign); }
          if (req.method === 'PATCH' && parts[1]) { const r = ads.update(parts[1], await readBody(req)); return r.notFound ? json(res, 404, { error: 'No such campaign.' }) : r.errors ? json(res, 400, { errors: r.errors }) : json(res, 200, r.campaign); }
          if (req.method === 'DELETE' && parts[1]) return ads.remove(parts[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No such campaign.' });
        }
        if (parts[0] === 'jobs') {
          if (req.method === 'GET' && !parts[1]) return json(res, 200, { jobs: jobs.list(), stats: jobs.stats(), pickupStyles: LD.PICKUP_STYLES, destStyles: LD.DEST_STYLES });
          if (req.method === 'POST' && !parts[1]) { const r = jobs.create(await readBody(req)); return r.errors ? json(res, 400, { errors: r.errors }) : json(res, 201, r.job); }
          if (req.method === 'POST' && parts[2] === 'move') { const b = await readBody(req); return json(res, 200, { ok: jobs.move(parts[1], b.dir) }); }
          if (req.method === 'PATCH' && parts[1]) { const r = jobs.update(parts[1], await readBody(req)); return r.notFound ? json(res, 404, { error: 'No such job.' }) : r.errors ? json(res, 400, { errors: r.errors }) : json(res, 200, r.job); }
          if (req.method === 'DELETE' && parts[1]) { const r = jobs.remove(parts[1]); return r.notFound ? json(res, 404, { error: 'No such job.' }) : r.errors ? json(res, 400, { errors: r.errors }) : json(res, 200, { ok: true }); }
        }
        // Brand artwork: PNG, JPEG or WebP up to 2 MB, checked by its actual bytes, saved under a content hash.
        if (parts[0] === 'creatives' && req.method === 'POST') {
          const body = await readBody(req, 3 * 1024 * 1024);
          const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
          if (!m) return json(res, 400, { error: 'Upload a PNG, JPG or WebP image.' });
          const buf = Buffer.from(m[2], 'base64');
          if (buf.length > 2 * 1024 * 1024) return json(res, 400, { error: 'Image must be 2 MB or smaller.' });
          const sig = buf.subarray(0, 12);
          const kind = sig[0] === 0x89 && sig.toString('ascii', 1, 4) === 'PNG' ? 'png' : sig[0] === 0xff && sig[1] === 0xd8 ? 'jpg' : sig.toString('ascii', 0, 4) === 'RIFF' && sig.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
          if (!kind) return json(res, 400, { error: 'That file is not a real PNG, JPG or WebP image.' });
          const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '.' + kind;
          fs.writeFileSync(path.join(CREATIVES, name), buf);
          return json(res, 201, { url: '/creatives/' + name });
        }
        if (parts[0] === 'inventory') return json(res, 200, { date: LD.isoDate(), placements: ads.inventory(url.searchParams.get('date') || LD.isoDate()) });
        if (parts[0] === 'analytics') return json(res, 200, { rows: ads.analytics() });
        if (parts[0] === 'overview') return json(res, 200, { players: q.count.get().n, ...realtime.stats() });
        if (parts[0] === 'players' && !parts[1]) return json(res, 200, { players: q.players.all() });
        if (parts[0] === 'players.csv') {
          const cell = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) || /^[=+\-@]/.test(t) ? '"' + t.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"' : t; };
          const rows = [['driver_name', 'email', 'news_opt_in', 'opt_in_at', 'points', 'joined', 'last_seen'],
            ...q.allPlayers.all().map(r => [r.name, r.email, r.marketing ? 'yes' : 'no', r.consent_at, r.points, r.created_at, r.last_seen])];
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="lagos-driver-players.csv"', 'cache-control': 'no-store' });
          return res.end(rows.map(r => r.map(cell).join(',')).join('\n'));
        }
        if (parts[0] === 'players' && parts[2] === 'pin' && req.method === 'POST') {
          const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
          q.setPin.run(hashPin(pin), parts[1]);
          return json(res, 200, { pin });
        }
        if (parts[0] === 'players' && parts[2] === 'ban' && req.method === 'POST') {
          const body = await readBody(req); q.ban.run(body.banned === false ? 0 : 1, parts[1]);
          if (body.banned !== false) realtime.kick(parts[1], 'Removed by a moderator');
          return json(res, 200, { ok: true });
        }
        if (parts[0] === 'reports') return json(res, 200, { reports: q.reports.all() });
        return json(res, 404, { error: 'Unknown admin route.' });
      }

      if (p.startsWith('/creatives/')) {
        const name = p.slice('/creatives/'.length);
        if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(name)) return json(res, 404, { error: 'Not found' });
        return fs.readFile(path.join(CREATIVES, name), (err, buf) => {
          if (err) return json(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'content-type': { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[name.split('.').pop()], 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
          res.end(buf);
        });
      }

      /* ---- Static client ---- */
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p === '/admin' ? 'admin.html' : p));
      if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
      fs.readFile(file, (err, buf) => {
        if (err) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': p.endsWith('.html') || p === '/' ? 'no-cache' : 'public, max-age=3600' });
        res.end(buf);
      });
    } catch (e) {
      json(res, 400, { error: e.message === 'too large' ? 'Request too large.' : 'Could not read that request.' });
    }
  });

  const realtime = createRealtime({ server, db, economy, ads, jobs, shardCap: Number(process.env.SHARD_CAP || opts.shardCap || 50), log });

  return new Promise(resolve => {
    server.listen(PORT, () => {
      const port = server.address().port;
      log.log(`Lagos Driver running on http://localhost:${port}  (admin: http://localhost:${port}/admin)`);
      resolve({ port, adminToken: ADMIN_TOKEN, close: () => { realtime.close(); server.close(); db.close(); } });
    });
  });
}

if (require.main === module) start();
module.exports = { start };
