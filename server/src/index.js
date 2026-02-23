import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const PHASE = Object.freeze({ LOBBY: "LOBBY", PREROUND: "PREROUND", ROUND: "ROUND", END: "END" });
const MAX_MANA = 100;
const MANA_REGEN_PER_SEC = 12;

function nowMs() { return Date.now(); }
function cryptoRandomToken() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
function makeRoomCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = ""; for (let i = 0; i < 5; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function angleBetween(ax, ay, bx, by) {
  const dot = ax*bx + ay*by;
  const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
  return Math.acos(clamp(dot / (la * lb), -1, 1));
}

function normalizeDir(d) {
  const x = Number(d?.x ?? 1), y = Number(d?.y ?? 0);
  const len = Math.hypot(x, y) || 1;
  return { x: x/len, y: y/len };
}

function loadSpells() {
  const p = path.join(__dirname, "..", "data", "spells.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

const SPELLS = loadSpells();
const rooms = new Map();

function getRoom(code) { return rooms.get(code) ?? null; }

function emptyRoomState(room) {
  return {
    roomCode: room.roomCode, phase: room.phase, phaseEndTime: room.phaseEndTime,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, ready: p.ready, x: p.x, y: p.y, hp: p.hp,
    })),
  };
}

function broadcastRoom(io, room) { io.to(room.roomCode).emit("room:state", emptyRoomState(room)); }

function setPhase(io, room, phase, durationMs = null) {
  room.phase = phase;
  const serverTime = nowMs();
  room.phaseEndTime = durationMs ? (serverTime + durationMs) : null;
  io.to(room.roomCode).emit("phase:start", { phase, durationMs, serverTime });
  broadcastRoom(io, room);
}

function clearPhaseTimer(room) {
  if (room.timers.phase) { clearTimeout(room.timers.phase); room.timers.phase = null; }
}

function broadcastMatchEnd(io, room, winnerId) {
  setPhase(io, room, PHASE.END, null);
  io.to(room.roomCode).emit("match:end", { winnerId });
}

function resetForRematch(room) {
  const ids = [...room.players.keys()];
  for (let i = 0; i < ids.length; i++) {
    const p = room.players.get(ids[i]);
    if (!p) continue;
    p.hp = 100; p.mana = MAX_MANA; p.ready = true;
    p.x = i === 0 ? 160 : 480; p.y = 320;
    p.lastCastAt = {}; p.shieldUntil = 0;
  }
}

function createRoom(hostSocket, name) {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  const room = { roomCode: code, phase: PHASE.LOBBY, phaseEndTime: null, players: new Map(), timers: { phase: null, mana: null } };
  rooms.set(code, room);
  joinRoom(room, hostSocket, name);
  return room;
}

function joinRoom(room, socket, name) {
  if (room.players.size >= 2) throw new Error("Room is full (max 2 players).");
  const spawnX = room.players.size === 0 ? 160 : 480;
  room.players.set(socket.id, {
    id: socket.id, token: cryptoRandomToken(),
    name: (name && String(name).trim()) ? String(name).trim().slice(0, 16) : "Wizard",
    ready: false, x: spawnX, y: 320, hp: 100, mana: MAX_MANA,
    lastCastAt: {}, shieldUntil: 0,
  });
  socket.join(room.roomCode);
}

function maybeStartMatch(io, room) {
  if (room.phase !== PHASE.LOBBY || room.players.size !== 2) return;
  if (![...room.players.values()].every(p => p.ready)) return;
  clearPhaseTimer(room);
  setPhase(io, room, PHASE.PREROUND, 15000);
  room.timers.phase = setTimeout(() => {
    setPhase(io, room, PHASE.ROUND, null);
    // Start mana regen tick
    startManaRegen(io, room);
  }, 15000);
}

function startManaRegen(io, room) {
  if (room.timers.mana) clearInterval(room.timers.mana);
  room.timers.mana = setInterval(() => {
    if (room.phase !== PHASE.ROUND && room.phase !== PHASE.PREROUND) {
      clearInterval(room.timers.mana); room.timers.mana = null; return;
    }
    for (const p of room.players.values()) {
      p.mana = Math.min(MAX_MANA, p.mana + MANA_REGEN_PER_SEC * 0.1); // 100ms tick
    }
  }, 100);
}

