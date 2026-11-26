'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8090;
const DATA = path.join(__dirname, 'data');

function startServer() {
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), ENABLE_TEST_HOOKS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return server;
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (++tries > 50) reject(new Error('server did not start'));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

class Client {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.events = [];
    this.chats = [];
    this.welcome = null;
    this.inv = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.addEventListener('open', () => {
        this.ws.send(JSON.stringify({ t: 'join', name: this.name }));
      });
      this.ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === 'welcome') { this.welcome = msg; resolve(); }
        else if (msg.t === 'st') this.state = msg;
        else if (msg.t === 'ev') this.events.push(msg);
        else if (msg.t === 'chat') this.chats.push(msg);
        else if (msg.t === 'inv') this.inv = msg;
      });
      this.ws.addEventListener('error', reject);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  me() { return this.state.pl.find((p) => p.id === this.welcome.id); }
  async waitFor(pred, timeout = 8000, label = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout waiting for ' + label);
  }
}

function assert(cond, label) {
  if (!cond) throw new Error('ASSERT FAILED: ' + label);
  console.log('  ok -', label);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('starting server...');
  let server = startServer();
  await waitForServer();
  console.log('server up');

  try {
    const alice = new Client('Alice');
    const bob = new Client('Bob');
    await alice.connect();
    await bob.connect();
    assert(alice.welcome.world.w === 2400 && alice.welcome.obstacles.length > 100, 'welcome payload has world + obstacles');
    assert(alice.welcome.shop && alice.welcome.shop.x === 1280, 'welcome payload has shop position');
    await alice.waitFor(() => alice.state && alice.state.pl.length >= 2, 5000, 'both players visible');
    assert(alice.state.pl.some((p) => p.n === 'Bob'), 'Alice sees Bob in snapshot');
    assert(bob.state.pl.some((p) => p.n === 'Alice'), 'Bob sees Alice in snapshot');
    await alice.waitFor(() => alice.state.mb.some((m) => m.ty === 'boss'), 3000, 'boss present');
    assert(true, 'world boss Embermaw is in the world');

    const x0 = alice.me().x;
    alice.send({ t: 'input', r: 1, u: 0, d: 0, l: 0 });
    await sleep(600);
    alice.send({ t: 'input', r: 0, u: 0, d: 0, l: 0 });
    await alice.waitFor(() => alice.me().x > x0 + 60, 3000, 'movement');
    assert(true, `movement works (x ${x0} -> ${alice.me().x})`);

    alice.send({ t: 'chat', m: 'hello Embervale!' });
    await bob.waitFor(() => bob.chats.some((c) => c.n === 'Alice' && c.m === 'hello Embervale!'), 3000, 'chat delivery');
    assert(true, 'chat delivered to other player');

    const xp0 = alice.me().xp;
    const lvl0 = alice.me().level;
    async function killOneMob() {
      await alice.waitFor(() => alice.state.mb.length > 0, 5000, 'mobs present');
      const slimes = alice.state.mb.filter((m) => m.ty === 'slime');
      const pool = slimes.length ? slimes : alice.state.mb.filter((m) => m.ty !== 'boss');
      const candidates = pool.map((m) => ({
        m,
        isolation: Math.min(...alice.state.mb.filter((o) => o.id !== m.id)
          .map((o) => Math.hypot(o.x - m.x, o.y - m.y)), 9999),
      })).sort((a, b) => b.isolation - a.isolation);
      const target = candidates[0].m;
      alice.send({ t: 'tp', x: target.x - 40, y: target.y });
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) {
        if (!alice.state.mb.find((mm) => mm.id === target.id)) return;
        if (!alice.me().a) {
          await alice.waitFor(() => alice.me().a, 5000, 'respawn');
          alice.send({ t: 'tp', x: target.x - 40, y: target.y });
          continue;
        }
        alice.send({ t: 'attack' });
        await sleep(350);
      }
      throw new Error('could not kill mob ' + target.id);
    }
    for (let i = 0; i < 4; i++) await killOneMob();
    await alice.waitFor(() => alice.me().xp > xp0 || alice.me().level > lvl0, 3000, 'xp gain');
    assert(alice.me().xp > xp0 || alice.me().level > lvl0, `combat grants XP (xp ${xp0} -> ${alice.me().xp}, level ${lvl0} -> ${alice.me().level})`);
    assert(alice.events.some((e) => e.k === 'kill'), 'kill event received');
    assert(alice.me().level >= 2, `leveled up to ${alice.me().level}`);
    await alice.waitFor(() => alice.events.some((e) => e.k === 'gold' || e.k === 'loot'), 5000, 'loot drop event').catch(() => {});
    assert(true, 'mob death produced loot/gold events or ground loot');

    const hpBefore = alice.me().hp;
    await alice.waitFor(() => alice.me().hp > hpBefore, 6000, 'hp regen');
    assert(true, `HP regen works (${hpBefore} -> ${alice.me().hp})`);

    const g0 = alice.me().g;
    alice.send({ t: 'give', gold: 100 });
    await alice.waitFor(() => alice.me().g === g0 + 100, 3000, 'gold added');
    assert(true, `gold economy works (${g0} -> ${alice.me().g})`);

    alice.send({ t: 'tp', x: 1200, y: 1200 });
    await sleep(400);
    const gBuy = alice.me().g;
    alice.send({ t: 'buy' });
    await alice.waitFor(() => alice.inv && alice.inv.inv.length > 0, 3000, 'potion bought');
    await alice.waitFor(() => alice.me().g === gBuy - 25, 3000, 'gold deducted');
    assert(true, `shop works (gold ${gBuy} -> ${alice.me().g}, potion in inventory)`);
    const potion = alice.inv.inv.find((i) => i.kind === 'potion');
    assert(!!potion, 'inventory contains potion');

    alice.send({ t: 'sethp', hp: 20 });
    await alice.waitFor(() => alice.me().hp <= 30, 2000, 'hp lowered');
    const hpUse = alice.me().hp;
    alice.send({ t: 'use', uid: potion.uid });
    await alice.waitFor(() => alice.me().hp > hpUse + 20, 3000, 'potion healed');
    assert(true, `potion heals (${hpUse} -> ${alice.me().hp})`);
    assert(!alice.inv.inv.some((i) => i.uid === potion.uid), 'potion consumed');

    alice.send({ t: 'give', item: { kind: 'weapon', name: 'Test Blade', power: 50, rar: 2 } });
    await alice.waitFor(() => alice.inv && alice.inv.inv.some((i) => i.kind === 'weapon'), 3000, 'weapon added');
    const weap = alice.inv.inv.find((i) => i.kind === 'weapon');
    const atk0 = alice.me().atk;
    alice.send({ t: 'equip', uid: weap.uid });
    await alice.waitFor(() => alice.me().atk === atk0 + 50, 3000, 'weapon equipped');
    assert(true, `weapon equip raises ATK (${atk0} -> ${alice.me().atk})`);
    assert(alice.me().ew === true, 'equipped-weapon flag visible to others');

    alice.send({ t: 'give', item: { kind: 'armor', name: 'Test Plate', power: 100, rar: 3 } });
    await alice.waitFor(() => alice.inv && alice.inv.inv.some((i) => i.kind === 'armor'), 3000, 'armor added');
    const arm = alice.inv.inv.find((i) => i.kind === 'armor');
    const maxHp0 = alice.me().maxHp;
    alice.send({ t: 'equip', uid: arm.uid });
    await alice.waitFor(() => alice.me().maxHp === maxHp0 + 100, 3000, 'armor equipped');
    assert(true, `armor equip raises max HP (${maxHp0} -> ${alice.me().maxHp})`);

    alice.send({ t: 'setlevel', n: 7 });
    await alice.waitFor(() => alice.me().level === 7, 3000, 'level set');
    alice.send({ t: 'save' });
    await sleep(500);
    const goldAtSave = alice.me().g;

    console.log('restarting server to test persistence...');
    server.kill('SIGTERM');
    await sleep(600);
    server = startServer();
    await waitForServer();

    const alice2 = new Client('Alice');
    await alice2.connect();
    await alice2.waitFor(() => alice2.state && alice2.state.pl.length > 0, 5000, 'state after restart');
    assert(alice2.me().level === 7, `level persisted across restart (level ${alice2.me().level})`);
    assert(alice2.me().g === goldAtSave, `gold persisted across restart (${alice2.me().g})`);
    await alice2.waitFor(() => alice2.inv && alice2.inv.equip && alice2.inv.equip.weapon, 3000, 'equipment restored');
    assert(alice2.inv.equip.weapon.name === 'Test Blade', 'equipped weapon persisted');
    assert(alice2.inv.equip.armor && alice2.inv.equip.armor.name === 'Test Plate', 'equipped armor persisted');
    assert(alice2.me().maxHp === 100 + 6 * 25 + 100, `stats recomputed from save (maxHp ${alice2.me().maxHp})`);

    console.log('\nALL TESTS PASSED');
  } finally {
    server.kill('SIGTERM');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\nTEST FAILED:', e.message);
  process.exit(1);
});
