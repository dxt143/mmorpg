'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const TEST_HOOKS = process.env.ENABLE_TEST_HOOKS === '1';

const WORLD = { w: 2400, h: 2400 };
const SPAWN = { x: WORLD.w / 2, y: WORLD.h / 2 };
const SHOP = { x: SPAWN.x + 80, y: SPAWN.y };
const TICK_MS = 1000 / 30;
const SNAP_EVERY = 2;
const POTION_PRICE = 25;
const INV_MAX = 24;

const MOB_TYPES = {
  slime: { hp: 35, dmg: 6, speed: 95, aggro: 280, atkRange: 46, atkCd: 1.2, xp: 15, r: 16, lvl: 1, name: 'Slime' },
  boar:  { hp: 90, dmg: 12, speed: 135, aggro: 320, atkRange: 52, atkCd: 1.1, xp: 40, r: 18, lvl: 3, name: 'Boar' },
  wolf:  { hp: 150, dmg: 18, speed: 185, aggro: 400, atkRange: 50, atkCd: 0.9, xp: 90, r: 17, lvl: 5, name: 'Wolf' },
  boss:  { hp: 1500, dmg: 32, speed: 125, aggro: 750, atkRange: 72, atkCd: 1.0, xp: 500, r: 34, lvl: 10, name: 'Embermaw' },
};

const LOOT_TABLE = {
  1: { gold: [4, 10], w: { name: 'Rusty Shiv', power: 4 }, a: { name: 'Cloth Vest', power: 10 }, wc: 0.10, ac: 0.10 },
  3: { gold: [10, 22], w: { name: 'Iron Sword', power: 10 }, a: { name: 'Leather Armor', power: 22 }, wc: 0.12, ac: 0.12 },
  5: { gold: [22, 40], w: { name: 'Steel Blade', power: 18 }, a: { name: 'Chain Mail', power: 38 }, wc: 0.15, ac: 0.15 },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(1337);
const obstacles = [];
for (let i = 0; i < 170; i++) {
  const x = 60 + rng() * (WORLD.w - 120);
  const y = 60 + rng() * (WORLD.h - 120);
  if (Math.hypot(x - SPAWN.x, y - SPAWN.y) < 230) continue;
  obstacles.push({ x: Math.round(x), y: Math.round(y), r: Math.round(15 + rng() * 10), kind: rng() < 0.62 ? 'tree' : 'rock' });
}

const players = new Map();
const mobs = new Map();
const loot = new Map();
const clients = new Map();
let nextId = 1;
let nextLootId = 1;
let nextItemId = 1;
let tickCount = 0;
let serverTime = 0;

const DATA_DIR = path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'players.json');
let db = {};
try {
  const raw = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  if (raw && typeof raw === 'object') db = raw;
} catch {}

function saveDB() {
  for (const p of players.values()) {
    db[p.name.toLowerCase()] = { name: p.name, level: p.level, xp: Math.round(p.xp), gold: p.gold, inv: p.inv, equip: p.equip };
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = SAVE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, SAVE_FILE);
  } catch (e) {
    console.error('save failed:', e.message);
  }
}
setInterval(saveDB, 10000);
process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });

function xpNext(level) {
  return Math.floor(40 * Math.pow(level, 1.6));
}
function playerMaxHp(level) { return 100 + (level - 1) * 25; }
function playerDamage(level) { return 10 + (level - 1) * 6; }
function playerSpeed(level) { return 230 + (level - 1) * 3; }

function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function collide(e, radius) {
  e.x = clamp(e.x, radius, WORLD.w - radius);
  e.y = clamp(e.y, radius, WORLD.h - radius);
  for (const o of obstacles) {
    const d = dist(e.x, e.y, o.x, o.y);
    const min = o.r + radius;
    if (d < min && d > 0.0001) {
      e.x = o.x + (e.x - o.x) / d * min;
      e.y = o.y + (e.y - o.y) / d * min;
    }
  }
}