function canCast(player, spellId) {
  const spell = SPELLS[spellId];
  if (!spell) return { ok: false, reason: "Unknown spell" };
  const cdMs = Math.max(0, Number(spell.cooldown ?? 0)) * 1000;
  const last = player.lastCastAt[spellId] ?? 0;
  const t = nowMs();
  if (t - last < cdMs) return { ok: false, reason: "Cooldown" };
  const cost = Number(spell.manaCost ?? 0);
  if (player.mana < cost) return { ok: false, reason: "No mana" };
  player.mana -= cost;
  player.lastCastAt[spellId] = t;
  return { ok: true, spell };
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  socket.on("room:create", ({ name } = {}) => {
    try {
      const room = createRoom(socket, name);
      socket.emit("room:joined", { roomCode: room.roomCode, playerId: socket.id, reconnectToken: room.players.get(socket.id)?.token });
      broadcastRoom(io, room);
    } catch (e) { socket.emit("room:error", { reason: String(e.message || e) }); }
  });

  socket.on("room:join", ({ roomCode, name } = {}) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const room = getRoom(code);
      if (!room) throw new Error("Room not found.");
      joinRoom(room, socket, name);
      socket.emit("room:joined", { roomCode: room.roomCode, playerId: socket.id, reconnectToken: room.players.get(socket.id)?.token });
      broadcastRoom(io, room);
    } catch (e) { socket.emit("room:error", { reason: String(e.message || e) }); }
  });

  socket.on("room:reconnect", ({ roomCode, reconnectToken, name } = {}) => {
    try {
      const room = getRoom(String(roomCode || "").trim().toUpperCase());
      if (!room) throw new Error("Room not found.");
      const existing = [...room.players.values()].find(p => p.token === String(reconnectToken || "").trim());
      if (!existing) throw new Error("Reconnect token invalid.");
      room.players.delete(existing.id);
      existing.id = socket.id;
      if (name && String(name).trim()) existing.name = String(name).trim().slice(0, 16);
      room.players.set(socket.id, existing);
      socket.join(room.roomCode);
      socket.emit("room:joined", { roomCode: room.roomCode, playerId: socket.id, reconnectToken: existing.token });
      broadcastRoom(io, room);
    } catch (e) { socket.emit("room:error", { reason: String(e.message || e) }); }
  });

  socket.on("player:ready", ({ ready } = {}) => {
    const roomCode = [...socket.rooms].find(r => r !== socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.ready = !!ready;
    broadcastRoom(io, room);
    maybeStartMatch(io, room);
  });

  socket.on("player:pose", ({ x, y } = {}) => {
    const roomCode = [...socket.rooms].find(r => r !== socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || room.phase !== PHASE.ROUND) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.x = clamp(Number(x ?? player.x), 40, 600);
    player.y = clamp(Number(y ?? player.y), 80, 360);
  });

  socket.on("spell:cast", ({ spellId, aimDir } = {}) => {
    const roomCode = [...socket.rooms].find(r => r !== socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || ![PHASE.PREROUND, PHASE.ROUND].includes(room.phase)) return;
    const caster = room.players.get(socket.id);
    if (!caster) return;

    const sid = String(spellId || "").trim().toLowerCase();
    const { ok, spell } = canCast(caster, sid);
    if (!ok) return;

    const seed = Math.floor(Math.random() * 2**31);
    const dir = normalizeDir(aimDir);

    // Shield spell — no projectile, just apply shield
    if (sid === "shieldra") {
      caster.shieldUntil = nowMs() + 3000;
      io.to(room.roomCode).emit("spell:event", { casterId: socket.id, spellId: sid, aimDir: dir, seed, serverTime: nowMs() });
      broadcastRoom(io, room);
      return;
    }

    io.to(room.roomCode).emit("spell:event", { casterId: socket.id, spellId: sid, aimDir: dir, seed, serverTime: nowMs() });

    // Hit detection
    if (room.players.size !== 2) return;
    const target = [...room.players.values()].find(p => p.id !== caster.id);
    if (!target) return;

    const dx = target.x - caster.x, dy = target.y - caster.y;
    const dist = Math.hypot(dx, dy);

    const ranges = { spark: 520, wagalona: 560, zephyra: 540, vortium: 600 };
    const cones = { spark: 22, wagalona: 18, zephyra: 28, vortium: 15 };
    const maxRange = Number(ranges[sid] ?? 520);
    if (dist > maxRange) return;

    const toTarget = { x: dx / (dist || 1), y: dy / (dist || 1) };
    const ang = angleBetween(dir.x, dir.y, toTarget.x, toTarget.y);
    if (ang > (Number(cones[sid] ?? 22) * Math.PI / 180)) return;

    // Shield check
    if (target.shieldUntil > nowMs()) {
      target.shieldUntil = 0; // Shield absorbs one hit
      io.to(room.roomCode).emit("hit:event", {
        casterId: caster.id, targetId: target.id, spellId: sid,
        damage: 0, targetHp: target.hp, serverTime: nowMs(), blocked: true,
      });
      broadcastRoom(io, room);
      return;
    }

    const dmg = Math.max(0, Number(spell?.damage ?? 0));
    target.hp = Math.max(0, target.hp - dmg);

    io.to(room.roomCode).emit("hit:event", {
      casterId: caster.id, targetId: target.id, spellId: sid,
      damage: dmg, targetHp: target.hp, serverTime: nowMs(),
    });
    broadcastRoom(io, room);

    if (target.hp <= 0) broadcastMatchEnd(io, room, caster.id);
  });

  socket.on("room:rematch", () => {
    const roomCode = [...socket.rooms].find(r => r !== socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || room.phase !== PHASE.END) return;
    resetForRematch(room);
    clearPhaseTimer(room);
    setPhase(io, room, PHASE.PREROUND, 8000);
    room.timers.phase = setTimeout(() => {
      setPhase(io, room, PHASE.ROUND, null);
      startManaRegen(io, room);
    }, 8000);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        clearPhaseTimer(room);
        if (room.timers.mana) { clearInterval(room.timers.mana); room.timers.mana = null; }
        room.phase = PHASE.LOBBY; room.phaseEndTime = null;
        for (const p of room.players.values()) p.ready = false;
        broadcastRoom(io, room);
        if (room.players.size === 0) rooms.delete(room.roomCode);
        break;
      }
    }
  });
});

app.get("/", (_req, res) => res.send("Wizard Duel server running."));
httpServer.listen(PORT, "0.0.0.0", () => console.log(`[server] http://0.0.0.0:${PORT}`));
