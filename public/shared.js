// Shared between the browser client and the Node server.
// One source of truth for world geometry, zones and how a placement picks its campaign.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LD = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const LW = 90, ROAD = 270, SEG = 600, ZONE_LEN = 3600;
  const MAX_SPEED = 500;            // world units per second (≈70 km/h)
  const ZONES = [
    { id: 'IKJ', name: 'Ikeja', stop: 'Ikeja Along', minor: 'Allen Junction', density: 1.0 },
    { id: 'MRY', name: 'Maryland', stop: 'Maryland', minor: 'Mobolaji Bank Anthony', density: 0.95 },
    { id: 'OJT', name: 'Ojota', stop: 'Ojota', minor: 'New Garage', density: 1.25 },
    { id: 'KTU', name: 'Ketu', stop: 'Ketu', minor: 'Alapere', density: 1.1 },
    { id: 'M12', name: 'Mile 12', stop: 'Mile 12', minor: 'Owode Onirin', density: 1.35 }
  ];
  const zoneAbs = (y) => Math.floor(Math.max(0, -y) / ZONE_LEN);
  const zoneAt = (y) => ZONES[zoneAbs(y) % ZONES.length];

  function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  // Placement inventory: 3 bridge banners and 4 sellable danfo slots per zone.
  function inventory() {
    const out = [];
    const vis = [92, 85, 78];
    for (const z of ZONES) {
      for (let i = 1; i <= 3; i++) out.push({ id: `${z.id}-BB-00${i}`, type: 'BILLBOARD', format: 'Bridge banner', zone: z.id, visibility: vis[i - 1], tier: (z.id === 'IKJ' || z.id === 'MRY') && i === 1 ? 'A' : 'B' });
      for (let i = 1; i <= 4; i++) out.push({ id: `${z.id}-DANFO-00${i}`, type: 'DANFO', format: 'Danfo rear panel', zone: z.id, visibility: 70, tier: 'C' });
    }
    return out;
  }

  const HOUSE = { id: 'house', brand: 'Lagos Driver', name: 'House ad (unsold)', headline: 'YOUR BRAND HERE', sub: 'Lagos Driver Brand Network · bridges · danfos · missions', bg: '#1d2a22', fg: '#f2c230', house: true };

  function status(c, date) {
    if (!c.enabled) return 'Paused';
    if (date < c.start) return 'Scheduled';
    if (date > c.end) return 'Ended';
    return 'Live';
  }
  // Billboards fall back to the house ad; unsold danfos return null and keep their slogan.
  function resolve(campaigns, type, zoneId, slotId, date) {
    const live = campaigns.filter(c => c.types.includes(type) && c.zones.includes(zoneId) && status(c, date) === 'Live');
    if (!live.length) return type === 'DANFO' ? null : HOUSE;
    live.sort((a, b) => (a.id < b.id ? -1 : 1));
    return live[hash(slotId) % live.length];
  }
  const isoDate = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  // ---- Jobs: one table both sides read, so the client draws the boxes exactly where the server checks them ----
  const UNITS_PER_M = 26;
  const BOX = { half: 110, x0: 186, x1: 268 };            // yellow loading box on the kerb lane
  const mainStopY = (zAbs) => -(zAbs * 6 + 4) * SEG - 300;  // the big bus stop in each zone
  // Where the drop-off box sits: bus-stop jobs use the zone's main stop; other destinations stand a little before it.
  const dropY = (destStyle, zAbs) => destStyle === 'busstop' ? mainStopY(zAbs) : mainStopY(zAbs) + 400;
  // How much each event damages cargo, by how fragile the job's cargo is. Jolts are hard braking and sharp swerves.
  const FRAGILITY = {
    none: {},
    low: { pothole: 6, crater: 15, collision: 15, pedestrian: 8, jolt: 4 },
    medium: { pothole: 8, crater: 22, collision: 20, pedestrian: 10, jolt: 7 },
    high: { pothole: 12, crater: 35, collision: 25, pedestrian: 15, jolt: 5 }
  };
  const PICKUP_STYLES = { passenger: 'Passenger waving', baker: 'Baker with a cake on a table', cooler: 'Woman with a hot cooler', labour: 'Pregnant woman and her husband', parcel: 'Person holding a parcel' };
  const DEST_STYLES = { busstop: 'Bus stop', owambe: 'Owambe party canopy', hospital: 'Hospital', shop: 'Shop or office with a big sign' };
  // Contractions: every 10 s after pickup, lasting 3.5 s. Bumps during one count double.
  const inContraction = (secsSincePickup) => secsSincePickup > 4 && (secsSincePickup % 10) < 3.5;

  return { LW, ROAD, SEG, ZONE_LEN, MAX_SPEED, ZONES, zoneAbs, zoneAt, hash, inventory, HOUSE, status, resolve, isoDate,
    UNITS_PER_M, BOX, mainStopY, dropY, FRAGILITY, PICKUP_STYLES, DEST_STYLES, inContraction };
});
