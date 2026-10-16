// SQLite persistence using Node's built-in driver (node:sqlite, Node 22.5+).
// Swap for Postgres when you outgrow one machine; the queries are plain SQL.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      wallet INTEGER NOT NULL DEFAULT 5000,
      xp INTEGER NOT NULL DEFAULT 0,
      reputation INTEGER NOT NULL DEFAULT 50,
      pos_y REAL NOT NULL DEFAULT 0,
      pos_x REAL NOT NULL DEFAULT 135,
      banned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      passenger TEXT NOT NULL,
      target_abs INTEGER NOT NULL,
      start_dist REAL NOT NULL,
      time_limit INTEGER NOT NULL,
      issued_ms INTEGER NOT NULL,
      paused_ms INTEGER NOT NULL DEFAULT 0,
      damage_hits INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      reward INTEGER
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      brand TEXT NOT NULL,
      name TEXT NOT NULL,
      headline TEXT NOT NULL,
      sub TEXT NOT NULL,
      bg TEXT NOT NULL,
      fg TEXT NOT NULL,
      types TEXT NOT NULL,
      zones TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      demo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS impressions (
      campaign_id TEXT NOT NULL,
      placement_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      day TEXT NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0,
      exposure_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (campaign_id, placement_id, player_id, day)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrate(db);
  seedCampaigns(db);
  migrateOnce(db, 'brands-2026-10', () => addBrandDemos(db));
  return db;
}

// Add columns to databases created by earlier versions. Safe to run on every start.
function addCol(db, table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  addCol(db, 'players', 'email', 'TEXT');
  addCol(db, 'players', 'pin_hash', 'TEXT');
  addCol(db, 'players', 'marketing', 'INTEGER NOT NULL DEFAULT 0');
  addCol(db, 'players', 'consent_at', 'TEXT');
  addCol(db, 'players', 'points', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS players_email ON players(email)');
  addCol(db, 'missions', 'kind', "TEXT NOT NULL DEFAULT 'fare'");
  addCol(db, 'missions', 'phase', "TEXT NOT NULL DEFAULT 'ride'");
  addCol(db, 'missions', 'pickup_y', 'REAL');
  addCol(db, 'missions', 'drop_y', 'REAL');
  addCol(db, 'missions', 'condition', 'REAL NOT NULL DEFAULT 100');
  addCol(db, 'missions', 'points', 'INTEGER');
  addCol(db, 'missions', 'picked_ms', 'INTEGER');
  addCol(db, 'missions', 'closed_ms', 'INTEGER');
  addCol(db, 'missions', 'job', 'TEXT');
  addCol(db, 'campaigns', 'image', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS missions_closed ON missions(closed_ms)');
  // Fares left open by the previous version have no yellow boxes; close them so the driver picks a fresh job.
  db.exec("UPDATE missions SET status = 'cancelled' WHERE status = 'open' AND drop_y IS NULL");
}
function migrateOnce(db, key, fn) {
  if (db.prepare('SELECT 1 FROM meta WHERE k = ?').get(key)) return;
  fn();
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run(key, new Date().toISOString());
}
// Demo placements for real brands. Flagged demo: no signed deal exists. Confirm with each brand before showing publicly.
function addBrandDemos(db) {
  const all = JSON.stringify(['IKJ', 'MRY', 'OJT', 'KTU', 'M12']);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO campaigns (id,brand,name,headline,sub,bg,fg,types,zones,start,end,enabled,demo,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?)`);
  ins.run('gtco-fw', 'GTCO', 'GTCO Fashion Weekend', 'GTCO FASHION WEEKEND', 'Demo placement · Lagos Driver Brand Network', '#e05206', '#ffffff', '["BILLBOARD"]', all, '2026-10-01', '2026-12-31', now);
  ins.run('vale-app', 'Vale', 'Get the Vale app', 'GET THE VALE APP', 'Demo placement · Lagos Driver Brand Network', '#13294b', '#ffd23f', '["BILLBOARD","DANFO"]', all, '2026-10-01', '2026-12-31', now);
  // The fictional "Fashion Weekend" sample is replaced by the GTCO demo.
  db.prepare("UPDATE campaigns SET enabled = 0 WHERE id = 'c1' AND brand = 'Eko Trust Bank'").run();
}

function seedCampaigns(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM campaigns').get().n;
  if (n > 0) return;
  const all = JSON.stringify(['IKJ', 'MRY', 'OJT', 'KTU', 'M12']);
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO campaigns (id,brand,name,headline,sub,bg,fg,types,zones,start,end,enabled,demo,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?)`);
  // Fictional sample brands: safe to show publicly. Replace with signed deals via the admin dashboard.
  ins.run('c1', 'Eko Trust Bank', 'Fashion Weekend', 'FASHION WEEKEND', 'Eko Trust Bank · Lagos Island · 28–30 Nov', '#5b1a3a', '#ffd9a8', '["BILLBOARD"]', '["IKJ","MRY","OJT"]', '2026-10-01', '2026-11-30', now);
  ins.run('c2', 'Zobo Republic', 'Cold Zobo Run', 'ZOBO REPUBLIC', 'Chilled zobo · ₦300 at every bus stop', '#7a1020', '#fff1e0', '["DANFO"]', all, '2026-09-15', '2026-12-31', now);
  ins.run('c3', 'Island Jollof Fest', 'December Jollof Fest', 'JOLLOF FEST', 'Tafawa Balewa Square · 20 Dec', '#e0672a', '#1b1209', '["BILLBOARD"]', '["OJT","KTU","M12"]', '2026-12-01', '2026-12-24', now);
}

module.exports = { open };
