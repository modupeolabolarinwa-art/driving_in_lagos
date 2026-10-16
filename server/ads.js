// Lagos Driver Brand Network: campaigns, placement inventory, impression counting.
const LD = require('../public/shared.js');

const TYPES = ['BILLBOARD', 'DANFO'];
const ZONE_IDS = LD.ZONES.map(z => z.id);
const INVENTORY = LD.inventory();
const PLACEMENT_IDS = new Set(INVENTORY.map(p => p.id));
const HEX = /^#[0-9a-f]{6}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/;

function row(r) {
  return { id: r.id, brand: r.brand, name: r.name, headline: r.headline, sub: r.sub, bg: r.bg, fg: r.fg,
    types: JSON.parse(r.types), zones: JSON.parse(r.zones), start: r.start, end: r.end, enabled: !!r.enabled, demo: !!r.demo, image: r.image || null };
}

function validate(input, partial = false) {
  const out = {}, errors = [];
  const text = (k, max, required = true) => {
    if (input[k] === undefined) { if (!partial && required) errors.push(`${k} is required`); return; }
    const v = String(input[k]).trim();
    if (!v && required) errors.push(`${k} cannot be empty`);
    else if (v.length > max) errors.push(`${k} must be ${max} characters or fewer`);
    else out[k] = v;
  };
  text('brand', 32); text('name', 40); text('headline', 22); text('sub', 48);
  for (const k of ['bg', 'fg']) {
    if (input[k] === undefined) { if (!partial) errors.push(`${k} is required`); continue; }
    if (!HEX.test(input[k])) errors.push(`${k} must be a colour like #1a2b3c`); else out[k] = input[k];
  }
  for (const [k, allowed] of [['types', TYPES], ['zones', ZONE_IDS]]) {
    if (input[k] === undefined) { if (!partial) errors.push(`${k} is required`); continue; }
    if (!Array.isArray(input[k]) || !input[k].length || input[k].some(v => !allowed.includes(v))) errors.push(`${k} must be a list from: ${allowed.join(', ')}`);
    else out[k] = [...new Set(input[k])];
  }
  for (const k of ['start', 'end']) {
    if (input[k] === undefined) { if (!partial) errors.push(`${k} is required`); continue; }
    if (!DAY.test(input[k])) errors.push(`${k} must be a date like 2026-11-01`); else out[k] = input[k];
  }
  if (out.start && out.end && out.end < out.start) errors.push('end must be on or after start');
  for (const k of ['enabled', 'demo']) if (input[k] !== undefined) out[k] = !!input[k];
  if (input.image !== undefined) {
    if (input.image === null || input.image === '') out.image = null;
    else if (/^\/creatives\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(String(input.image))) out.image = String(input.image);
    else errors.push('image must be an uploaded artwork file');
  }
  if (out.headline) out.headline = out.headline.toUpperCase();
  return { value: out, errors };
}