function makeMob(type) {
  const t = MOB_TYPES[type];
  let x, y, tries = 0;
  do {
    x = 80 + rng() * (WORLD.w - 160);
    y = 80 + rng() * (WORLD.h - 160);
    tries++;
  } while (dist(x, y, SPAWN.x, SPAWN.y) < (type === 'boss' ? 900 : 260) && tries < 60);
  return {
    id: nextId++, type, x, y, hp: t.hp, maxHp: t.hp,
    homeX: x, homeY: y, state: 'wander', tx: x, ty: y, retargetAt: 0,
    atkCd: 0, targetId: null, respawnAt: 0, wanderAt: 0,
  };
}
for (let i = 0; i < 45; i++) { const m = makeMob('slime'); mobs.set(m.id, m); }
for (let i = 0; i < 25; i++) { const m = makeMob('boar'); mobs.set(m.id, m); }
for (let i = 0; i < 14; i++) { const m = makeMob('wolf'); mobs.set(m.id, m); }
{ const b = makeMob('boss'); mobs.set(b.id, b); }

function rollRar() {
  const r = rng();
  return r < 0.04 ? 3 : r < 0.2 ? 2 : 1;
}
function makeItem(base, rar) {
  const power = base.power ? Math.round(base.power * (1 + 0.25 * ((rar || 1) - 1))) : 0;
  return { uid: nextItemId++, kind: base.kind, name: String(base.name || 'item').slice(0, 30), power, rar: rar || 1 };
}
function saneItem(it) {
  if (!it || typeof it !== 'object') return null;
  if (!['weapon', 'armor', 'potion'].includes(it.kind)) return null;
  return {
    uid: it.uid | 0,
    kind: it.kind,
    name: String(it.name || 'item').slice(0, 30),
    power: clamp(Math.round(Number(it.power) || 0), 0, 10000),
    rar: [1, 2, 3].includes(it.rar) ? it.rar : 1,
  };
}

function addLoot(x, y, data) {
  const a = rng() * Math.PI * 2;
  const r = 8 + rng() * 14;
  const id = nextLootId++;
  loot.set(id, {
    id,
    x: clamp(x + Math.cos(a) * r, 20, WORLD.w - 20),
    y: clamp(y + Math.sin(a) * r, 20, WORLD.h - 20),
    kind: data.kind,
    amount: data.amount || 0,
    item: data.item || null,
    despawnAt: serverTime + 60000,
  });
}

function dropLoot(x, y, lvl) {
  const t = LOOT_TABLE[lvl] || LOOT_TABLE[1];
  const amount = t.gold[0] + Math.floor(rng() * (t.gold[1] - t.gold[0] + 1));
  addLoot(x, y, { kind: 'gold', amount });
  if (rng() < 0.22) addLoot(x, y, { kind: 'item', item: makeItem({ kind: 'potion', name: 'Health Potion' }) });
  if (rng() < t.wc) addLoot(x, y, { kind: 'item', item: makeItem({ kind: 'weapon', name: t.w.name, power: t.w.power }, rollRar()) });
  if (rng() < t.ac) addLoot(x, y, { kind: 'item', item: makeItem({ kind: 'armor', name: t.a.name, power: t.a.power }, rollRar()) });
}

const usedNames = new Set();
function uniqueName(raw) {
  let name = String(raw || '').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Wanderer';
  let base = name, n = 2;
  while (usedNames.has(name)) name = base + n++;
  usedNames.add(name);
  return name;
}
function hueFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function recomputeStats(p) {
  p.maxHp = playerMaxHp(p.level) + (p.equip.armor ? p.equip.armor.power : 0);
  p.atk = playerDamage(p.level) + (p.equip.weapon ? p.equip.weapon.power : 0);
  if (p.hp > p.maxHp) p.hp = p.maxHp;
}

