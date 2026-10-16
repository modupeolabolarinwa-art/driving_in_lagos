// End-to-end check: two real WebSocket players, the economy rules, and live Brand Network updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { start } = require('../server/index.js');
const { open } = require('../server/db.js');
const { createEconomy } = require('../server/economy.js');
const LD = require('../public/shared.js');

const quiet = { log() {}, warn() {}, error() {} };

function client(port, token) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', d => {
    const m = JSON.parse(d);
    const w = waiters.find(w => w.pred(m));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } else inbox.push(m);
  });
  return {
    ws, inbox,
    send: m => ws.send(JSON.stringify(m)),
    wait(pred, ms = 3000) {
      const hit = inbox.find(pred); if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve, reject) => { const w = { pred, resolve }; waiters.push(w); setTimeout(() => reject(new Error('timeout waiting for message')), ms); });
    },
    opened: new Promise(r => ws.on('open', r)),
    closed: new Promise(r => ws.on('close', r))
  };
}
async function post(port, path, body, headers = {}) {
  const r = await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const signup = (port, name, email, pin = '1234', marketing = false) => post(port, '/api/signup', { name, email, pin, marketing });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('two players, one shard, server-authoritative economy, live ads', async (t) => {
  const srv = await start({ port: 0, dbFile: ':memory:', adminToken: 'test-admin', log: quiet });
  t.after(() => srv.close());
  const { port } = srv;

  // accounts: name, email and PIN
  assert.equal((await signup(port, 'x', 'x@example.com')).status, 400);
  assert.equal((await signup(port, 'Okay_Name', 'not-an-email')).status, 400);
  assert.equal((await signup(port, 'Okay_Name', 'ok@example.com', '12')).status, 400, 'PIN must be 4 digits');
  const a = await signup(port, 'Tunde_IKJ', 'Tunde@Example.com', '4321', true);
  const b = await signup(port, 'Chioma', 'chioma@example.com');
  assert.equal(a.status, 201);
  assert.equal((await signup(port, 'tunde_ikj', 'other@example.com')).status, 400, 'names are unique, case-insensitive');
  const dup = await signup(port, 'Another', 'tunde@example.com');
  assert.equal(dup.status, 409); assert.equal(dup.body.existing, true, 'same email is sent to sign-in instead');
  // signing back in on another phone
  assert.equal((await post(port, '/api/login', { email: 'tunde@example.com', pin: '0000' })).status, 401);
  const back1 = await post(port, '/api/login', { email: ' TUNDE@example.com ', pin: '4321' });
  assert.equal(back1.status, 200);
  assert.equal(back1.body.token, a.body.token, 'sign-in returns the same driver');

  // unauthenticated socket is refused
  const anon = new WebSocket(`ws://localhost:${port}/ws?token=nope`);
  await new Promise(r => anon.on('error', r));

  const A = client(port, a.body.token), B = client(port, b.body.token);
  const wa = await A.wait(m => m.t === 'welcome');
  await B.wait(m => m.t === 'welcome');
  assert.equal(wa.player.wallet, 5000);
  assert.equal(wa.mission, null, 'players pick their own job from the menu');
  assert.equal(wa.ads.campaigns.length, 5, 'seeded demo campaigns are delivered');
  assert.ok(wa.ads.campaigns.some(c => c.id === 'gtco-fw' && c.demo) && wa.ads.campaigns.some(c => c.id === 'vale-app' && c.demo), 'brand demos are flagged demo');

  const shardA = await A.wait(m => m.t === 'shard');
  assert.equal(shardA.shard, 'IKJ-01');
  const joined = await A.wait(m => m.t === 'join');
  assert.equal(joined.player.name, 'Chioma');

  // B drives; A sees B in snapshots
  B.send({ t: 'state', x: 45, y: -40, v: 300 });
  const snap = await A.wait(m => m.t === 's' && m.p.some(p => p[0] === joined.player.id && p[2] === -40));
  assert.ok(snap);

  // teleport is corrected back to the last accepted position
  await sleep(50);
  B.send({ t: 'state', x: 45, y: -20000, v: 300 });
  const corr = await B.wait(m => m.t === 'correct');
  assert.equal(corr.y, -40);

  // client cannot pay itself
  A.send({ t: 'grant', amount: 50000 });
  const rej = await A.wait(m => m.t === 'rejected');
  assert.match(rej.reason, /cannot set rewards/);

  // charges come from the server table, with duplicate protection
  A.send({ t: 'charge', kind: 'collision' });
  const w1 = await A.wait(m => m.t === 'wallet');
  assert.equal(w1.wallet, 3000);
  A.send({ t: 'charge', kind: 'collision' });
  A.send({ t: 'charge', kind: 'made_up', amount: -99999 });
  await sleep(150);
  assert.ok(!A.inbox.some(m => m.t === 'wallet'), 'duplicate and unknown charges are ignored: ');
  B.send({ t: 'charge', kind: 'vio' });
  const w2 = await B.wait(m => m.t === 'wallet');
  assert.equal(w2.wallet, 0, 'VIO fine comes from the server table');
  B.send({ t: 'charge', kind: 'crater' });
  const w3 = await B.wait(m => m.t === 'wallet');
  assert.equal(w3.wallet, -2500, 'crater repair comes from the server table');

  // jobs: start one, can't load away from the box, can't drop before loading
  A.send({ t: 'task.start', kind: 'cake' });
  const job = await A.wait(m => m.t === 'task');
  assert.equal(job.mission.kind, 'cake'); assert.equal(job.mission.phase, 'pickup');
  A.send({ t: 'task.drop' });
  assert.match((await A.wait(m => m.t === 'task.nope')).reason, /Pick up first/);
  A.send({ t: 'task.pickup' });
  assert.match((await A.wait(m => m.t === 'task.nope')).reason, /yellow box/);

  // admin auth
  const unauth = await fetch(`http://localhost:${port}/api/admin/campaigns`);
  assert.equal(unauth.status, 401);
  const H = { 'content-type': 'application/json', authorization: 'Bearer test-admin' };
  const invalid = await fetch(`http://localhost:${port}/api/admin/campaigns`, { method: 'POST', headers: H, body: JSON.stringify({ brand: 'X' }) });
  assert.equal(invalid.status, 400);

  // a new campaign reaches every connected player without a rebuild
  const created = await fetch(`http://localhost:${port}/api/admin/campaigns`, { method: 'POST', headers: H, body: JSON.stringify({
    brand: 'Owambe Telecom', name: 'Detty December Data', headline: 'data no dey finish', sub: '10GB for ₦1,500', bg: '#0c4f8a', fg: '#ffe066',
    types: ['BILLBOARD', 'DANFO'], zones: ['KTU', 'M12'], start: '2026-01-01', end: '2099-12-31' }) });
  assert.equal(created.status, 201);
  const camp = await created.json();
  const adsA = await A.wait(m => m.t === 'ads' && m.campaigns.length === 6);
  const adsB = await B.wait(m => m.t === 'ads' && m.campaigns.length === 6);
  assert.ok(adsA && adsB);
  const live = adsA.campaigns.filter(c => c.types.includes('BILLBOARD') && c.zones.includes('KTU') && LD.status(c, LD.isoDate()) === 'Live');
  assert.ok(live.some(c => c.id === camp.id), 'the new campaign is now in rotation on Ketu bridges');

  // impressions are recorded and validated
  A.send({ t: 'impressions', items: [{ c: camp.id, p: 'KTU-BB-001', imp: 1, ms: 2500 }, { c: camp.id, p: 'FAKE-001', imp: 1, ms: 99999 }, { c: 'nope', p: 'KTU-BB-001', imp: 1, ms: 1 }] });
  await sleep(150);
  const an = await (await fetch(`http://localhost:${port}/api/admin/analytics`, { headers: H })).json();
  const row = an.rows.find(x => x.id === camp.id);
  assert.equal(row.impressions, 1);
  assert.equal(row.exposureSec, 2.5);

  // drop and reconnect: same job, same wallet
  const fareBefore = job;
  A.ws.close(); await A.closed;
  const leave = await B.wait(m => m.t === 'leave');
  assert.ok(leave);
  const A2 = client(port, a.body.token);
  const back = await A2.wait(m => m.t === 'welcome');
  assert.equal(back.resumed, true);
  assert.equal(back.mission.id, fareBefore.mission.id);
  assert.equal(back.player.wallet, 3000);

  // admin: add a custom sponsored job; it reaches players live and can be played
  const bad = await fetch(`http://localhost:${port}/api/admin/jobs`, { method: 'POST', headers: H, body: JSON.stringify({ title: '' }) });
  assert.equal(bad.status, 400);
  const jr = await fetch(`http://localhost:${port}/api/admin/jobs`, { method: 'POST', headers: H, body: JSON.stringify({
    title: 'Jollof delivery', icon: '🍛', blurb: 'Party jollof for a naming ceremony.', who: 'Mama Tolu\nIya Basira', pickupTitle: 'Jollof for {who}',
    pickup: 'cooler', call: 'JOLLOF DEY HOT!', dest: 'Naming ceremony', destStyle: 'owambe', meter: 'Jollof', fragility: 'medium', failAt0: true,
    base: 220, cash: 1.2, sponsorId: 'gtco-fw' }) });
  assert.equal(jr.status, 201);
  const custom = await jr.json();
  const liveJobs = await B.wait(m => m.t === 'jobs' && m.jobs.some(j => j.id === custom.id));
  assert.equal(liveJobs.jobs.find(j => j.id === custom.id).sponsor.brand, 'GTCO', 'sponsor brand travels with the job');
  B.send({ t: 'task.start', kind: custom.id });
  const bj = await B.wait(m => m.t === 'task');
  assert.equal(bj.mission.job.title, 'Jollof delivery'); assert.equal(bj.mission.job.meter, 'Jollof');
  // switching it off removes it from the menu; built-ins can't be deleted
  await fetch(`http://localhost:${port}/api/admin/jobs/${custom.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ enabled: false }) });
  const off = await B.wait(m => m.t === 'jobs' && !m.jobs.some(j => j.id === custom.id));
  assert.ok(off);
  assert.equal((await fetch(`http://localhost:${port}/api/admin/jobs/fare`, { method: 'DELETE', headers: H })).status, 400);
  // brand artwork: real images only
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex').toString('base64');
  const up = await fetch(`http://localhost:${port}/api/admin/creatives`, { method: 'POST', headers: H, body: JSON.stringify({ dataUrl: png }) });
  assert.equal(up.status, 201);
  const { url } = await up.json();
  assert.equal((await fetch(`http://localhost:${port}${url}`)).headers.get('content-type'), 'image/png');
  const fake = await fetch(`http://localhost:${port}/api/admin/creatives`, { method: 'POST', headers: H, body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + Buffer.from('<script>').toString('base64') }) });
  assert.equal(fake.status, 400, 'non-images are refused');
  const edited = await fetch(`http://localhost:${port}/api/admin/campaigns/gtco-fw`, { method: 'PATCH', headers: H, body: JSON.stringify({ image: url, headline: 'fashion weekend' }) });
  assert.equal((await edited.json()).image, url);
  assert.equal((await fetch(`http://localhost:${port}/api/admin/campaigns/gtco-fw`, { method: 'PATCH', headers: H, body: JSON.stringify({ image: 'https://evil.example/x.png' }) })).status, 400);

  // moderation: report and ban
  B.send({ t: 'report', id: wa.player.id, reason: 'test' });
  await B.wait(m => m.t === 'toast');
  const reps = await (await fetch(`http://localhost:${port}/api/admin/reports`, { headers: H })).json();
  assert.equal(reps.reports.length, 1);
  await fetch(`http://localhost:${port}/api/admin/players/${wa.player.id}/ban`, { method: 'POST', headers: H, body: '{}' });
  await A2.closed;
  const again = new WebSocket(`ws://localhost:${port}/ws?token=${a.body.token}`);
  await new Promise(r => again.on('error', r));
  B.ws.close();
});

