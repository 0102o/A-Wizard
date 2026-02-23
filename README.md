# Voice‑Cast Pixel Wizard Duel (LAN 1v1) — Starter

This is a **phase‑driven** starter you can build on:
- Room create/join (2 players)
- Ready → **PREROUND** countdown → **ROUND**
- PREROUND: casting allowed, movement ignored
- ROUND: movement + casting
- Voice phrase → spellId (Web Speech API) + keyboard fallback

## Run (dev)
### 1) Server
```bash
cd server
npm i
npm run dev
```
Server runs on **0.0.0.0:3001**

### 2) Client (host this on the same machine for LAN)
```bash
cd client
npm i
npm run dev
```
Client runs on **0.0.0.0:5173**

### 3) Join from another machine (same Wi‑Fi)
Open:
- http://<HOST_IP>:5173
Then connect to server:
- http://<HOST_IP>:3001 (auto default)

## Notes
- Use **Chrome** for voice (Firefox may not support Web Speech API).
- Data files:
  - client/public/data/spells.json
  - client/public/data/keywords.json
  - server/data/spells.json

## Refresh / Reconnect
- After you join a room, the client stores a reconnect token in localStorage.
- Refreshing the page will auto-reconnect to the same room (if the server is still running).

## Match End / Rematch
- Server applies damage on cast (P0 cone+range hit check).
- When HP hits 0, server switches to END and sends match:end.
- Press N or click Rematch to start again.

## Phrase v2 (Fuzzy Matching)
- Voice phrases are matched using Levenshtein similarity.
- Auto-cast triggers when best score >= 0.78; otherwise suggestions are shown.