function addPlayer(client, name) {
  const clean = uniqueName(name);
  const saved = db[clean.toLowerCase()];
  const a = rng() * Math.PI * 2;
  const p = {
    id: client.id, name: clean, color: hueFor(clean),
    x: SPAWN.x + Math.cos(a) * 40, y: SPAWN.y + Math.sin(a) * 40,
    hp: 100, maxHp: 100, atk: 10, level: 1, xp: 0, gold: 0,
    inv: [], equip: { weapon: null, armor: null },
    atkCd: 0, input: { u: 0, d: 0, l: 0, r: 0 }, fx: 1, fy: 0,
    alive: true, lastChat: 0,
  };
  if (saved) {
    p.level = clamp(saved.level | 0, 1, 60);
    p.xp = clamp(Math.round(Number(saved.xp) || 0), 0, 1e9);
    p.gold = clamp(Math.round(Number(saved.gold) || 0), 0, 1e9);
    p.inv = (Array.isArray(saved.inv) ? saved.inv : []).map(saneItem).filter(Boolean).slice(0, INV_MAX);
    const eq = saved.equip || {};
    p.equip.weapon = saneItem(eq.weapon);
    p.equip.armor = saneItem(eq.armor);
  }
  recomputeStats(p);
  p.hp = p.maxHp;
  players.set(client.id, p);
  client.playerId = p.id;
  return p;
}
function removePlayer(client) {
  const p = players.get(client.id);
  if (p) { usedNames.delete(p.name); players.delete(client.id); saveDB(); }
}

function send(client, obj) {
  if (client.ready) client.socket.write(encodeFrame(JSON.stringify(obj)));
}
function broadcast(obj) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const c of clients.values()) if (c.ready) c.socket.write(frame);
}
function sysChat(msg) {
  broadcast({ t: 'chat', sys: true, n: 'Server', m: msg, c: '#9aa' });
}
function sendInv(p) {
  const client = clients.get(p.id);
  if (client) send(client, { t: 'inv', inv: p.inv, equip: p.equip, gold: p.gold });
}

function addXp(p, amount) {
  const client = clients.get(p.id);
  p.xp += amount;
  let leveled = false;
  while (p.xp >= xpNext(p.level)) {
    p.xp -= xpNext(p.level);
    p.level++;
    recomputeStats(p);
    p.hp = p.maxHp;
    leveled = true;
  }
  if (leveled && client) send(client, { t: 'ev', k: 'level', level: p.level, maxHp: p.maxHp });
}

function damageMob(mob, dmg, p) {
  if (mob.respawnAt) return;
  mob.hp -= dmg;
  mob.targetId = p.id;
  mob.state = 'chase';
  const client = clients.get(p.id);
  if (client) send(client, { t: 'ev', k: 'hit', id: mob.id, dmg: Math.round(dmg), crit: dmg > p.atk * 1.5 });
  if (mob.hp <= 0) {
    mob.hp = 0;
    mob.respawnAt = serverTime + (mob.type === 'boss' ? 90000 : 6000);
    mob.state = 'wander';
    const t = MOB_TYPES[mob.type];
    if (client) send(client, { t: 'ev', k: 'kill', id: mob.id, name: t.name, xp: t.xp });
    addXp(p, t.xp);
    if (mob.type === 'boss') {
      sysChat(`Embermaw has been slain by ${p.name}!`);
      p.gold += 200;
      if (client) send(client, { t: 'ev', k: 'gold', n: 200 });
      const drops = [
        makeItem({ kind: 'weapon', name: 'Dragonfang', power: 40 }, 3),
        makeItem({ kind: 'armor', name: 'Emberplate', power: 80 }, 3),
        makeItem({ kind: 'potion', name: 'Health Potion' }),
        makeItem({ kind: 'potion', name: 'Health Potion' }),
      ];
      for (const it of drops) {
        if (p.inv.length < INV_MAX) {
          p.inv.push(it);
          if (client) send(client, { t: 'ev', k: 'loot', it });
        }
      }
      sendInv(p);
    } else {
      dropLoot(mob.x, mob.y, t.lvl);
    }
  }
}

