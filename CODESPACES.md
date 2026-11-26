# Testing Embervale Online in GitHub Codespaces (no local files needed)

1. On the repository page, click **Code → Codespaces → Create codespace on `vibe/embervale-90c179`** (or on `main`).
2. Wait for the Codespace to boot, then in its terminal run:

   ```sh
   node server.js
   ```

   (No `npm install` needed — the server has zero dependencies. Node 18+ is preinstalled.)

3. Open the **Ports** tab at the bottom of the VS Code window, find forwarded port **8080**, and click the globe icon (or right-click → Port Visibility → Public if you want to share it with friends) to open the game URL in a new browser tab.
4. Enter a hero name and click **ENTER WORLD**. Open a second browser tab to the same forwarded URL to see real-time multiplayer (two players, chat, shared world).
5. Controls: **WASD/arrows** move, **Space/click** AoE attack, **Enter** chat, **I** inventory, **E** buy potion at the town shop, **M** mute the generated music/SFX. Reach Lv 5 for wings.
6. Optional — run the automated end-to-end suite in the Codespace terminal:

   ```sh
   node test.js
   ```

   It drives two bot clients through joining, movement, chat, combat, leveling, loot, the shop, potions, equipment, and persistence across a server restart (25 checks).

Notes:
- The server binds `127.0.0.1:8080` by default, which Codespaces port forwarding reaches fine.
- Player progress auto-saves to `data/players.json` inside the Codespace (gitignored).
- To stop the server: `Ctrl+C` in the terminal. Codespaces stop billing when idle/closed; the save file persists in the Codespace while it exists.
