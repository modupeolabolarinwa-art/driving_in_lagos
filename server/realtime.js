// Real-time layer: WebSocket sessions, zone shards, position sync, reconnect grace.
const { WebSocketServer } = require('ws');
const LD = require('../public/shared.js');

const TICK_MS = 100;            // 10 snapshots per second
const VIEW_RANGE = 2500;        // only send players within this many world units
const GRACE_MS = 60_000;        // a dropped player keeps their slot and fare clock paused this long
const EMOTES = { wave: 'Waves', horn: 'Honks the horn', thanks: 'Thank you o!', sorry: 'Sorry o!', oya: 'Oya, move!' };

function createRealtime({ server, db, economy, ads, jobs, shardCap = 50, log = console }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  let closing = false;
  const sessions = new Map();       // playerId -> session
  const shards = new Map();         // shardId -> { id, zone, members: Set<playerId> }
  const q = {
    byToken: db.prepare('SELECT * FROM players WHERE token = ?'),
    player: db.prepare('SELECT * FROM players WHERE id = ?'),
    savePos: db.prepare('UPDATE players SET pos_x = ?, pos_y = ?, last_seen = ? WHERE id = ?'),
    report: db.prepare('INSERT INTO reports (reporter_id, target_id, reason, created_at) VALUES (?,?,?,?)')
  };

  const send = (s, msg) => { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(msg)); };
  const publicPlayer = (p) => ({ id: p.id, name: p.name, color: p.color });

  /* ---------- Shards ---------- */
  function joinShard(s) {
    const zone = LD.zoneAt(s.y).id;
    let shard = [...shards.values()].find(sh => sh.zone === zone && sh.members.size < shardCap);
    if (!shard) {
      const n = [...shards.values()].filter(sh => sh.zone === zone).length + 1;
      shard = { id: `${zone}-${String(n).padStart(2, '0')}`, zone, members: new Set() };
      shards.set(shard.id, shard);
    }
    shard.members.add(s.player.id);
    s.shard = shard.id;
    const roster = [...shard.members].filter(id => id !== s.player.id).map(id => publicPlayer(sessions.get(id).player));
    send(s, { t: 'shard', shard: shard.id, zone, roster });
    for (const id of shard.members) if (id !== s.player.id) send(sessions.get(id), { t: 'join', player: publicPlayer(s.player) });
  }
  function leaveShard(s) {
    const shard = shards.get(s.shard);
    if (!shard) return;
    shard.members.delete(s.player.id);
    for (const id of shard.members) send(sessions.get(id), { t: 'leave', id: s.player.id });
    if (!shard.members.size) shards.delete(shard.id);
    s.shard = null;
  }

  /* ---------- Connection ---------- */
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const player = q.byToken.get(url.searchParams.get('token') || '');
    if (!player) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    if (player.banned) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, ws => attach(ws, player));
  });

  function attach(ws, player) {
    let s = sessions.get(player.id);
    let resumed = false;
    if (s) {
      if (s.ws && s.ws.readyState === 1) { send(s, { t: 'kicked', reason: 'Signed in on another device' }); s.ws.close(4001); }
      if (s.disconnectedAt) { economy.pauseClock(s.missionId, Date.now() - s.disconnectedAt); resumed = true; }
      clearTimeout(s.graceTimer);
      s.ws = ws; s.disconnectedAt = null;
    } else {
      s = { ws, player, x: player.pos_x, y: player.pos_y, v: 0, lastStateMs: Date.now(), shard: null,
        bucket: 40, bucketAt: Date.now(), strikes: 0, lastEmote: 0, missionId: null, blocked: new Set() };
      sessions.set(player.id, s);
      // Coming back after the grace window: the fare clock stopped when they left.
      const m = economy.current(player.id);
      if (m && player.last_seen) { economy.pauseClock(m.id, Date.now() - Date.parse(player.last_seen)); resumed = true; }
    }
    const expired = economy.expireIfLate(player.id);
    s.player = q.player.get(player.id);
    const m = economy.current(player.id); // players choose their next job from the menu; nothing is forced on them
    s.missionId = m ? m.id : null;
    send(s, { t: 'welcome', resumed, player: { ...publicPlayer(s.player), wallet: s.player.wallet, xp: s.player.xp, reputation: s.player.reputation, points: s.player.points },
      position: { x: s.x, y: s.y }, mission: economy.publicMission(m), bests: economy.bests(player.id), jobs: jobs.listPublic(), ads: { date: LD.isoDate(), campaigns: ads.list() }, emotes: EMOTES });
    if (expired) send(s, { t: 'task.result', ...expired });
    if (s.shard) leaveShard(s);
    joinShard(s);

    ws.on('message', (data) => onMessage(s, data));
    ws.on('close', () => {
      if (closing || s.ws !== ws) return; // shutting down, or replaced by a newer connection
      s.ws = null; s.disconnectedAt = Date.now();
      q.savePos.run(s.x, s.y, new Date().toISOString(), s.player.id);
      leaveShard(s);
      s.graceTimer = setTimeout(() => { sessions.delete(s.player.id); }, GRACE_MS);
      s.graceTimer.unref?.();
    });
  }

  /* ---------- Messages ---------- */
  function rateOk(s) {
    const now = Date.now();
    s.bucket = Math.min(40, s.bucket + (now - s.bucketAt) * 0.03); // refills 30 msgs/s
    s.bucketAt = now;
    if (s.bucket < 1) { if (++s.strikes > 200) s.ws.close(4008, 'Too many messages'); return false; }
    s.bucket -= 1; return true;
  }

  function onMessage(s, data) {
    if (!rateOk(s)) return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'state': return onState(s, msg);
      case 'task.start': {
        const now = Date.now();
        const job = typeof msg.kind === 'string' ? jobs.get(msg.kind) : null;
        if (now - (s.lastTaskStart || 0) < 1500 || !job || !job.enabled) return send(s, { t: 'task.nope', reason: 'That job is not available right now.' });
        s.lastTaskStart = now;
        economy.cancel(s.player.id);
        const m = economy.issue(s.player.id, s.y, msg.kind);
        s.missionId = m.id;
        return send(s, { t: 'task', mission: economy.publicMission(m) });
      }
      case 'task.pickup': {
        const r = economy.pickup(s.player.id, s.missionId, s.y, s.x, s.v);
        return send(s, r.ok ? { t: 'task.picked', mission: r.mission } : { t: 'task.nope', reason: r.reason });
      }
      case 'task.drop': {
        const r = economy.drop(s.player.id, s.missionId, s.y, s.x, s.v);
        if (!r.ok && !r.late) return send(s, { t: 'task.nope', reason: r.reason });
        s.missionId = null;
        return send(s, { t: 'task.result', ...r });
      }
      case 'task.cancel': economy.cancel(s.player.id); s.missionId = null; return send(s, { t: 'task.cancelled' });
      case 'jolt': { const c = economy.jolt(s.player.id); if (c) cargoUpdate(s, c); return; }
      case 'charge': {
        const r = economy.charge(s.player.id, msg.kind);
        if (r.ok) { send(s, { t: 'wallet', wallet: r.wallet, delta: -r.amount, reason: r.label }); if (r.cargo) cargoUpdate(s, r.cargo); }
        return;
      }
      case 'grant': // a modified client trying to pay itself
        log.warn(`[economy] rejected client-side grant from ${s.player.name}: ${JSON.stringify(msg).slice(0, 80)}`);
        return send(s, { t: 'rejected', reason: 'Clients cannot set rewards. The server decides payments.' });
      case 'impressions': ads.record(s.player.id, msg.items); return;
      case 'emote': {
        const now = Date.now();
        if (!EMOTES[msg.e] || now - s.lastEmote < 2000) return;
        s.lastEmote = now;
        const shard = shards.get(s.shard);
        if (shard) for (const id of shard.members) { const o = sessions.get(id); if (!o.blocked.has(s.player.id)) send(o, { t: 'emote', id: s.player.id, e: msg.e }); }
        return;
      }
      case 'block': if (typeof msg.id === 'string') s.blocked.add(msg.id); return;
      case 'unblock': if (typeof msg.id === 'string') s.blocked.delete(msg.id); return;
      case 'report':
        if (typeof msg.id === 'string' && sessions.has(msg.id)) q.report.run(s.player.id, msg.id, String(msg.reason || 'unspecified').slice(0, 120), new Date().toISOString());
        return send(s, { t: 'toast', text: 'Report sent to moderators.' });
      case 'ping': return send(s, { t: 'pong', at: msg.at });
    }
  }

  function cargoUpdate(s, c) {
    if (c.failed) { s.missionId = null; return send(s, { t: 'task.result', ok: false, outcome: 'ruined', kind: c.mission.kind, condition: 0 }); }
    send(s, { t: 'task.cond', condition: c.condition, contraction: !!c.contraction });
  }

  // Movement is client-predicted but server-checked: no teleporting, no speeds above the car's limit.
  function onState(s, msg) {
    const x = Number(msg.x), y = Number(msg.y), v = Number(msg.v);
    if (![x, y, v].every(Number.isFinite)) return;
    const now = Date.now();
    const dt = Math.max(16, now - s.lastStateMs) / 1000;
    const forward = s.y - y;                         // y decreases as you drive up the road
    const maxForward = LD.MAX_SPEED * dt * 1.25 + 30;
    if (forward > maxForward || forward < -300) {
      s.strikes++;
      return send(s, { t: 'correct', x: s.x, y: s.y });
    }
    s.x = Math.max(0, Math.min(LD.ROAD, x));
    s.y = y; s.v = Math.max(0, Math.min(LD.MAX_SPEED, v)); s.lastStateMs = now;
    const zone = LD.zoneAt(s.y).id;
    const shard = shards.get(s.shard);
    if (shard && shard.zone !== zone) { leaveShard(s); joinShard(s); }
  }

  /* ---------- Tick ---------- */
  const tick = setInterval(() => {
    for (const shard of shards.values()) {
      const members = [...shard.members].map(id => sessions.get(id)).filter(Boolean);
      for (const s of members) {
        const others = [];
        for (const o of members) {
          if (o === s || s.blocked.has(o.player.id) || Math.abs(o.y - s.y) > VIEW_RANGE) continue;
          others.push([o.player.id, Math.round(o.x), Math.round(o.y), Math.round(o.v)]);
        }
        send(s, { t: 's', p: others });
      }
    }
  }, TICK_MS);
  // Slow housekeeping: save positions, expire late fares, roll the ad calendar at midnight.
  let lastDate = LD.isoDate();
  const house = setInterval(() => {
    const iso = new Date().toISOString();
    for (const s of sessions.values()) {
      if (!s.ws) continue;
      q.savePos.run(s.x, s.y, iso, s.player.id);
      const expired = economy.expireIfLate(s.player.id);
      if (expired) { s.missionId = null; send(s, { t: 'task.result', ...expired }); }
    }
    if (LD.isoDate() !== lastDate) { lastDate = LD.isoDate(); broadcastAds(); }
  }, 2000);

  function broadcastAds() {
    const msg = { t: 'ads', date: LD.isoDate(), campaigns: ads.list() };
    for (const s of sessions.values()) send(s, msg);
  }
  ads.onChange(broadcastAds);
  jobs.onChange(() => { const msg = { t: 'jobs', jobs: jobs.listPublic() }; for (const s of sessions.values()) send(s, msg); });

  return {
    stats() {
      return { online: [...sessions.values()].filter(s => s.ws).length,
        shards: [...shards.values()].map(sh => ({ id: sh.id, zone: sh.zone, players: sh.members.size })) };
    },
    kick(playerId, reason) { const s = sessions.get(playerId); if (s && s.ws) { send(s, { t: 'kicked', reason }); s.ws.close(4003); } sessions.delete(playerId); },
    close() { closing = true; clearInterval(tick); clearInterval(house); for (const s of sessions.values()) { clearTimeout(s.graceTimer); if (s.ws) s.ws.close(1001); } wss.close(); }
  };
}

module.exports = { createRealtime, EMOTES };