function createAds(db) {
  const q = {
    all: db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC, id'),
    get: db.prepare('SELECT * FROM campaigns WHERE id = ?'),
    del: db.prepare('DELETE FROM campaigns WHERE id = ?'),
    upsertImp: db.prepare(`INSERT INTO impressions (campaign_id, placement_id, player_id, day, impressions, exposure_ms) VALUES (?,?,?,?,?,?)
      ON CONFLICT(campaign_id, placement_id, player_id, day) DO UPDATE SET impressions = impressions + excluded.impressions, exposure_ms = exposure_ms + excluded.exposure_ms`),
    analytics: db.prepare(`SELECT campaign_id, SUM(impressions) AS impressions, SUM(exposure_ms) AS exposure_ms,
      COUNT(DISTINCT player_id) AS unique_players, COUNT(DISTINCT placement_id) AS placements FROM impressions GROUP BY campaign_id`),
    sponsored: db.prepare(`SELECT json_extract(job, '$.sponsorId') AS cid, COUNT(*) AS started, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS completed
      FROM missions WHERE job IS NOT NULL AND json_extract(job, '$.sponsorId') IS NOT NULL GROUP BY cid`)
  };
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); };

  const api = {
    onChange(fn) { listeners.add(fn); },
    list() { return q.all.all().map(row); },
    get(id) { const r = q.get.get(id); return r ? row(r) : null; },
    create(input) {
      const { value, errors } = validate(input);
      if (errors.length) return { errors };
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      db.prepare(`INSERT INTO campaigns (id,brand,name,headline,sub,bg,fg,types,zones,start,end,enabled,demo,created_at,image) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, value.brand, value.name, value.headline, value.sub, value.bg, value.fg, JSON.stringify(value.types), JSON.stringify(value.zones),
          value.start, value.end, value.enabled === false ? 0 : 1, value.demo === false ? 0 : 1, new Date().toISOString(), value.image || null);
      changed();
      return { campaign: api.get(id) };
    },
    update(id, input) {
      const existing = api.get(id);
      if (!existing) return { notFound: true };
      const { value, errors } = validate(input, true);
      const merged = { ...existing, ...value };
      if (merged.end < merged.start) errors.push('end must be on or after start');
      if (errors.length) return { errors };
      db.prepare(`UPDATE campaigns SET brand=?,name=?,headline=?,sub=?,bg=?,fg=?,types=?,zones=?,start=?,end=?,enabled=?,demo=?,image=? WHERE id=?`)
        .run(merged.brand, merged.name, merged.headline, merged.sub, merged.bg, merged.fg, JSON.stringify(merged.types), JSON.stringify(merged.zones),
          merged.start, merged.end, merged.enabled ? 1 : 0, merged.demo ? 1 : 0, merged.image || null, id);
      changed();
      return { campaign: api.get(id) };
    },
    remove(id) { const r = q.del.run(id); if (r.changes) changed(); return r.changes > 0; },
    inventory(date = LD.isoDate()) {
      const camps = api.list();
      return INVENTORY.map(p => {
        const c = LD.resolve(camps, p.type, p.zone, p.id, date);
        return { ...p, showing: c ? (c.house ? 'House ad' : `${c.brand} · ${c.name}`) : 'Unsold · slogan', campaignId: c ? c.id : null };
      });
    },
    // A client batch: [{c: campaignId, p: placementId, imp: 0|1, ms: exposure}]. Clamped so one client cannot inflate a campaign.
    record(playerId, items, date = LD.isoDate()) {
      if (!Array.isArray(items)) return 0;
      const camps = new Map(api.list().map(c => [c.id, c]));
      let n = 0;
      for (const it of items.slice(0, 40)) {
        if (!it || typeof it.c !== 'string' || typeof it.p !== 'string') continue;
        if (it.c !== 'house' && !camps.has(it.c)) continue;
        if (!PLACEMENT_IDS.has(it.p)) continue;
        const imp = it.imp ? 1 : 0;
        const ms = Math.max(0, Math.min(60000, Math.round(Number(it.ms) || 0)));
        q.upsertImp.run(it.c, it.p, playerId, date, imp, ms);
        n++;
      }
      return n;
    },
    analytics() {
      const byId = new Map(q.analytics.all().map(r => [r.campaign_id, r]));
      let sp = new Map(); try { sp = new Map(q.sponsored.all().map(r => [r.cid, r])); } catch (_) {}
      const rows = [...api.list(), LD.HOUSE].map(c => {
        const a = byId.get(c.id) || {};
        const imp = a.impressions || 0, exp = (a.exposure_ms || 0) / 1000;
        return { id: c.id, label: c.house ? 'House ad (unsold)' : `${c.brand} · ${c.name}`, status: c.house ? 'Fallback' : LD.status(c, LD.isoDate()),
          impressions: imp, exposureSec: Math.round(exp * 10) / 10, avgExposureSec: imp ? Math.round(exp / imp * 10) / 10 : null,
          uniquePlayers: a.unique_players || 0, placements: a.placements || 0,
          jobsStarted: (sp.get(c.id) || {}).started || 0, jobsCompleted: (sp.get(c.id) || {}).completed || 0 };
      });
      return rows;
    }
  };
  return api;
}

module.exports = { createAds, validate };
