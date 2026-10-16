// Jobs players can pick from the menu. Stored in the database so the admin page can add and edit them with no rebuild.
const LD = require('../public/shared.js');

const BUILTIN = [
  { id: 'fare', title: 'Passenger', icon: '🧍🏾', blurb: 'Pick up a passenger at the kerb and drop them at their bus stop.',
    who: ['Madam Bisi', 'Chinedu', 'Alhaja Kemi', 'Uncle Femi', 'Ada', 'Mr. Okon', 'Mama Tolu', 'Segun', 'Aunty Ngozi'], pickupTitle: '{who}',
    pickup: 'passenger', call: 'DRIVER! STOP HERE!', dest: 'Bus stop', destStyle: 'busstop', meter: '', fragility: 'none', failAt0: false, contractions: false,
    base: 100, cash: 1, tight: false, msgLoaded: '{who} is in. Drive to the bus stop.', msgOk: 'Thank you driver, God bless you.',
    msgRuined: '', msgLate: 'Your passenger got down and took okada.' },
  { id: 'cake', title: 'Cake run', icon: '🎂', blurb: 'Carry a three-tier wedding cake across pothole road. Every bump cracks the icing.',
    who: ['the Adebayo wedding', 'Sade’s 30th', 'a naming ceremony', 'the Okafor wedding'], pickupTitle: 'Cake for {who}',
    pickup: 'baker', call: 'CAREFUL WITH MY CAKE O!', dest: 'Owambe hall', destStyle: 'owambe', meter: 'Cake', fragility: 'high', failAt0: true, contractions: false,
    base: 250, cash: 1.4, tight: false, msgLoaded: 'Cake loaded. Gently does it…', msgOk: 'The cake arrived. The bride’s mother hugged you.',
    msgRuined: 'The top tier is now on the back seat. The bride is not smiling.', msgLate: 'They cut a supermarket cake instead.' },
  { id: 'stew', title: 'Goat meat stew', icon: '🍲', blurb: 'A cooler of hot goat meat stew for a party. Brake hard and it spills.',
    who: ['Mama Ronke’s 60th', 'an owambe in the estate', 'a church harvest', 'Baba Kunle’s burial reception'], pickupTitle: 'Stew for {who}',
    pickup: 'cooler', call: 'THE STEW IS HOT O!', dest: 'Party venue', destStyle: 'owambe', meter: 'Stew', fragility: 'medium', failAt0: true, contractions: false,
    base: 200, cash: 1.3, tight: false, msgLoaded: 'Cooler loaded. Mind the stew!', msgOk: 'The stew arrived hot. They saved you a plate.',
    msgRuined: 'Your car will smell of goat meat for a week.', msgLate: 'The party started without the stew.' },
  { id: 'labour', title: 'Labour emergency', icon: '🤰🏾', blurb: 'Your passenger is in labour. Get her to the hospital fast, and drive gently through contractions.',
    who: ['Mrs. Eze', 'Aunty Funmi', 'Mrs. Bello', 'Iya Ibeji'], pickupTitle: '{who} · in labour',
    pickup: 'labour', call: 'WATER DON BREAK! HURRY!', dest: 'General Hospital', destStyle: 'hospital', meter: 'Comfort', fragility: 'low', failAt0: false, contractions: true,
    base: 300, cash: 1.6, tight: true, msgLoaded: 'She’s in! Hospital, quick quick!', msgOk: 'Mother and baby are doing well. They want to name the baby after you!',
    msgRuined: '', msgLate: 'Another car took her to the hospital.' }
];

const FIELDS = ['title', 'icon', 'blurb', 'who', 'pickupTitle', 'pickup', 'call', 'dest', 'destStyle', 'meter', 'fragility', 'failAt0', 'contractions',
  'base', 'cash', 'tight', 'msgLoaded', 'msgOk', 'msgRuined', 'msgLate', 'sponsorId', 'enabled'];

function validate(input, partial = false) {
  const out = {}, errors = [];
  const has = (k) => input[k] !== undefined;
  const text = (k, max, label, required = false) => {
    if (!has(k)) { if (!partial && required) errors.push(`${label} is required`); return; }
    const v = String(input[k] ?? '').trim();
    if (required && !v) errors.push(`${label} cannot be empty`);
    else if (v.length > max) errors.push(`${label} must be ${max} characters or fewer`);
    else out[k] = v;
  };
  text('title', 28, 'Title', true); text('icon', 8, 'Icon', true); text('blurb', 160, 'Description', true);
  text('pickupTitle', 40, 'Pickup line'); text('call', 30, 'Pickup shout'); text('dest', 28, 'Destination', true); text('meter', 12, 'Cargo meter');
  text('msgLoaded', 120, 'Loaded message'); text('msgOk', 140, 'Delivered message'); text('msgRuined', 140, 'Ruined message'); text('msgLate', 140, 'Too-late message');
  if (has('who')) {
    const list = (Array.isArray(input.who) ? input.who : String(input.who).split('\n')).map(s => String(s).trim()).filter(Boolean);
    if (!list.length) errors.push('Add at least one passenger or customer name');
    else if (list.length > 20 || list.some(s => s.length > 32)) errors.push('Up to 20 names, each 32 characters or fewer');
    else out.who = list;
  } else if (!partial) errors.push('Add at least one passenger or customer name');
  const pickEnum = (k, allowed, label, def) => {
    if (!has(k)) { if (!partial) out[k] = def; return; }
    if (!Object.keys(allowed).includes(input[k])) errors.push(`${label} must be one of: ${Object.keys(allowed).join(', ')}`); else out[k] = input[k];
  };
  pickEnum('pickup', LD.PICKUP_STYLES, 'Pickup look', 'passenger');
  pickEnum('destStyle', LD.DEST_STYLES, 'Destination look', 'shop');
  pickEnum('fragility', LD.FRAGILITY, 'Fragility', 'none');
  const num = (k, lo, hi, label, def) => {
    if (!has(k)) { if (!partial) out[k] = def; return; }
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) errors.push(`${label} must be between ${lo} and ${hi}`); else out[k] = v;
  };
  num('base', 10, 1000, 'Base points', 150); num('cash', 0.5, 3, 'Pay multiplier', 1);
  for (const k of ['failAt0', 'contractions', 'tight', 'enabled']) if (has(k)) out[k] = !!input[k];
  if (has('sponsorId')) out.sponsorId = input.sponsorId ? String(input.sponsorId).slice(0, 40) : null;
  if (out.pickupTitle !== undefined && out.pickupTitle && !out.pickupTitle.includes('{who}')) out.pickupTitle = out.pickupTitle; // allowed without a name
  return { value: out, errors };
}

