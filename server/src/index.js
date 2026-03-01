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

const WORLD = Object.freeze({ W: 1280, H: 720, PAD_X: 48, PAD_Y: 88 });
const MAX_HP = 100;

const MAX_MANA = 100;
const MANA_REGEN_PER_SEC = 6;         // slower: mana matters
const MANA_TICK_MS = 100;
const MANA_REGEN_DELAY_MS = 450;      // after casting, regen pauses briefly

// Pose broadcasting so the other browser can see movement.
// (Room state is NOT broadcast every frame; we send lightweight pose events.)
const POSE_BROADCAST_MS = 50;         // ~20 fps

const PROJ_TICK_MS = 50;             // server projectile sim (~20 fps)
const TARGET_RADIUS = 22;            // hit radius for wizard body

function nowMs() { return Date.now(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function makeRoomCode() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

function cryptoRandomToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function normalizeDir(d) {
  const x = Number(d?.x ?? 1), y = Number(d?.y ?? 0);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function angleBetween(ax, ay, bx, by) {
  const dot = ax * bx + ay * by;
  const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
  const v = clamp(dot / (la * lb), -1, 1);
  return Math.acos(v);
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
    roomCode: room.roomCode,
    phase: room.phase,
    phaseEndTime: room.phaseEndTime,
    players: [...room.players.values()].map(p => ({
      id: p.id, token: p.token,
      slot: p.slot,
      name: p.name,
      ready: p.ready,
      x: p.x, y: p.y,
      hp: p.hp,
      mana: p.mana,
      stunnedUntil: p.stunnedUntil ?? 0,
      shieldUntil: p.shieldUntil ?? 0,
      blockUntil: p.blockUntil ?? 0,
      facingLeft: (typeof p.facingLeft === 'boolean') ? p.facingLeft : false,
    })),
  };
}

function broadcastRoom(io, room) { io.to(room.roomCode).emit("room:state", emptyRoomState(room)); }

function clearTimers(room) {
  if (room.timers.phase) { clearTimeout(room.timers.phase); room.timers.phase = null;   if (room.timers.proj) { clearInterval(room.timers.proj); room.timers.proj = null; }
}
  if (room.timers.mana) { clearInterval(room.timers.mana); room.timers.mana = null;   if (room.timers.proj) { clearInterval(room.timers.proj); room.timers.proj = null; }
}
  if (room.timers.proj) { clearInterval(room.timers.proj); room.timers.proj = null; }
}

function setPhase(io, room, phase, durationMs = null) {
  room.phase = phase;
  const serverTime = nowMs();
  room.phaseEndTime = durationMs ? (serverTime + durationMs) : null;
  io.to(room.roomCode).emit("phase:start", { phase, durationMs, serverTime });
  broadcastRoom(io, room);
}

function broadcastMatchEnd(io, room, winnerId) {
  setPhase(io, room, PHASE.END, null);
  io.to(room.roomCode).emit("match:end", { winnerId });
}

function resetForRematch(room) {
  room.projectiles?.clear?.();
  for (const p of room.players.values()) {
    p.hp = MAX_HP;
    p.mana = MAX_MANA;
    p.ready = true;
    p.lastCastAt = {};
    p.manaRegenResumeAt = nowMs();
    p.shieldUntil = 0; p.shieldBlocks = 0;
    p.blockUntil = 0; p.blockBlocks = 0;
    p.stunnedUntil = 0;
    // spawn by slot
    p.x = p.slot === 0 ? 260 : (WORLD.W - 260);
    // Slightly higher so players don't start hidden behind the HUD.
    p.y = 480;

    p.facingLeft = p.slot === 1;
    p.lastPoseBroadcastAt = 0;
  }
}

function createRoom(hostSocket, name) {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  const room = { roomCode: code, phase: PHASE.LOBBY, phaseEndTime: null, players: new Map(), projectiles: new Map(), timers: { phase: null, mana: null, proj: null } };
  rooms.set(code, room);
  joinRoom(room, hostSocket, name);
  return room;
}

function joinRoom(room, socket, name) {
  if (room.players.size >= 2) throw new Error("Room is full (max 2 players).");
  // Pick the first free slot (prevents "both blue" when someone disconnects and a new player joins)
  const used = new Set([...room.players.values()].map(p => p.slot));
  const slot = used.has(0) ? 1 : 0;
  const spawnX = slot === 0 ? 260 : (WORLD.W - 260);
  room.players.set(socket.id, {
    id: socket.id,
    token: cryptoRandomToken(),
    slot,
    name: (name && String(name).trim()) ? String(name).trim().slice(0, 16) : "Wizard",
    ready: false,
    // Slightly higher so players don't start hidden behind the HUD.
    x: spawnX, y: 480,
    hp: MAX_HP,
    mana: MAX_MANA,
    manaRegenResumeAt: nowMs(),
    lastCastAt: {},
    shieldUntil: 0, shieldBlocks: 0,
    blockUntil: 0, blockBlocks: 0,
    stunnedUntil: 0,
    facingLeft: slot === 1,

    lastPoseBroadcastAt: 0,
  });
  socket.join(room.roomCode);
}

function startManaRegen(io, room) {
  if (room.timers.mana) clearInterval(room.timers.mana);
  room.timers.mana = setInterval(() => {
    if (![PHASE.PREROUND, PHASE.ROUND].includes(room.phase)) return;
    const t = nowMs();
    for (const p of room.players.values()) {
      if (t < (p.manaRegenResumeAt ?? 0)) continue;
      const before = p.mana;
      p.mana = Math.min(MAX_MANA, p.mana + (MANA_REGEN_PER_SEC * (MANA_TICK_MS / 1000)));
      if (Math.abs(p.mana - before) >= 0.5) {
        io.to(p.id).emit("mana:update", { mana: p.mana, maxMana: MAX_MANA, serverTime: t });
      }
    }
  }, MANA_TICK_MS);
}

function maybeStartMatch(io, room) {
  if (room.phase !== PHASE.LOBBY || room.players.size !== 2) return;
  if (![...room.players.values()].every(p => p.ready)) return;

  clearTimers(room);
  setPhase(io, room, PHASE.PREROUND, 8000);
  room.timers.phase = setTimeout(() => {
    setPhase(io, room, PHASE.ROUND, null);
    startManaRegen(io, room);
    startProjectileLoop(io, room);
  }, 8000);
}

function canCast(player, spellId) {
  const spell = SPELLS[spellId];
  if (!spell) return { ok: false, reason: "Unknown spell" };

  const cdMs = Math.max(0, Number(spell.cooldown ?? 0)) * 1000;
  const last = player.lastCastAt?.[spellId] ?? 0;
  const t = nowMs();
  if (t - last < cdMs) return { ok: false, reason: "Cooldown" };

  const cost = Number(spell.manaCost ?? 0);
  if (player.mana < cost) return { ok: false, reason: "No mana" };

  player.mana -= cost;
  player.lastCastAt[spellId] = t;
  player.manaRegenResumeAt = t + MANA_REGEN_DELAY_MS;

  return { ok: true, spell };
}

function geomCheck(caster, target, aimDir, spell) {
  const dx = target.x - caster.x, dy = target.y - caster.y;
  const dist = Math.hypot(dx, dy);
  const range = Number(spell?.behavior?.range ?? 560);
  if (dist > range) return { ok: false, dist };

  const coneDeg = Number(spell?.behavior?.coneDeg ?? 22);
  const toTarget = { x: dx / (dist || 1), y: dy / (dist || 1) };
  const ang = angleBetween(aimDir.x, aimDir.y, toTarget.x, toTarget.y);
  if (ang > (coneDeg * Math.PI / 180)) return { ok: false, dist };

  return { ok: true, dist };
}

function tryConsumeDefense(target) {
  const t = nowMs();
  if ((target.shieldBlocks ?? 0) > 0 && (target.shieldUntil ?? 0) > t) {
    target.shieldBlocks -= 1;
    if (target.shieldBlocks <= 0) target.shieldUntil = 0;
    return { blocked: true, by: "shield" };
  }
  if ((target.blockBlocks ?? 0) > 0 && (target.blockUntil ?? 0) > t) {
    target.blockBlocks -= 1;
    if (target.blockBlocks <= 0) target.blockUntil = 0;
    return { blocked: true, by: "block" };
  }
  return { blocked: false, by: null };
}

function applyHit(io, room, caster, target, spellId, dmg, projId = null, atX = null, atY = null) {
  const def = tryConsumeDefense(target);
  const t = nowMs();
  if (def.blocked) {
    io.to(room.roomCode).emit("hit:event", {
      casterId: caster.id,
      targetId: target.id,
      spellId,
      damage: 0,
      targetHp: target.hp,
      blocked: true,
      blockedBy: def.by,
      atX: (atX ?? target.x),
      atY: (atY ?? target.y),
      projId,
      serverTime: t,
    });
    return;
  }

  const amount = Math.max(0, Number(dmg ?? 0));
  target.hp = Math.max(0, target.hp - amount);

  io.to(room.roomCode).emit("hit:event", {
    casterId: caster.id,
    targetId: target.id,
    spellId,
    damage: amount,
    targetHp: target.hp,
    atX: (atX ?? target.x),
    atY: (atY ?? target.y),
    projId,
    serverTime: t,
  });

  if (target.hp <= 0) broadcastMatchEnd(io, room, caster.id);
}

function scheduleMultiHits(io, room, caster, target, spellId, hits, intervalMs, dmg) {
  const total = Math.max(1, Number(hits ?? 1));
  const step = Math.max(60, Number(intervalMs ?? 120));
  for (let i = 0; i < total; i++) {
    setTimeout(() => {
      const r = getRoom(room.roomCode);
      if (!r || r.phase !== PHASE.ROUND) return;
      const c = r.players.get(caster.id);
      const tg = r.players.get(target.id);
      if (!c || !tg) return;
      applyHit(io, r, c, tg, spellId, dmg);
      broadcastRoom(io, r);
    }, i * step);
  }
}

function spawnProjectile(io, room, caster, spellId, spell, dir, store = true) {
  const beh = spell?.behavior || {};
  const speed = Number(beh.speed ?? 520);
  const lifetimeMs = Number(beh.lifetimeMs ?? 800);
  const radius = Number(beh.radius ?? 10);

  const vx = dir.x * speed;
  const vy = dir.y * speed;

  const projId = cryptoRandomToken().slice(0, 10);
  const t = nowMs();
  const p = {
    id: projId,
    ownerId: caster.id,
    spellId,
    x: caster.x,
    y: caster.y,
    vx,
    vy,
    radius,
    damage: Number(spell.damage ?? 0),
    createdAt: t,
    expiresAt: t + lifetimeMs,
  };
  room.projectiles.set(projId, p);

  io.to(room.roomCode).emit("proj:spawn", {
    projId,
    ownerId: caster.id,
    spellId,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    radius: p.radius,
    lifetimeMs,
    serverTime: t,
  });
  return p;
}

function stepProjectiles(io, room, dtMs) {
  if (room.phase !== PHASE.ROUND) return;
  const t = nowMs();
  const dt = dtMs / 1000;

  for (const [projId, p] of room.projectiles.entries()) {
    if (t >= p.expiresAt) {
      room.projectiles.delete(projId);
      continue;
    }

    // Integrate
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // World bounds
    if (p.x < -60 || p.x > WORLD.W + 60 || p.y < -60 || p.y > WORLD.H + 60) {
      room.projectiles.delete(projId);
      continue;
    }

    // Check hits vs other players
    for (const target of room.players.values()) {
      if (target.id === p.ownerId) continue;

      const dx = (target.x - p.x);
      const dy = (target.y - p.y);
      const dist = Math.hypot(dx, dy);

      if (dist <= (p.radius + TARGET_RADIUS)) {
        const caster = room.players.get(p.ownerId);
        if (caster) {
          applyHit(io, room, caster, target, p.spellId, p.damage, projId, p.x, p.y);
        }
        io.to(room.roomCode).emit("proj:hit", { projId, targetId: target.id, atX: p.x, atY: p.y, serverTime: t });
        room.projectiles.delete(projId);
        break;
      }
    }
  }
}

function startProjectileLoop(io, room) {
  if (room.timers.proj) clearInterval(room.timers.proj);
  room.timers.proj = setInterval(() => {
    if (room.phase !== PHASE.ROUND) return;
    stepProjectiles(io, room, PROJ_TICK_MS);
  }, PROJ_TICK_MS);
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  socket.on("room:create", ({ name } = {}) => {
    try {
      const room = createRoom(socket, name);
      const p = room.players.get(socket.id);
      socket.emit("room:joined", { roomCode: room.roomCode, playerId: socket.id, reconnectToken: p?.token });
      // initial mana
      io.to(socket.id).emit("mana:update", { mana: p?.mana ?? MAX_MANA, maxMana: MAX_MANA, serverTime: nowMs() });
      broadcastRoom(io, room);
    } catch (e) {
      socket.emit("room:error", { reason: String(e.message || e) });
    }
  });

  socket.on("room:join", ({ roomCode, name } = {}) => {
    try {
      const code = String(roomCode || "").trim().toUpperCase();
      const room = getRoom(code);
      if (!room) throw new Error("Room not found.");
      joinRoom(room, socket, name);
      const p = room.players.get(socket.id);
      socket.emit("room:joined", { roomCode: room.roomCode, playerId: socket.id, reconnectToken: p?.token });
      io.to(socket.id).emit("mana:update", { mana: p?.mana ?? MAX_MANA, maxMana: MAX_MANA, serverTime: nowMs() });
      broadcastRoom(io, room);
    } catch (e) {
      socket.emit("room:error", { reason: String(e.message || e) });
    }
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
      io.to(socket.id).emit("mana:update", { mana: existing.mana, maxMana: MAX_MANA, serverTime: nowMs() });
      broadcastRoom(io, room);
    } catch (e) {
      socket.emit("room:error", { reason: String(e.message || e) });
    }
  });

  
  socket.on("room:sync", () => {
    const roomCode = [...socket.rooms].find(r => r !== socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;
    socket.emit("room:state", emptyRoomState(room));
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

  socket.on("player:pose", ({ x, y, facingLeft } = {}) => {
    const roomCode = [...socket.rooms].find(r => r !== socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || room.phase === PHASE.END) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const t = nowMs();
    if ((player.stunnedUntil ?? 0) > t) return;

    player.x = clamp(Number(x ?? player.x), WORLD.PAD_X, WORLD.W - WORLD.PAD_X);
    player.y = clamp(Number(y ?? player.y), WORLD.PAD_Y, WORLD.H - WORLD.PAD_Y);

    if (typeof facingLeft === 'boolean') player.facingLeft = facingLeft;

    // Lightweight pose sync so the other browser sees you move.
    if (t - (player.lastPoseBroadcastAt ?? 0) >= POSE_BROADCAST_MS) {
      player.lastPoseBroadcastAt = t;
      socket.to(room.roomCode).emit("player:pose", { id: player.id, x: player.x, y: player.y, facingLeft: player.facingLeft ?? null, serverTime: t });
    }
  });

  socket.on("spell:cast", ({ spellId, aimDir } = {}) => {
    const roomCode = [...socket.rooms].find(r => r !== socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || ![PHASE.PREROUND, PHASE.ROUND].includes(room.phase)) return;

    const caster = room.players.get(socket.id);
    if (!caster) return;

    const sid = String(spellId || "").trim().toLowerCase();
    const { ok, spell, reason } = canCast(caster, sid);
    if (!ok) {
      io.to(socket.id).emit("cast:fail", { spellId: sid, reason, serverTime: nowMs() });
      return;
    }

    // mana update to caster
    io.to(socket.id).emit("mana:update", { mana: caster.mana, maxMana: MAX_MANA, serverTime: nowMs() });

    const seed = Math.floor(Math.random() * 2 ** 31);
    const dir = normalizeDir(aimDir);
    const kind = String(spell.kind || "projectile");

    io.to(room.roomCode).emit("spell:event", {
      casterId: caster.id,
      spellId: sid,
      kind,
      aimDir: dir,
      seed,
      delayMs: Number(spell.delayMs ?? 0) || 0,
      serverTime: nowMs(),
    });

    // During PREROUND, we still allow showing VFX but no damage
    if (room.phase !== PHASE.ROUND) { broadcastRoom(io, room); return; }

    const target = [...room.players.values()].find(p => p.id !== caster.id);
if (!target) { broadcastRoom(io, room); return; }

// Projectiles are NOT hitscan: spawn server-simulated projectiles and only apply damage on collision.
if (kind === "projectile") {
  if (room.phase !== PHASE.ROUND) { broadcastRoom(io, room); return; }

  const shots = Math.max(1, Number(spell.hits ?? 1));
  const shotGap = Math.max(80, Number(spell.tickIntervalMs ?? 120));
  const delay = Math.max(0, Number(spell.delayMs ?? 0));

  for (let i = 0; i < shots; i++) {
    setTimeout(() => {
      const r = getRoom(room.roomCode);
      if (!r || r.phase !== PHASE.ROUND) return;
      const c = r.players.get(caster.id);
      if (!c) return;
      spawnProjectile(io, r, c, sid, spell, dir);
    }, delay + i * shotGap);
  }

  broadcastRoom(io, room);
  return;
}

const check = geomCheck(caster, target, dir, spell);
if (!check.ok) { broadcastRoom(io, room); return; }

const doEffect = () => {
      const r = getRoom(room.roomCode);
      if (!r || r.phase !== PHASE.ROUND) return;
      const c = r.players.get(caster.id);
      const tg = r.players.get(target.id);
      if (!c || !tg) return;

      if (kind === "shield") {
        c.shieldUntil = nowMs() + Number(spell.durationMs ?? 3000);
        c.shieldBlocks = Math.max(1, Number(spell.blocks ?? 1));
        broadcastRoom(io, r);
        return;
      }

      if (kind === "block") {
        c.blockUntil = nowMs() + Number(spell.blockMs ?? 2500);
        c.blockBlocks = Math.max(1, Number(spell.blocks ?? 1));
        broadcastRoom(io, r);
        return;
      }

      if (kind === "heal") {
        const heal = Math.max(0, Number(spell.heal ?? 0));
        const before = c.hp;
        c.hp = Math.min(MAX_HP, c.hp + heal);
        io.to(r.roomCode).emit("heal:event", {
          casterId: c.id, spellId: sid, heal, casterHp: c.hp,
          atX: c.x, atY: c.y, serverTime: nowMs(),
        });
        broadcastRoom(io, r);
        return;
      }

      // projectile / status:
      const hits = Number(spell.hits ?? spell.ticks ?? 1);
      const interval = Number(spell.tickIntervalMs ?? 120);

      if (kind === "status") {
        // apply stun once
        const stun = Number(spell.stunMs ?? 0);
        if (stun > 0) {
          tg.stunnedUntil = Math.max(tg.stunnedUntil ?? 0, nowMs() + stun);
          io.to(r.roomCode).emit("status:event", { casterId: c.id, targetId: tg.id, spellId: sid, stunMs: stun, serverTime: nowMs() });
        }
        scheduleMultiHits(io, r, c, tg, sid, hits, interval, Number(spell.damage ?? 0));
        return;
      }

      // kind === projectile with multi-hits (cross_winds etc)
      if (hits > 1 && interval > 0) {
        scheduleMultiHits(io, r, c, tg, sid, hits, interval, Number(spell.damage ?? 0));
      } else {
        applyHit(io, r, c, tg, sid, Number(spell.damage ?? 0));
        broadcastRoom(io, r);
      }
    };

    const delay = Math.max(0, Number(spell.delayMs ?? 0));
    if (delay > 0) setTimeout(doEffect, delay);
    else doEffect();

    broadcastRoom(io, room);
  });

  socket.on("room:rematch", () => {
    const roomCode = [...socket.rooms].find(r => r !== socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || room.phase !== PHASE.END) return;

    resetForRematch(room);
    clearTimers(room);

    setPhase(io, room, PHASE.PREROUND, 8000);
    room.timers.phase = setTimeout(() => {
      setPhase(io, room, PHASE.ROUND, null);
      startManaRegen(io, room);
    startProjectileLoop(io, room);
    }, 8000);

    broadcastRoom(io, room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);

        // reset the room back to lobby when someone leaves
        clearTimers(room);
        room.phase = PHASE.LOBBY;
        room.phaseEndTime = null;
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