test('jobs pay only for honest driving, and bumps ruin cargo', () => {
  const db = open(':memory:');
  db.prepare("INSERT INTO players (id, token, name, color, created_at) VALUES ('p','t','Ada','#000','now')").run();
  let clock = 1_000_000;
  const eco = createEconomy(db, () => clock);
  // passenger: load in the box, drop in the box
  const m = eco.issue('p', 0, 'fare');
  assert.equal(eco.pickup('p', m.id, m.pickup_y + 400, 230, 0).ok, false, 'too far from the box');
  assert.equal(eco.pickup('p', m.id, m.pickup_y, 230, 300).ok, false, 'must stop, not drive through');
  assert.equal(eco.pickup('p', m.id, m.pickup_y + 30, 230, 5).ok, true);
  clock += 1000;
  assert.match(eco.drop('p', m.id, m.drop_y, 230, 0).reason, /Faster than any car/);
  clock += ((m.pickup_y - m.drop_y) / 350) * 1000;
  assert.match(eco.drop('p', m.id, m.drop_y + 900, 230, 0).reason, /yellow box/);
  const ok = eco.drop('p', m.id, m.drop_y - 40, 230, 10);
  assert.equal(ok.ok, true); assert.ok(ok.reward >= 500); assert.ok(ok.points >= 100);
  assert.equal(eco.drop('p', m.id, m.drop_y, 230, 0).ok, false, 'a job can only be paid once');
  // cake: craters ruin it
  const c = eco.issue('p', m.drop_y, 'cake');
  eco.pickup('p', c.id, c.pickup_y, 230, 0);
  let r; for (let i = 0; i < 3; i++) { clock += 1200; r = eco.charge('p', 'crater'); }
  assert.equal(r.cargo.failed, true, 'three craters and the cake is ruined');
  assert.equal(eco.current('p'), null);
  // stew: jolts spill some, delivered stew pays fewer points than perfect
  const st = eco.issue('p', m.drop_y, 'stew');
  eco.pickup('p', st.id, st.pickup_y, 230, 0);
  clock += 1000; assert.equal(eco.jolt('p').condition, 93);
  assert.equal(eco.jolt('p'), null, 'jolts are rate-limited');
  clock += ((st.pickup_y - st.drop_y) / 350) * 1000;
  const sd = eco.drop('p', st.id, st.drop_y, 230, 0);
  assert.equal(sd.ok, true); assert.equal(sd.condition, 93);
  // labour: running out of time ends with the baby born on the way, still a small payout
  const lb = eco.issue('p', st.drop_y, 'labour');
  eco.pickup('p', lb.id, lb.pickup_y, 230, 0);
  clock += (lb.time_limit + 5) * 1000;
  const born = eco.expireIfLate('p');
  assert.equal(born.outcome, 'born'); assert.ok(born.points > 0);
  // leaderboard counts this week's points
  const board = eco.leaderboard('p');
  assert.equal(board.rows[0].name, 'Ada'); assert.equal(board.me.rank, 1);
  assert.equal(board.rows[0].points, ok.points + sd.points + born.points);
  db.close();
});
