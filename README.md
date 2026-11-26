# Embervale Online — a fully working browser MMORPG

A real-time multiplayer RPG that runs in the browser. Zero npm dependencies:
the server is pure Node.js (the WebSocket protocol is implemented directly on
`http` + `crypto`), and the client is a single HTML5 canvas page.

## Run it

```sh
node server.js
# then open http://127.0.0.1:8080 in one or more browser tabs/machines
```

No install step needed. Requires Node.js >= 18.

Environment variables:

- `PORT` — port to listen on (default `8080`)
- `HOST` — interface to bind (default `127.0.0.1`; set `HOST=0.0.0.0` to play with
  friends on your LAN)

## How to play

- Enter a hero name and click **ENTER WORLD**
- **WASD / arrow keys** — move
- **Space or left-click** — AoE sword swing (hits every monster in range, with a shockwave ring)
- **Enter** — chat with other players, **Esc** — cancel
- **M** — mute/unmute the generated music + sound effects
- **I / B** — open inventory; click **Equip** on weapons/armor or **Use** on potions
- **E** — buy a Health Potion (25 gold) at the shop stall in town
- Reach **level 5** to grow golden wings
- Monsters (slimes, boars, wolves) wander, chase, and fight back. Kills drop
  **gold and loot** (weapons, armor, potions — common/rare/epic) that you pick up
  by walking over it. XP levels you up (+max HP, +damage); HP regenerates over time.
  Death respawns you at town with a small XP penalty.
- The world boss **Embermaw** (top-center HP bar) spawns in the wilds, respawns
  90 s after being slain, and drops epic loot (Dragonfang, Emberplate).
- Progress (level, XP, gold, inventory, equipment) **auto-saves** to
  `data/players.json` every 10 s and on shutdown — rejoin with the same name to
  continue where you left off.

## Test

```sh
node test.js
```

Spins up the server on port 8090 and drives two WebSocket clients through joining,
seeing each other, the boss being present, movement, chat, combat, XP/level-up,
loot/gold, shop purchase, potion use, weapon/armor equipping, HP regen, and
persistence across a full server restart.

## Architecture

- `server.js` — authoritative game server: static file hosting, RFC 6455 WebSocket
  handshake/framing, 30 Hz simulation (movement, collision, mob AI, combat, XP,
  loot, shop, boss, regen, respawns), 15 Hz JSON snapshots broadcast to all clients,
  and JSON-file persistence of player accounts.
- `public/index.html` — client: all art is generated in-engine at load (offscreen
  sprite atlas: chibi heroes with helmets/armor/swords, winged forms at Lv 5+,
  slime/boar/wolf/boss sprites, trees, rocks, shop stall, loot, textured ground),
  plus particle bursts, hit flashes, screen shake, AoE rings, dynamic lighting,
  damage floaters, HUD (HP/XP/level/ATK/gold), inventory panel, chat, boss bar,
  minimap, and a fully procedural WebAudio soundscape (generated music loop +
  synthesized SFX, M to mute). Zero image/audio files, zero dependencies.
- Protocol is JSON over WebSocket: client sends `join` / `input` / `attack` /
  `chat` / `equip` / `use` / `buy`; server sends `welcome` / `st` (snapshot) /
  `inv` (private inventory) / `chat` / `ev` (events).