function damagePlayer(p, dmg, mob) {
  if (!p.alive) return;
  p.hp -= dmg;
  const client = clients.get(p.id);
  if (client) send(client, { t: 'ev', k: 'hurt', dmg: Math.round(dmg), from: MOB_TYPES[mob.type].name });
  if (p.hp <= 0) {
    p.hp = 0;
    p.alive = false;
    p.xp = Math.floor(p.xp * 0.9);
    if (client) send(client, { t: 'ev', k: 'dead' });
    sysChat(`${p.name} was slain by a ${MOB_TYPES[mob.type].name}`);
    setTimeout(() => {
      p.alive = true;
      p.hp = p.maxHp;
      p.x = SPAWN.x + (rng() - 0.5) * 60;
      p.y = SPAWN.y + (rng() - 0.5) * 60;
      p.input = { u: 0, d: 0, l: 0, r: 0 };
    }, 2500);
  }
}

function playerAttack(p) {
  if (!p.alive || p.atkCd > 0) return;
  let best = null, bestD = 82;
  for (const m of mobs.values()) {
    if (m.respawnAt) continue;
    const d = dist(p.x, p.y, m.x, m.y);
    if (d < bestD) { bestD = d; best = m; }
  }
  p.atkCd = 0.45;
  if (!best) return;
  const crit = rng() < 0.12;
  const dmg = p.atk * (0.85 + rng() * 0.3) * (crit ? 2 : 1);
  damageMob(best, dmg, p);
}

function applyLoot(p, l) {
  const client = clients.get(p.id);
  if (l.kind === 'gold') {
    p.gold += l.amount;
    if (client) send(client, { t: 'ev', k: 'gold', n: l.amount });
  } else if (l.item) {
    if (p.inv.length >= INV_MAX) {
      if (client) send(client, { t: 'ev', k: 'err', m: 'Inventory full' });
      return false;
    }
    p.inv.push(l.item);
    if (client) send(client, { t: 'ev', k: 'loot', it: l.item });
    sendInv(p);
  }
  return true;
}

function stepMob(m, dt) {
  const t = MOB_TYPES[m.type];
  if (m.respawnAt) {
    if (serverTime >= m.respawnAt) {
      const nm = makeMob(m.type);
      m.x = nm.x; m.y = nm.y; m.homeX = nm.x; m.homeY = nm.y;
      if (m.type === 'boss') sysChat('Embermaw has appeared in Embervale!');
      m.hp = m.maxHp; m.respawnAt = 0; m.state = 'wander'; m.targetId = null;
    }
    return;
  }
  m.atkCd -= dt;
  if (m.hp < m.maxHp) m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.01 * dt);

  let target = m.targetId != null ? players.get(m.targetId) : null;
  if (target && (!target.alive || dist(m.x, m.y, target.x, target.y) > 560 || dist(target.x, target.y, m.homeX, m.homeY) > 700)) {
    target = null; m.targetId = null; m.state = 'wander';
  }
  if (!target) {
    let bd = t.aggro;
    for (const p of players.values()) {
      if (!p.alive) continue;
      const d = dist(m.x, m.y, p.x, p.y);
      if (d < bd) { bd = d; target = p; }
    }
    if (target) { m.targetId = target.id; m.state = 'chase'; }
  }

  if (m.state === 'chase' && target) {
    const d = dist(m.x, m.y, target.x, target.y);
    if (d <= t.atkRange) {
      if (m.atkCd <= 0) {
        m.atkCd = t.atkCd;
        damagePlayer(target, t.dmg * (0.85 + rng() * 0.3), m);
      }
    } else {
      const sp = t.speed * dt;
      m.x += (target.x - m.x) / d * sp;
      m.y += (target.y - m.y) / d * sp;
    }
  } else {
    if (serverTime >= m.wanderAt) {
      m.wanderAt = serverTime + 2000 + rng() * 3000;
      const a = rng() * Math.PI * 2, r = rng() * 180;
      m.tx = clamp(m.homeX + Math.cos(a) * r, 40, WORLD.w - 40);
      m.ty = clamp(m.homeY + Math.sin(a) * r, 40, WORLD.h - 40);
    }
    const d = dist(m.x, m.y, m.tx, m.ty);
    if (d > 6) {
      const sp = t.speed * 0.45 * dt;
      m.x += (m.tx - m.x) / d * sp;
      m.y += (m.ty - m.y) / d * sp;
    }
  }
  collide(m, t.r);
}