function createJobs(db, ads = null) {
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
  const ins = db.prepare('INSERT OR IGNORE INTO jobs (id, data, enabled, sort, builtin, created_at) VALUES (?,?,1,?,1,?)');
  BUILTIN.forEach((j, i) => { const { id, ...data } = j; ins.run(id, JSON.stringify(data), i, new Date().toISOString()); });
  const q = {
    all: db.prepare('SELECT * FROM jobs ORDER BY sort, created_at'),
    get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    upd: db.prepare('UPDATE jobs SET data = ?, enabled = ? WHERE id = ?'),
    sort: db.prepare('UPDATE jobs SET sort = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM jobs WHERE id = ? AND builtin = 0'),
    add: db.prepare('INSERT INTO jobs (id, data, enabled, sort, builtin, created_at) VALUES (?,?,?,?,0,?)'),
    maxSort: db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM jobs'),
    stats: db.prepare(`SELECT kind, COUNT(*) AS started, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS ruined, ROUND(AVG(CASE WHEN status = 'paid' THEN points END)) AS avgPoints FROM missions GROUP BY kind`)
  };
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); };
  const sponsorOf = (id) => {
    if (!id || !ads) return null;
    const c = ads.get(id);
    return c ? { id: c.id, brand: c.brand, bg: c.bg, fg: c.fg, demo: c.demo } : null;
  };
  const row = (r) => { const d = JSON.parse(r.data); return { id: r.id, ...d, enabled: !!r.enabled, builtin: !!r.builtin, sort: r.sort, sponsor: sponsorOf(d.sponsorId) }; };

  const api = {
    onChange(fn) { listeners.add(fn); },
    list() { return q.all.all().map(row); },
    listPublic() { return api.list().filter(j => j.enabled); },
    get(id) { const r = q.get.get(id); return r ? row(r) : null; },
    // A copy of the job saved with each mission, so editing a job never changes the rules of a run already in progress.
    snapshot(id) { const j = api.get(id); if (!j) return null; const { enabled, builtin, sort, ...snap } = j; return snap; },
    stats() { const o = {}; for (const r of q.stats.all()) o[r.kind] = { started: r.started, completed: r.completed || 0, ruined: r.ruined || 0, avgPoints: r.avgPoints || 0 }; return o; },
    create(input) {
      const { value, errors } = validate(input);
      if (errors.length) return { errors };
      const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const { enabled = true, ...data } = value;
      q.add.run(id, JSON.stringify(data), enabled ? 1 : 0, q.maxSort.get().m + 1, new Date().toISOString());
      changed();
      return { job: api.get(id) };
    },
    update(id, input) {
      const r = q.get.get(id);
      if (!r) return { notFound: true };
      const { value, errors } = validate(input, true);
      if (errors.length) return { errors };
      const { enabled, ...data } = value;
      const nextEnabled = enabled === undefined ? !!r.enabled : enabled;
      if (!nextEnabled && r.enabled && api.listPublic().length <= 1) return { errors: ['Keep at least one job switched on'] };
      q.upd.run(JSON.stringify({ ...JSON.parse(r.data), ...data }), nextEnabled ? 1 : 0, id);
      changed();
      return { job: api.get(id) };
    },
    move(id, dir) {
      const list = api.list(), i = list.findIndex(j => j.id === id), k = i + (dir < 0 ? -1 : 1);
      if (i < 0 || k < 0 || k >= list.length) return false;
      [list[i], list[k]] = [list[k], list[i]];
      list.forEach((j, n) => q.sort.run(n, j.id));
      changed();
      return true;
    },
    remove(id) {
      const r = q.get.get(id);
      if (!r) return { notFound: true };
      if (r.builtin) return { errors: ['Built-in jobs can be switched off but not deleted'] };
      if (r.enabled && api.listPublic().length <= 1) return { errors: ['Keep at least one job switched on'] };
      q.del.run(id); changed(); return { ok: true };
    }
  };
  if (ads) ads.onChange(changed); // sponsor names and colours follow campaign edits
  return api;
}

module.exports = { createJobs, validateJob: validate, BUILTIN, FIELDS };
