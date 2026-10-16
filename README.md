# Lagos Driver — online server

The first online build of Lagos Driver. One Node process serves the game, runs the multiplayer zones, owns the economy and powers the Lagos Driver Brand Network.

## Run it

Needs Node 22.5 or newer (it uses Node's built-in SQLite). One dependency: `ws`.

```bash
npm install
ADMIN_TOKEN=choose-a-long-secret npm start
```

- Game: http://localhost:8080 — open it in two browsers or two phones to see each other.
- Brand Network admin: http://localhost:8080/admin — paste your `ADMIN_TOKEN`.
- Tests: `npm test` (two real WebSocket players, the economy rules, live ad updates, reconnect, moderation).

| Setting | Default | What it does |
|---|---|---|
| `PORT` | 8080 | HTTP and WebSocket port |
| `ADMIN_TOKEN` | random each run (printed in the log) | Unlocks `/admin` and `/api/admin/*` |
| `DB_FILE` | `data/lagos-driver.db` | SQLite file. Put it on a persistent disk in production |
| `SHARD_CAP` | 50 | Drivers per zone shard before a new shard opens |

## What is built

**Accounts.** New drivers give a driver name (3–16 letters, numbers or underscores, unique, word-filtered), an email and a 4-digit PIN, plus an optional tick-box to receive news and brand offers (opt-in, with the time recorded). Returning drivers sign back in on any phone with email + PIN. PINs are stored as salted scrypt hashes; 6 wrong PINs locks that email or connection out for 15 minutes. Other drivers only ever see the driver name.
- The saved login is only forgotten when the server says it is invalid or the driver signs out. Network drops and server restarts never lock anyone out (this was the "can't sign back in" bug in the previous version).
- Opening the game on a second phone or tab moves the session there; the first one shows "Play here instead" to take it back.
- Admin → Players shows email and news opt-in, exports a CSV, and can reset a driver's PIN.

**Zones and shards.** The road runs Ikeja → Maryland → Ojota → Ketu → Mile 12. Each zone has shards (`IKJ-01`, `IKJ-02`…); a new one opens automatically when a shard is full. Driving into the next zone moves you to that zone's shard.

**Position sync.** Clients send position 10 times a second, only when it changes. The server sends each driver a 10 Hz snapshot of other drivers within range, and the client draws them 150 ms in the past, interpolating between snapshots so movement stays smooth on a patchy connection. Moves faster than the car's top speed are rejected and the client is snapped back.

**Jobs.** Players pick a job from the menu, stop in a yellow box to load, and stop in the yellow box at the destination to get paid. Overshoot? Hold brake when stopped to reverse.
- Passenger: drop them at their zone's main bus stop.
- Cake run: a wedding cake to an owambe hall. Potholes, craters, scrapes and hard braking crack it; at 0% it's ruined and you're paid nothing.
- Goat meat stew: a hot cooler to a party. Hard braking and sharp swerves slosh it more than bumps.
- Labour emergency: a woman in labour to General Hospital on a tight clock. Every 10 s a contraction starts; bumps during one hurt twice as much. Run out of time and the baby is born in the car (small payout, never a failure state for her).
- Points = job base × cargo condition + time bonus. Weekly leaderboard (Monday 00:00 Lagos time). Cargo condition is computed on the server from the same events it charges for.

**Admin: jobs and brands (http://localhost:8080/admin).** Unlock with your `ADMIN_TOKEN`.
- *Jobs tab*: add your own jobs with no code. Pick a title, emoji, description, who waits at pickup (passenger, baker with cake, woman with cooler, pregnant woman and husband, person with parcel), what they shout, a list of names, the destination name and look (bus stop, owambe canopy, hospital, shop with a big sign), a cargo meter and how fragile it is, normal or tight time, whether it fails at 0%, contractions, points, pay, and the four messages. Optionally attach a sponsor campaign: the job shows "Sponsored by …", the destination sign uses the brand's colours, and Analytics counts sponsored jobs played and completed. Reorder, hide, edit or delete jobs; built-ins can be edited or hidden but not deleted. Changes reach players within a second; a run in progress keeps the rules it started with.
- *Brands & campaigns tab*: Edit any campaign (wording, colours, dates, zones, placements, demo flag) and upload brand artwork (PNG/JPG/WebP, up to 2 MB; checked by its real bytes; stored in `data/creatives/`). Artwork replaces the headline text in the game, fitted without cropping. Best sizes: 1400 × 200 px for bridge banners, 600 × 260 px for danfo rear panels.

**Server-authoritative economy.** The server issues fares, checks arrival against the position *it* accepted, rejects impossible speeds and late arrivals, and computes the reward. Charges (scrape, pedestrian near-miss, pothole, crater, burst tyre, tow, VIO fine) come from a fixed server table; the client only names the event. A client that tries to pay itself is rejected and logged. Every naira movement is written to the `ledger` table.

**Disconnection.** If a driver drops, their fare clock pauses and their slot is held for 60 seconds. On reconnect they get the same fare and wallet back. The client shows "Connection lost. Reconnecting…" and retries with backoff.

**Driver's-seat view.** The game is drawn from behind the wheel (left-hand drive): windscreen, bonnet, dashboard, a steering wheel that turns with you, and a rear-view mirror showing traffic behind. Ahead you see danfos with slogans and branded rear panels, conductors hanging out shouting calls, bus marshals waving, pedestrians stepping off the kerb, potholes, pedestrian bridges with banners, shops with signboards, power lines and roof tanks. Gameplay and server rules are unchanged; only the camera moved.

**VIO checkpoints.** A VIO officer stands at the start of each zone beside a patrol vehicle and cones. Sometimes he steps out with a stop paddle. Stop near him for a papers check and drive on; drive past (or pull off mid-check) and the server charges a fixed ₦5,000 fine (`vio` in the charge table).

**Potholes (the challenge).** Every stretch of road has rugged potholes: broken tarmac, exposed red earth, cracks, loose slabs, some full of muddy water so you can't see the depth. Craters sit in lanes, sometimes with a leafy branch stuck in them as a warning, and some stretches are a gauntlet where two lanes are broken up and you must thread the clean one.
- Hits are judged per wheel, so a small pothole can pass between your wheels.
- Crawl through slowly (under about 15 km/h for a pothole, 10 km/h for a crater) and there's no damage, just a bump.
- Hit one at speed: the camera jolts, the car is yanked sideways, it loses speed and takes damage, and the server charges ₦500 (pothole) or ₦2,500 (crater).
- A crater at over about 40 km/h can burst a tyre: the car limps at about 32 km/h and pulls to one side until you stop for 3 seconds to fit the spare (₦3,500 vulcaniser charge).
- A streak counter shows how many potholes in a row you've dodged.

**Phones.** Thumb controls float over the dashboard (steer on the left, brake and gas on the right, all usable at once), phones vibrate on hits where supported, the game asks for full screen when you tap Drive (Android), and the layout adapts to landscape. The game lowers its own drawing resolution if a phone struggles, to keep it smooth.

**Anti-griefing.** Other players are drawn and AI traffic reacts to them, but players can't crash into each other, so nobody can wreck another driver's run on purpose.

**Moderation.** No free text chat yet, only five preset emotes, limited to one every two seconds. Drivers can block (hides that driver and their emotes) and report. Admins see reports and can ban, which disconnects the driver and refuses future logins. All messages are rate-limited per socket.

**Brand Network.**
- Campaigns live in the database. Creating, pausing or removing one in `/admin` reaches every connected player within a second; no rebuild or redeploy.
- Placements: 3 pedestrian-bridge banners and 4 sellable danfo rear panels per zone (on the back of the bus, where a driver actually sees it) (35 in total), e.g. `IKJ-BB-001`, `OJT-DANFO-003`.
- Scheduling by start and end date. A billboard with nothing live shows the house ad; an unsold danfo keeps its painted slogan.
- **Impression** = at least half the creative inside the windscreen and at least 56 px wide (readable) for 1 continuous second, once per pass. Vehicles in front blocking the view are not yet subtracted. Clients report in 5-second batches; the server drops unknown campaigns or placements and caps exposure per report.
- Analytics per campaign: impressions, unique drivers, exposure time, average exposure, placements reached.
- Every campaign carries a Demo / Signed deal flag. Seeded demos: GTCO Fashion Weekend (bridge banners) and Get the Vale App (banners and danfo rear panels), both flagged DEMO, plus fictional sample brands. The real-brand demos are text only, no logos. Confirm with each brand before showing the game publicly.
- The menu's "Today" card features a live campaign, so it changes from the admin page too.

## Project layout

```
public/shared.js     zones, road geometry, placement inventory, ad resolution (used by client AND server)
public/index.html    the game client
public/admin.html    Brand Network admin
server/index.js      HTTP: static files, accounts, admin API
server/realtime.js   WebSocket sessions, shards, snapshots, reconnect, moderation
server/economy.js    fares, charges, ledger
server/ads.js        campaigns, inventory, impressions, analytics
server/db.js         SQLite schema and demo seed
test/smoke.test.js   end-to-end tests
```

## Admin API

All routes need `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Route | |
|---|---|---|
| GET | `/api/admin/overview` | drivers online, shards |
| GET / POST | `/api/admin/campaigns` | list / create |
| PATCH / DELETE | `/api/admin/campaigns/:id` | edit (any field, incl. `enabled`, `demo`) / remove |
| GET | `/api/admin/inventory?date=YYYY-MM-DD` | every placement and what it shows on that date |
| GET | `/api/admin/analytics` | per-campaign figures |
| GET | `/api/admin/players`, `/api/admin/reports` | moderation |
| POST | `/api/admin/players/:id/ban` | body `{"banned": false}` to unban |

## Deploying

Any host that runs a long-lived Node process with WebSockets works (Render, Railway, Fly.io, a small VPS). Set `ADMIN_TOKEN`, put `DB_FILE` on a persistent volume, and serve over HTTPS so the client uses `wss://`. For players in Nigeria, pick a region close to West Africa (London or Frankfurt is usually the nearest option on the big hosts; Lagos and Johannesburg if your provider has them).

## Not built yet, in the order I'd tackle them

1. **Shared AI traffic.** Each player's danfos, pedestrians and potholes run on their own phone, so two players see different traffic. Next step: the shard server simulates traffic and sends it in the snapshot.
2. **Proper accounts.** Phone/OTP or email sign-in so a driver keeps their wallet across devices; guest accounts can be upgraded.
3. **Postgres + Redis** when one machine is no longer enough: Postgres for players and the ledger, Redis for presence so shards can run on several machines.
4. **Brand self-service portal** (brand logins, creative upload, approval queue) and image creatives instead of text-only banners.
5. **Sponsored missions and live events**, weather, vehicle ownership and upgrades.
6. Third-party verification of impression numbers before selling inventory to agencies.