function step(dt) {
  for (const p of players.values()) {
    if (!p.alive) continue;
    p.atkCd -= dt;
    const i = p.input;
    let dx = (i.r ? 1 : 0) - (i.l ? 1 : 0);
    let dy = (i.d ? 1 : 0) - (i.u ? 1 : 0);
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      dx /= len; dy /= len;
      p.fx = dx; p.fy = dy;
      const sp = playerSpeed(p.level) * dt;
      p.x += dx * sp;
      p.y += dy * sp;
    }
    collide(p, 14);
    p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.02 * dt);
  }
  for (const m of mobs.values()) stepMob(m, dt);
  for (const l of [...loot.values()]) {
    if (serverTime > l.despawnAt) { loot.delete(l.id); continue; }
    for (const p of players.values()) {
      if (!p.alive) continue;
      if (dist(p.x, p.y, l.x, l.y) < 36) {
        if (applyLoot(p, l)) loot.delete(l.id);
        break;
      }
    }
  }
}

function snapshot() {
  const pl = [];
  for (const p of players.values()) {
    pl.push({
      id: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y),
      hp: Math.round(p.hp), maxHp: p.maxHp, level: p.level, xp: Math.round(p.xp),
      xn: xpNext(p.level), c: p.color, a: p.alive, fx: +p.fx.toFixed(2), fy: +p.fy.toFixed(2),
      g: p.gold, atk: Math.round(p.atk), ew: !!p.equip.weapon,
    });
  }
  const mb = [];
  for (const m of mobs.values()) {
    if (m.respawnAt && serverTime < m.respawnAt) continue;
    mb.push({ id: m.id, ty: m.type, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: m.maxHp });
  }
  const lt = [];
  for (const l of loot.values()) {
    lt.push({ id: l.id, x: Math.round(l.x), y: Math.round(l.y), c: l.kind === 'gold' ? 'gold' : l.item.kind, r: l.item ? l.item.rar : 0 });
  }
  return { t: 'st', s: Math.round(serverTime), pl, mb, lt };
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  let dt = (now - lastTick) / 1000;
  lastTick = now;
  if (dt > 0.25) dt = 0.25;
  serverTime += dt * 1000;
  step(dt);
  tickCount++;
  if (tickCount % SNAP_EVERY === 0) broadcast(snapshot());
}, TICK_MS);

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function encodeFrame(data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function handleMessage(client, text) {
  if (text.length > 4096) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg.t !== 'string') return;
  const p = players.get(client.id);

  if (msg.t === 'join') {
    if (p) return;
    const np = addPlayer(client, msg.name);
    send(client, { t: 'welcome', id: np.id, world: WORLD, spawn: SPAWN, shop: SHOP, obstacles });
    sendInv(np);
    sysChat(`${np.name} entered Embervale`);
    return;
  }
  if (!p) return;

  switch (msg.t) {
    case 'input':
      p.input = { u: !!msg.u, d: !!msg.d, l: !!msg.l, r: !!msg.r };
      break;
    case 'attack':
      playerAttack(p);
      break;
    case 'chat': {
      const now = Date.now();
      if (now - p.lastChat < 250) return;
      p.lastChat = now;
      const m = String(msg.m || '').slice(0, 140).trim();
      if (m) broadcast({ t: 'chat', n: p.name, m, c: p.color });
      break;
    }
    case 'equip': {
      const idx = p.inv.findIndex((i) => i.uid === msg.uid && (i.kind === 'weapon' || i.kind === 'armor'));
      if (idx < 0) break;
      const it = p.inv.splice(idx, 1)[0];
      if (p.equip[it.kind]) p.inv.push(p.equip[it.kind]);
      p.equip[it.kind] = it;
      recomputeStats(p);
      sendInv(p);
      send(client, { t: 'ev', k: 'equip', name: it.name });
      break;
    }
    case 'use': {
      const idx = p.inv.findIndex((i) => i.uid === msg.uid && i.kind === 'potion');
      if (idx < 0 || !p.alive) break;
      p.inv.splice(idx, 1);
      const heal = Math.round(p.maxHp * 0.5);
      p.hp = Math.min(p.maxHp, p.hp + heal);
      send(client, { t: 'ev', k: 'heal', n: heal });
      sendInv(p);
      break;
    }
    case 'buy': {
      if (dist(p.x, p.y, SHOP.x, SHOP.y) > 130) { send(client, { t: 'ev', k: 'err', m: 'Too far from the shop' }); break; }
      if (p.gold < POTION_PRICE) { send(client, { t: 'ev', k: 'err', m: 'Not enough gold' }); break; }
      if (p.inv.length >= INV_MAX) { send(client, { t: 'ev', k: 'err', m: 'Inventory full' }); break; }
      p.gold -= POTION_PRICE;
      p.inv.push(makeItem({ kind: 'potion', name: 'Health Potion' }));
      send(client, { t: 'ev', k: 'buy', price: POTION_PRICE });
      sendInv(p);
      break;
    }
    case 'tp':
      if (TEST_HOOKS) {
        p.x = clamp(Number(msg.x) || 0, 0, WORLD.w);
        p.y = clamp(Number(msg.y) || 0, 0, WORLD.h);
      }
      break;
    case 'give':
      if (TEST_HOOKS) {
        if (Number(msg.gold) > 0) { p.gold += Math.min(1e6, Math.floor(msg.gold)); }
        if (msg.item) {
          const it = saneItem(msg.item);
          if (it && p.inv.length < INV_MAX) {
            it.uid = nextItemId++;
            p.inv.push(it);
            sendInv(p);
          }
        }
      }
      break;
    case 'setlevel':
      if (TEST_HOOKS) {
        p.level = clamp(Math.floor(Number(msg.n)) || 1, 1, 60);
        p.xp = 0;
        recomputeStats(p);
        p.hp = p.maxHp;
        send(client, { t: 'ev', k: 'level', level: p.level, maxHp: p.maxHp });
      }
      break;
    case 'sethp':
      if (TEST_HOOKS) p.hp = clamp(Number(msg.hp) || 0, 0, p.maxHp);
      break;
    case 'save':
      if (TEST_HOOKS) saveDB();
      break;
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const client = { id: nextId++, socket, ready: true, playerId: null, buf: Buffer.alloc(0), frags: [] };
  clients.set(client.id, client);

  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    let buf = client.buf;
    while (true) {
      if (buf.length < 2) break;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) break;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) break;
        len = Number(buf.readBigUInt64BE(off)); off += 8;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) break;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
        payload = un;
      }
      buf = buf.subarray(off + len);
      client.buf = buf;

      if (opcode === 0x8) {
        try { socket.write(Buffer.from([0x88, 0x00])); socket.end(); } catch {}
        cleanup();
        return;
      } else if (opcode === 0x9) {
        const pong = Buffer.concat([Buffer.from([0x8A, payload.length]), payload]);
        socket.write(pong);
      } else if (opcode === 0x1 || opcode === 0x0) {
        client.frags.push(payload);
        if (fin) {
          const full = Buffer.concat(client.frags);
          client.frags = [];
          if (full.length <= 4096) handleMessage(client, full.toString('utf8'));
        }
      }
    }
  });

  function cleanup() {
    if (!clients.has(client.id)) return;
    clients.delete(client.id);
    const p = players.get(client.id);
    removePlayer(client);
    if (p) sysChat(`${p.name} left Embervale`);
  }
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.listen(PORT, HOST, () => {
  console.log(`Embervale Online running at http://${HOST}:${PORT}  (Ctrl+C to stop)`);
  sysChat('Embermaw stalks the wilds of Embervale...');
});
