// Server-authoritative economy and jobs. The client reports what happened; only this module moves money and points.
const LD = require('../public/shared.js');

const { createJobs, BUILTIN } = require('./jobs');
// Fixed charge table. The client names the event; it never names the amount.
const CHARGES = {
  collision: { amount: 2000, label: 'Panel beater after a scrape', rep: -2, cooldownMs: 800, dents: true },
  pedestrian: { amount: 15000, label: 'Near miss with a pedestrian', rep: -10, cooldownMs: 1000, dents: true },
  pothole: { amount: 500, label: 'Suspension check after a pothole', rep: 0, cooldownMs: 1000, dents: false },
  crater: { amount: 2500, label: 'Suspension repair after a crater', rep: -1, cooldownMs: 1000, dents: true },
  tyre: { amount: 3500, label: 'Vulcaniser: burst tyre changed and patched', rep: 0, cooldownMs: 5000, dents: false },
  tow: { amount: 20000, label: 'Tow truck to the mechanic', rep: -5, cooldownMs: 5000, dents: false },
  vio: { amount: 5000, label: 'VIO fine: ignored a stop signal', rep: -4, cooldownMs: 4000, dents: false }
};
const NEAR_Y = 160, NEAR_X = 150, SLOW = 80; // how close and how slow you must be to load or unload

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function createEconomy(db, now = () => Date.now(), jobs = createJobs(db)) {
  const q = {
    player: db.prepare('SELECT * FROM players WHERE id = ?'),
    wallet: db.prepare('UPDATE players SET wallet = wallet + ?, reputation = MAX(0, MIN(100, reputation + ?)), xp = xp + ?, points = points + ? WHERE id = ?'),
    ledger: db.prepare('INSERT INTO ledger (player_id, amount, reason, created_at) VALUES (?,?,?,?)'),
    openMission: db.prepare("SELECT * FROM missions WHERE player_id = ? AND status = 'open' ORDER BY issued_ms DESC LIMIT 1"),
    mission: db.prepare('SELECT * FROM missions WHERE id = ? AND player_id = ?'),
    insMission: db.prepare(`INSERT INTO missions (id, player_id, passenger, target_abs, start_dist, time_limit, issued_ms, kind, phase, pickup_y, drop_y, job)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    close: db.prepare('UPDATE missions SET status = ?, reward = ?, points = ?, closed_ms = ? WHERE id = ?'),
    picked: db.prepare("UPDATE missions SET phase = 'ride', picked_ms = ? WHERE id = ?"),
    dent: db.prepare('UPDATE missions SET damage_hits = damage_hits + 1 WHERE id = ?'),
    cond: db.prepare('UPDATE missions SET condition = ? WHERE id = ?'),
    pause: db.prepare('UPDATE missions SET paused_ms = paused_ms + ? WHERE id = ?'),
    bests: db.prepare("SELECT kind, MAX(points) AS best FROM missions WHERE player_id = ? AND points > 0 GROUP BY kind"),
    board: db.prepare(`SELECT p.id, p.name, p.color, SUM(m.points) AS pts, COUNT(*) AS jobs FROM missions m JOIN players p ON p.id = m.player_id
      WHERE m.closed_ms >= ? AND m.points > 0 AND p.banned = 0 GROUP BY m.player_id ORDER BY pts DESC, jobs DESC LIMIT ?`),
    mine: db.prepare('SELECT COALESCE(SUM(points),0) AS points FROM missions WHERE player_id = ? AND closed_ms >= ? AND points > 0'),
    above: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT m.player_id, SUM(m.points) AS pts FROM missions m JOIN players p ON p.id = m.player_id
      WHERE m.closed_ms >= ? AND m.points > 0 AND p.banned = 0 GROUP BY m.player_id) WHERE pts > ?`)
  };
  const lastCharge = new Map(); // playerId:kind -> ms

  function move(playerId, amount, reason, rep = 0, xp = 0, points = 0) {
    q.wallet.run(amount, rep, xp, points, playerId);
    if (amount) q.ledger.run(playerId, amount, reason, new Date(now()).toISOString());
    return q.player.get(playerId);
  }
  const elapsedSec = (m) => (now() - m.issued_ms - m.paused_ms) / 1000;
  const sincePickup = (m) => m.picked_ms ? (now() - m.picked_ms) / 1000 : 0;
  const near = (y, x, v, targetY) => Math.abs(y - targetY) < NEAR_Y && x > NEAR_X && v < SLOW;
  // The job's rules as they were when this run started.
  const FALLBACK = (() => { const { id, ...d } = BUILTIN[0]; return { id, ...d, sponsor: null }; })();
  const jobOf = (m) => { try { return m.job ? JSON.parse(m.job) : (jobs.snapshot(m.kind) || FALLBACK); } catch { return FALLBACK; } };
  const hurtOf = (J) => LD.FRAGILITY[J.fragility] || {};
  const destName = (m, J = jobOf(m)) => J.destStyle === 'busstop' ? LD.ZONES[m.target_abs % 5].stop : `${J.dest}, ${LD.ZONES[m.target_abs % 5].name}`;

  function publicMission(m) {
    if (!m) return null;
    const J = jobOf(m);
    return { id: m.id, kind: m.kind, job: J, title: J.title, who: m.passenger, dest: destName(m, J), targetAbs: m.target_abs, zone: LD.ZONES[m.target_abs % 5].name,
      limit: m.time_limit, elapsed: Math.max(0, elapsedSec(m)), phase: m.phase, pickupY: m.pickup_y, dropY: m.drop_y,
      condition: Math.round(m.condition), sincePickup: sincePickup(m) };
  }

  // Bumps and jolts damage cargo during the ride. Returns { condition, failed } or null when nothing changed.
  function hurtCargo(playerId, event) {
    const m = q.openMission.get(playerId);
    if (!m || m.phase !== 'ride') return null;
    const J = jobOf(m), H = hurtOf(J);
    if (!H[event]) return null;
    let dmg = H[event];
    if (J.contractions && LD.inContraction(sincePickup(m))) dmg *= 2;
    const condition = Math.max(0, m.condition - dmg);
    q.cond.run(condition, m.id);
    if (condition <= 0 && J.failAt0) {
      q.close.run('failed', 0, 0, now(), m.id);
      return { condition: 0, failed: true, mission: publicMission({ ...m, condition: 0 }) };
    }
    return { condition: Math.round(condition), failed: false, contraction: !!J.contractions && LD.inContraction(sincePickup(m)) };
  }

  return {
    CHARGES,
    current(playerId) { return q.openMission.get(playerId) || null; },
    publicMission,
    bests(playerId) { const o = {}; for (const r of q.bests.all(playerId)) o[r.kind] = r.best; return o; },
    // A new job starts with a pickup a short way ahead of where the server last saw you.
    issue(playerId, serverY, kind = 'fare') {
      const J = jobs.snapshot(kind) || jobs.listPublic()[0] || FALLBACK;
      kind = J.id;
      const K = J;
      const cur = LD.zoneAbs(serverY);
      const targetAbs = cur + 1 + (!K.tight && Math.random() < 0.5 ? 1 : 0);
      const pickupY = serverY - 800;
      const dropY = LD.dropY(J.destStyle, targetAbs);
      const dist = Math.max(0, pickupY - dropY) + 800;
      const limit = Math.round(K.tight ? dist / 300 + 14 : dist / 230 + 24);
      const who = pick(J.who && J.who.length ? J.who : ['a customer']);
      const id = 'J' + now().toString(36) + Math.random().toString(36).slice(2, 6);
      q.insMission.run(id, playerId, who, targetAbs, Math.max(0, -serverY), limit, now(), kind, 'pickup', pickupY, dropY, JSON.stringify(J));
      return q.mission.get(id, playerId);
    },
    pickup(playerId, missionId, y, x, v) {
      const m = q.mission.get(missionId, playerId);
      if (!m || m.status !== 'open' || m.phase !== 'pickup') return { ok: false, reason: 'Nothing to pick up' };
      if (!near(y, x, v, m.pickup_y)) return { ok: false, reason: 'Stop inside the yellow box to load' };
      q.picked.run(now(), m.id);
      return { ok: true, mission: publicMission(q.mission.get(m.id, playerId)) };
    },
    // y, x, v are the position and speed the server accepted, never numbers from the claim itself.
    drop(playerId, missionId, y, x, v) {
      const m = q.mission.get(missionId, playerId);
      if (!m || m.status !== 'open') return { ok: false, reason: 'Unknown or already-closed job' };
      if (m.phase !== 'ride') return { ok: false, reason: 'Pick up first' };
      if (!near(y, x, v, m.drop_y)) return { ok: false, reason: 'Stop inside the yellow box to drop off' };
      const K = jobOf(m), cargo = !!K.meter && Object.keys(hurtOf(K)).length > 0;
      const elapsed = elapsedSec(m);
      const required = Math.max(0, m.pickup_y - m.drop_y);
      if (elapsed < required / LD.MAX_SPEED * 0.95) return { ok: false, reason: 'Faster than any car can drive' };
      const late = elapsed > m.time_limit + 2;
      if (late && !K.contractions) { q.close.run('expired', 0, 0, now(), m.id); return { ok: false, late: true, reason: 'Too late' }; }
      const cond = Math.max(0, m.condition) / 100;
      const timeLeft = Math.max(0, m.time_limit - elapsed);
      const base = 1500 + Math.round(required / 12);
      const bonus = Math.round(timeLeft * 25);
      const dents = m.damage_hits * 400;
      let reward = Math.max(500, Math.round(((base + bonus - dents) * K.cash * (cargo ? 0.4 + 0.6 * cond : 1)) / 50) * 50);
      let points = Math.round(K.base * (cargo ? cond : 1) + timeLeft * (K.tight ? 10 : 4));
      let outcome = 'delivered';
      if (late) { reward = Math.round(reward * 0.5 / 50) * 50; points = Math.round(K.base * 0.4); outcome = 'born'; } // contraction jobs: baby arrived on the way
      q.close.run('paid', reward, points, now(), m.id);
      const pl = move(playerId, reward, `${K.title} ${m.id}: ${m.passenger}`, 2, Math.round(required / 40), points);
      return { ok: true, outcome, reward, points, wallet: pl.wallet, totalPoints: pl.points, condition: Math.round(m.condition), timeLeft: Math.round(timeLeft),
        breakdown: { base, bonus, dents }, kind: m.kind };
    },
    cancel(playerId) {
      const m = q.openMission.get(playerId);
      if (m) q.close.run('cancelled', 0, 0, now(), m.id);
      return !!m;
    },
    // Called by the server's housekeeping tick. Labour that runs out of time ends with the baby born in the car.
    expireIfLate(playerId) {
      const m = q.openMission.get(playerId);
      if (!m || elapsedSec(m) <= m.time_limit + 2) return null;
      const J = jobOf(m);
      if (J.contractions && m.phase === 'ride') {
        const points = Math.round(J.base * 0.3), reward = 1000;
        q.close.run('paid', reward, points, now(), m.id);
        const pl = move(playerId, reward, `${J.title} ${m.id}: baby born on the way`, 1, 0, points);
        return { ok: true, outcome: 'born', reward, points, wallet: pl.wallet, totalPoints: pl.points, kind: m.kind, condition: Math.round(m.condition), timeLeft: 0 };
      }
      q.close.run('expired', 0, 0, now(), m.id);
      return { ok: false, late: true, kind: m.kind, reason: m.phase === 'pickup' ? 'You never picked them up' : 'Too late' };
    },
    pauseClock(missionId, ms) { if (missionId && ms > 0) q.pause.run(Math.round(ms), missionId); },
    charge(playerId, kind) {
      const c = CHARGES[kind];
      if (!c) return { ok: false, reason: 'Unknown event' };
      const key = playerId + ':' + kind, t = now();
      if (t - (lastCharge.get(key) || 0) < c.cooldownMs) return { ok: false, reason: 'Duplicate event ignored' };
      lastCharge.set(key, t);
      const m = q.openMission.get(playerId);
      if (m && c.dents) q.dent.run(m.id);
      const cargo = hurtCargo(playerId, kind);
      const pl = move(playerId, -c.amount, c.label, c.rep, 0);
      return { ok: true, amount: c.amount, label: c.label, wallet: pl.wallet, cargo };
    },
    // Hard braking and sharp swerves: no charge, but they slosh stew and wobble cakes.
    jolt(playerId) {
      const key = playerId + ':jolt', t = now();
      if (t - (lastCharge.get(key) || 0) < 900) return null;
      lastCharge.set(key, t);
      return hurtCargo(playerId, 'jolt');
    },
    // Weekly leaderboard: Monday 00:00 Lagos time (UTC+1) to now.
    weekStart(at = now()) { const lag = new Date(at + 3600_000); const day = (lag.getUTCDay() + 6) % 7; return Date.UTC(lag.getUTCFullYear(), lag.getUTCMonth(), lag.getUTCDate() - day) - 3600_000; },
    leaderboard(playerId, limit = 20) {
      const since = this.weekStart();
      const rows = q.board.all(since, limit).map((r, i) => ({ rank: i + 1, name: r.name, color: r.color, points: r.pts, jobs: r.jobs, me: r.id === playerId }));
      let me = null;
      if (playerId) { const pts = q.mine.get(playerId, since).points; me = { points: pts, rank: pts ? q.above.get(since, pts).n + 1 : null }; }
      return { since: new Date(since).toISOString(), rows, me };
    }
  };
}

module.exports = { createEconomy, CHARGES };
