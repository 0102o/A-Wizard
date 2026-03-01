import Phaser from "phaser";
import { getSocket } from "../net/socket.js";
import { VoiceCaster } from "../voice/VoiceCaster.js";

const PHASE = Object.freeze({ LOBBY: "LOBBY", PREROUND: "PREROUND", ROUND: "ROUND", END: "END" });

const WORLD = Object.freeze({ W: 1280, H: 720, PAD_X: 48, PAD_Y: 88 });

const MAX_HP = 100;

function prng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBeep(ctx, freq, dur, vol = 0.15, type = "sine") {
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + dur);
  } catch {}
}

function elementKeyForSpell(spellId, spell) {
  const el = String(spell?.element || "").toLowerCase();
  const sid = String(spellId || "").toLowerCase();
  if (el.includes("fire") || sid.includes("sun") || sid.includes("flare") || sid.includes("magma") || sid.includes("wagalona")) return "fire";
  if (el.includes("water") || sid.includes("water")) return "water";
  if (el.includes("ice") || sid.includes("ice")) return "water"; // use water splash for now
  if (el.includes("wind") || sid.includes("wind") || sid.includes("zephyra") || sid.includes("spark")) return "wind";
  if (el.includes("rock") || sid.includes("rock") || sid.includes("stone") || sid.includes("pebble")) return "rock";
  if (el.includes("poison") || sid.includes("gas")) return "poison";
  if (el.includes("void") || sid.includes("vortium")) return "fire"; // placeholder
  return "fire";
}

export class GameScene extends Phaser.Scene {
  constructor() {
    super("Game");
    this.clockOffsetMs = 0;
    this.phase = PHASE.LOBBY;
    this.phaseEndTime = null;

    this.playerId = null;
    this.roomCode = null;

    this.playersById = new Map();
    this.keywordToSpell = new Map();
    this.spellData = {};

    this.micOn = false;
    this.mana = 100;
    this.maxMana = 100;

    this.lastCastTime = {};
    this.audioCtx = null;

    this.voice = null;

    // Results screen stats (client-side)
    this.matchStats = null;
    this.statsById = new Map();
    this.mySlot = 0;
  }

  resetMatchStats() {
    this.statsById = new Map();
    this.matchStats = {
      startAt: Date.now(),
      casts: 0,
      hitsLanded: 0,
      dmgDealt: 0,
      dmgTaken: 0,
      healsDone: 0,
    };
  }

  ensureStats(id) {
    if (!id) return null;
    if (!this.statsById) this.statsById = new Map();
    if (!this.statsById.has(id)) {
      this.statsById.set(id, { casts: 0, hitsLanded: 0, dmgDealt: 0, dmgTaken: 0, healsDone: 0 });
    }
    return this.statsById.get(id);
  }

  init(data) {
    this.roomCode = data?.roomCode;
    this.playerId = data?.playerId;
    this.loadout = data?.loadout || null;
  }

  preload() {
    // Wizards / wand
    this.load.spritesheet("wizard-red", "/assets/wizard-idle.png", { frameWidth: 50, frameHeight: 81 });
    this.load.spritesheet("wizard-blue", "/assets/wizard-idle-blue.png", { frameWidth: 50, frameHeight: 81 });
    this.load.spritesheet("wand-cast", "/assets/wand-cast.png", { frameWidth: 113, frameHeight: 98 });

    // Backgrounds
    this.load.image("arena-full", "/assets/arena-full.png");
    this.load.image("arena-bg", "/assets/arena-bg.png"); // fallback

    // Map collision data
    this.load.json("arena-tmj", "/assets/ArenaMAPset.tmj");

    // VFX sheets (64x64 frames, 4x2)
    this.load.spritesheet("vfx-fire", "/assets/vfx/vfx_fire_explosion_sheet.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("vfx-water", "/assets/vfx/vfx_water_splash_sheet.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("vfx-wind", "/assets/vfx/vfx_wind_slash_sheet.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("vfx-rock", "/assets/vfx/vfx_rock_shatter_sheet.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("vfx-poison", "/assets/vfx/vfx_poison_cloud_sheet.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("vfx-block", "/assets/vfx/vfx_block_spark_sheet.png", { frameWidth: 64, frameHeight: 64 });
    this.load.spritesheet("vfx-cast", "/assets/vfx/vfx_cast_ring_sheet.png", { frameWidth: 64, frameHeight: 64 });

    // Projectiles (optional)
    this.load.image("proj-spark", "/assets/proj-spark.png");
    this.load.image("proj-wagalona", "/assets/proj-wagalona.png");
    this.load.image("proj-zephyra", "/assets/proj-zephyra.png");
  }

  buildKeywordIndex(keywords) {
    this.keywordToSpell.clear();
    for (const [spellId, meta] of Object.entries(keywords || {})) {
      const inc = String(meta?.incantation || spellId).toLowerCase();
      this.keywordToSpell.set(inc, spellId);
      for (const a of (meta?.aliases || [])) this.keywordToSpell.set(String(a).toLowerCase(), spellId);
    }
  }

  async create(data) {
    this.roomCode = data?.roomCode;
    this.playerId = data?.playerId;
    this.loadout = data?.loadout || this.loadout || null;
    this.equipped = new Set((this.loadout?.length) ? this.loadout : ["spark","wagalona","zephyra"]);

    this.resetMatchStats();

    // Load spell data + keywords
    try {
      const [spellsRes, keywordsRes] = await Promise.all([fetch("/data/spells.json"), fetch("/data/keywords.json")]);
      this.spellData = await spellsRes.json();
      this.buildKeywordIndex(await keywordsRes.json());
    } catch (e) {
      console.warn("Failed to load spell data:", e);
      this.spellData = {};
    }

    // Audio context (needs gesture)
    this.input.once("pointerdown", () => { if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); });
    this.input.keyboard?.once("keydown", () => { if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); });

    // Animations
    if (!this.anims.exists("wiz-red-idle")) {
      this.anims.create({ key: "wiz-red-idle", frames: this.anims.generateFrameNumbers("wizard-red", { start: 0, end: 1 }), frameRate: 3, repeat: -1 });
    }
    if (!this.anims.exists("wiz-blue-idle")) {
      this.anims.create({ key: "wiz-blue-idle", frames: this.anims.generateFrameNumbers("wizard-blue", { start: 0, end: 1 }), frameRate: 3, repeat: -1 });
    }
    // "Walk" is just a faster flip between the two idle frames (better than pure sliding)
    if (!this.anims.exists("wiz-red-walk")) {
      this.anims.create({ key: "wiz-red-walk", frames: this.anims.generateFrameNumbers("wizard-red", { start: 0, end: 1 }), frameRate: 10, repeat: -1 });
    }
    if (!this.anims.exists("wiz-blue-walk")) {
      this.anims.create({ key: "wiz-blue-walk", frames: this.anims.generateFrameNumbers("wizard-blue", { start: 0, end: 1 }), frameRate: 10, repeat: -1 });
    }
    if (!this.anims.exists("wand-cast-anim")) {
      this.anims.create({ key: "wand-cast-anim", frames: this.anims.generateFrameNumbers("wand-cast", { start: 0, end: 3 }), frameRate: 12, repeat: 0 });
    }
    const ensureVfx = (key, animKey) => {
      if (this.anims.exists(animKey)) return;
      this.anims.create({ key: animKey, frames: this.anims.generateFrameNumbers(key, { start: 0, end: 7 }), frameRate: 14, repeat: 0 });
    };
    ensureVfx("vfx-fire", "vfx-fire-anim");
    ensureVfx("vfx-water", "vfx-water-anim");
    ensureVfx("vfx-wind", "vfx-wind-anim");
    ensureVfx("vfx-rock", "vfx-rock-anim");
    ensureVfx("vfx-poison", "vfx-poison-anim");
    ensureVfx("vfx-block", "vfx-block-anim");
    ensureVfx("vfx-cast", "vfx-cast-anim");

    // Background (world-space only). Page background fills letterbox for FIT scaling.
    const bgKey = this.textures.exists("arena-full") ? "arena-full" : "arena-bg";
    this.bgMain  = this.add.image(WORLD.W / 2, WORLD.H / 2, bgKey).setOrigin(0.5).setScrollFactor(1).setDepth(-999);

    // Camera stays stable (no zoom jitter across clients)
    this.cameras.main.setBounds(0, 0, WORLD.W, WORLD.H);
    this.cameras.main.centerOn(WORLD.W / 2, WORLD.H / 2);
    this.cameras.main.setRoundPixels(true);

    // Physics bounds
    this.physics.world.setBounds(0, 0, WORLD.W, WORLD.H);

    // Collision walls (from TMJ collision layer)
    this.walls = this.physics.add.staticGroup();
    this.buildCollisionFromTmj();

    // Projectiles (visuals driven by server proj:spawn)
    this.projectiles = this.physics.add.group();
    this.projById = new Map();

    // DOM HUD (restyled via CSS; keep it)
    this.hud = {
      root: document.getElementById("hudOverlay"),
      room: document.getElementById("hudRoom"),
      phase: document.getElementById("hudPhase"),
      timer: document.getElementById("hudTimer"),
      mic: document.getElementById("hudMic"),
      sub: document.getElementById("hudSubtitle"),
      sub2: document.getElementById("hudSubtitle2"),
      hpL: document.getElementById("hudHPLeft"),
      hpR: document.getElementById("hudHPRight"),
      hpBarL: document.getElementById("hudHPBarLeft"),
      hpBarR: document.getElementById("hudHPBarRight"),
      hpNumL: document.getElementById("hudHPNumLeft"),
      hpNumR: document.getElementById("hudHPNumRight"),
      manaWrapL: document.getElementById("manaLeft"),
      manaWrapR: document.getElementById("manaRight"),
      manaBarL: document.getElementById("hudManaBarLeft"),
      manaBarR: document.getElementById("hudManaBarRight"),
      manaTextL: document.getElementById("hudManaTextLeft"),
      manaTextR: document.getElementById("hudManaTextRight"),
      readyL: document.getElementById("hudReadyLeft"),
      readyR: document.getElementById("hudReadyRight"),
      cd: document.getElementById("hudCooldowns"),
    };

    this.howto = {
      overlay: document.getElementById("howtoOverlay"),
      okBtn: document.getElementById("howtoOkBtn"),
      dontShow: document.getElementById("howtoDontShow"),
    };
    this.endUI = {
      overlay: document.getElementById("endOverlay"),
      winner: document.getElementById("endWinner"),
      meta: document.getElementById("endMeta"),
      nameL: document.getElementById("endNameLeft"),
      nameR: document.getElementById("endNameRight"),
      hpL: document.getElementById("endHPLeft"),
      hpR: document.getElementById("endHPRight"),
      dmgL: document.getElementById("endDmgLeft"),
      dmgR: document.getElementById("endDmgRight"),
      takenL: document.getElementById("endTakenLeft"),
      takenR: document.getElementById("endTakenRight"),
      castL: document.getElementById("endCastLeft"),
      castR: document.getElementById("endCastRight"),
      hitsL: document.getElementById("endHitsLeft"),
      hitsR: document.getElementById("endHitsRight"),
      healL: document.getElementById("endHealLeft"),
      healR: document.getElementById("endHealRight"),
      rematchBtn: document.getElementById("rematchBtn"),
      backBtn: document.getElementById("backBtn"),
    };
    if (this.hud.root) this.hud.root.style.display = "block";
    if (this.hud.room) this.hud.room.textContent = `Room: ${this.roomCode}`;

    // Input
    const kb = this.input?.keyboard;
    if (kb) {
      this.cursors = kb.createCursorKeys();
      this.keyR = kb.addKey(Phaser.Input.Keyboard.KeyCodes.R);
      this.keyM = kb.addKey(Phaser.Input.Keyboard.KeyCodes.M);
      this.key1 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
      this.key2 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
      this.key3 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.THREE);
      this.key4 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.FOUR);
      this.key5 = kb.addKey(Phaser.Input.Keyboard.KeyCodes.FIVE);
      this.keyN = kb.addKey(Phaser.Input.Keyboard.KeyCodes.N);
      this.keyB = kb.addKey(Phaser.Input.Keyboard.KeyCodes.B);
    } else {
      this.cursors = null;
    }

    // Voice
    this.voice = new VoiceCaster({
      onPhrase: ({ raw, normalized }) => this.onVoicePhrase(raw, normalized),
      onError: (msg) => this.setSubtitle2(`🎤 ${msg}`),
    });

    // Pose sync timer
    this.poseTimer = this.time.addEvent({ delay: 50, loop: true, callback: () => this.sendPoseIfNeeded() });

    // Socket handlers
    const socket = getSocket();

    socket.off("room:state");
    socket.off("phase:start");
    socket.off("spell:event");
    socket.off("hit:event");
    socket.off("heal:event");
    socket.off("status:event");
    socket.off("mana:update");
    socket.off("cast:fail");
    socket.off("match:end");
    socket.off("player:pose");
    socket.off("proj:spawn");
    socket.off("proj:hit");

    socket.on("room:state", (st) => {
      this.phase = st.phase;
      this.phaseEndTime = st.phaseEndTime;
      this.updatePlayers(st.players);
      this.updateHPHud(st.players);
      this.updateReadyHud(st.players);
      if (st.phase !== PHASE.END) this.hideEnd();
    });

    // Realtime movement sync from server
    socket.on("player:pose", ({ id, x, y, facingLeft }) => {
      const obj = this.playersById.get(id);
      if (!obj || id === this.playerId) return;
      obj.targetX = Number(x ?? obj.targetX ?? obj.sprite.x);
      obj.targetY = Number(y ?? obj.targetY ?? obj.sprite.y);
      if (typeof facingLeft === 'boolean') obj.facingLeft = facingLeft;
      obj.lastPoseAt = Date.now();
    });


socket.on("proj:spawn", (p) => {
  this.spawnProjectileVisual(p);
});

socket.on("proj:hit", ({ projId }) => {
  const obj = this.projById?.get?.(projId);
  if (obj?.sprite?.active) obj.sprite.destroy();
  if (obj?.trailTimer) obj.trailTimer.remove(false);
  this.projById?.delete?.(projId);
});

    socket.on("mana:update", ({ mana, maxMana }) => {
      if (typeof mana === "number") this.mana = mana;
      if (typeof maxMana === "number") this.maxMana = maxMana;
    });

    socket.on("cast:fail", ({ spellId, reason }) => {
      this.setSubtitle2(`⛔ ${spellId}: ${reason}`);
      makeBeep(this.audioCtx, 180, 0.08, 0.08, "square");
    });

    socket.on("phase:start", ({ phase, durationMs, serverTime }) => {
      this.phase = phase;
      this.clockOffsetMs = (serverTime ?? Date.now()) - Date.now();
      this.phaseEndTime = durationMs ? (serverTime + durationMs) : null;
      socket.emit("room:sync");
      if (phase === PHASE.PREROUND) {
        this.resetMatchStats();
        // Clear old projectiles/VFX on rematch so the new round looks clean
        for (const obj of this.projById?.values?.() || []) {
          try { obj?.trailTimer?.remove?.(false); obj?.sprite?.destroy?.(); } catch {}
        }
        this.projById?.clear?.();
      }

      if (phase === PHASE.ROUND) {
        makeBeep(this.audioCtx, 880, 0.15, 0.1);
        setTimeout(() => makeBeep(this.audioCtx, 1100, 0.2, 0.12), 150);
      }
      if (phase === PHASE.PREROUND) makeBeep(this.audioCtx, 440, 0.25, 0.08);
    });

    socket.on("spell:event", (evt) => {
      this.spawnSpell(evt);
      const s = this.ensureStats(evt?.casterId);
      if (s) s.casts += 1;
      if (evt?.casterId === this.playerId && this.matchStats) this.matchStats.casts += 1;
      // small cast sound
      makeBeep(this.audioCtx, 520, 0.07, 0.05, "sine");
    });

    socket.on("hit:event", (evt) => {
      const caster = this.playersById.get(evt.casterId);
      const target = this.playersById.get(evt.targetId);
      const blocked = evt.blocked ? ` (BLOCKED:${evt.blockedBy || "?"})` : "";
      this.setSubtitle(`${caster?.name || "?"} → ${target?.name || "?"} : ${evt.spellId}  -${evt.damage}${blocked}`);
      this.playImpactVfx(evt.spellId, evt.atX ?? target?.x ?? 0, evt.atY ?? target?.y ?? 0, evt.blocked, false, evt.damage);
      if (evt.projId) {
        const objp = this.projById?.get?.(evt.projId);
        if (objp?.trailTimer) objp.trailTimer.remove(false);
        if (objp?.sprite?.active) objp.sprite.destroy();
        this.projById?.delete?.(evt.projId);
      }

      if (!evt.blocked) {
        const dmg = Math.max(0, Number(evt.damage ?? 0));
        const cs = this.ensureStats(evt.casterId);
        const ts = this.ensureStats(evt.targetId);
        if (cs) {
          cs.hitsLanded += 1;
          cs.dmgDealt += dmg;
        }
        if (ts) ts.dmgTaken += dmg;
      }

      if (evt.targetId === this.playerId && !evt.blocked) {
        if (this.matchStats) this.matchStats.dmgTaken += Math.max(0, Number(evt.damage ?? 0));
        const dmg = Math.max(0, Number(evt.damage ?? 0));
        const intensity = Math.min(0.02, 0.004 + dmg * 0.00028);
        this.cameras.main.shake(140, intensity);
        if (dmg >= 18) this.cameras.main.flash(90, 255, 160, 120, true);
        else this.cameras.main.flash(60, 120, 180, 255, true);
        makeBeep(this.audioCtx, 150, 0.18, 0.12, "sawtooth");
      }

      if (evt.casterId === this.playerId && !evt.blocked) {
        if (this.matchStats) {
          this.matchStats.hitsLanded += 1;
          this.matchStats.dmgDealt += Math.max(0, Number(evt.damage ?? 0));
        }
      }
    });

    socket.on("heal:event", (evt) => {
      const caster = this.playersById.get(evt.casterId);
      this.setSubtitle(`${caster?.name || "?"} healed +${evt.heal}`);
      this.playImpactVfx(evt.spellId, evt.atX ?? caster?.x ?? 0, evt.atY ?? caster?.y ?? 0, false, true, evt.heal);
      const s = this.ensureStats(evt?.casterId);
      if (s) s.healsDone += Math.max(0, Number(evt.heal ?? 0));
      if (evt.casterId === this.playerId && this.matchStats) this.matchStats.healsDone += Math.max(0, Number(evt.heal ?? 0));
    });

    socket.on("status:event", (evt) => {
      if (evt.stunMs) this.setSubtitle2(`💫 Stun ${(evt.stunMs/1000).toFixed(1)}s from ${evt.spellId}`);
    });

    socket.on("match:end", ({ winnerId }) => {
      this.phase = PHASE.END;
      this.phaseEndTime = null;
      this.showEnd(winnerId);
    });

    // End UI buttons
    if (this.endUI.rematchBtn) this.endUI.rematchBtn.onclick = () => socket.emit("room:rematch");
    if (this.endUI.backBtn) this.endUI.backBtn.onclick = () => { localStorage.removeItem("wizardSession"); location.reload(); };

    // Ensure we always have the latest room state (prevents "wizard appears only after ready")
    socket.emit("room:sync");

    // Show story/how-to once per browser session (after entering the match screen)
    this.setupHowtoOverlay();

  }

  setupHowtoOverlay() {
    try {
      if (!this.howto?.overlay) return;
      const seen = localStorage.getItem("wizardHowtoSeen") === "1";
      if (!seen) this.howto.overlay.style.display = "flex";

      const hide = () => {
        if (this.howto?.overlay) this.howto.overlay.style.display = "none";
        const dont = !!this.howto?.dontShow?.checked;
        if (dont) localStorage.setItem("wizardHowtoSeen", "1");
      };
      this.howto.okBtn && (this.howto.okBtn.onclick = hide);
      this.howto.overlay.addEventListener("click", (e) => {
        if (e.target === this.howto.overlay) hide();
      });
      // keyboard dismiss
      this.input.keyboard?.on("keydown-ENTER", hide);
      this.input.keyboard?.on("keydown-SPACE", hide);
    } catch {}
  }


  spawnProjectileVisual(p) {
    try {
      if (!p || !p.projId) return;
      if (!this.projById) this.projById = new Map();
      if (this.projById.has(p.projId)) return;

      const spellId = String(p.spellId || "spark");
      const spell = this.spellData?.[spellId] || {};
      const el = elementKeyForSpell(spellId, spell);

      // Align to server time so projectiles don't look "late" on other clients
      const serverTime = Number(p.serverTime ?? Date.now());
      const elapsedMs = Math.max(0, Math.min(1000, (Date.now() + (this.clockOffsetMs || 0)) - serverTime));
      const ex = elapsedMs / 1000;

      const vx = Number(p.vx ?? 0);
      const vy = Number(p.vy ?? 0);
      const radius = Number(p.radius ?? 10);
      const lifetimeMs = Number(p.lifetimeMs ?? 800);

      const x0 = Number(p.x ?? 0) + vx * ex;
      const y0 = Number(p.y ?? 0) + vy * ex;

      // Prefer custom projectile png if present, otherwise generate a tinted orb
      const projTexMap = { spark: "proj-spark", wagalona: "proj-wagalona", zephyra: "proj-zephyra" };
      const texKey = projTexMap[spellId];

      let sprite;
      if (texKey && this.textures.exists(texKey)) {
        sprite = this.physics.add.sprite(x0, y0, texKey);
        sprite.setScale(Math.max(0.65, radius / 12));
      } else {
        const color = { fire: 0xff7a45, water: 0x53d0ff, wind: 0x7dd3fc, rock: 0xd6a87a, poison: 0x6dff9a }[el] || 0xffffff;
        const key = `orb_${el}_${radius}`;
        if (!this.textures.exists(key)) {
          const g = this.make.graphics({ add: false });
          g.fillStyle(color, 1);
          g.fillCircle(radius, radius, radius);
          g.lineStyle(2, 0xffffff, 0.55);
          g.strokeCircle(radius, radius, Math.max(2, radius - 1));
          g.generateTexture(key, radius * 2, radius * 2);
          g.destroy();
        }
        sprite = this.physics.add.sprite(x0, y0, key);
      }

      sprite.body.setAllowGravity(false);
      sprite.setVelocity(vx, vy);
      sprite.setDepth(18);
      sprite.setAlpha(0.95);
      sprite.setBlendMode(Phaser.BlendModes.ADD);

      // Element trail: tiny animated puffs for "anime" feel
      const trailKey = el === "fire" ? "vfx-fire" : (el === "water" ? "vfx-water" : (el === "wind" ? "vfx-wind" : (el === "rock" ? "vfx-rock" : "vfx-poison")));
      const trailAnim = trailKey === "vfx-fire" ? "vfx-fire-anim" :
                        trailKey === "vfx-water" ? "vfx-water-anim" :
                        trailKey === "vfx-wind" ? "vfx-wind-anim" :
                        trailKey === "vfx-rock" ? "vfx-rock-anim" : "vfx-poison-anim";

      const trailTimer = this.time.addEvent({
        delay: 70,
        loop: true,
        callback: () => {
          if (!sprite.active) return;
          const puff = this.add.sprite(sprite.x, sprite.y, trailKey, 0).setDepth(12).setScale(0.35).setAlpha(0.7);
          puff.setBlendMode(Phaser.BlendModes.ADD);
          puff.play(trailAnim);
          this.tweens.add({ targets: puff, alpha: 0, duration: 260, onComplete: () => puff.destroy() });
        }
      });

      const remaining = Math.max(0, lifetimeMs - elapsedMs);
      this.time.delayedCall(remaining, () => {
        if (trailTimer) trailTimer.remove(false);
        if (sprite?.active) sprite.destroy();
        this.projById?.delete?.(p.projId);
      });

      this.projById.set(p.projId, { sprite, trailTimer });
    } catch (e) {
      console.warn("spawnProjectileVisual failed", e);
    }
  }


  buildCollisionFromTmj() {
    const tmj = this.cache.json.get("arena-tmj");
    if (!tmj) return;

    try {
      const group = tmj.layers?.find(l => l.type === "group");
      const coll = group?.layers?.find(l => String(l.name || "").toLowerCase().includes("collison") || String(l.name || "").toLowerCase().includes("collision"));
      if (!coll?.data) return;

      const w = tmj.width, h = tmj.height;
      const tw = tmj.tilewidth, th = tmj.tileheight;
      const data = coll.data;

      // Merge horizontal runs into rectangles (fast)
      for (let y = 0; y < h; y++) {
        let runStart = -1;
        for (let x = 0; x < w; x++) {
          const solid = data[y*w + x] !== 0;
          if (solid && runStart === -1) runStart = x;
          const endRun = (!solid || x === w-1) && runStart !== -1;
          if (endRun) {
            const runEnd = solid && x === w-1 ? x : x-1;
            const len = (runEnd - runStart + 1);
            const rx = (runStart * tw);
            const ry = (y * th);
            const rw = len * tw;
            const rh = th;

            const rect = this.add.rectangle(rx + rw/2, ry + rh/2, rw, rh, 0x000000, 0);
            this.physics.add.existing(rect, true);
            this.walls.add(rect);

            runStart = -1;
          }
        }
      }
    } catch (e) {
      console.warn("Collision build failed:", e);
    }
  }

  setSubtitle(text) {
    if (this.hud?.sub) this.hud.sub.textContent = text || "";
  }
  setSubtitle2(text) {
    if (this.hud?.sub2) this.hud.sub2.textContent = text || "";
  }

  updateReadyHud(playersArr) {
    if (!this.hud?.readyL || !this.hud?.readyR) return;
    const p0 = playersArr.find(p => Number(p.slot ?? 0) === 0);
    const p1 = playersArr.find(p => Number(p.slot ?? 1) === 1);
    const fmt = (p) => {
      if (!p) return "";
      const isMe = p.id === this.playerId;
      return `${p.name}${isMe ? " (you)" : ""}: ${p.ready ? "✓ READY" : "…"}`;
    };
    this.hud.readyL.textContent = p0 ? fmt(p0) : "Waiting…";
    this.hud.readyR.textContent = p1 ? fmt(p1) : "Waiting…";
  }

  updatePlayers(playersArr) {
    const ids = new Set(playersArr.map(p => p.id));

    // Remove stale
    for (const [id, obj] of this.playersById.entries()) {
      if (!ids.has(id)) {
        obj.sprite?.destroy();
        obj.wand?.destroy();
        obj.label?.destroy();
        this.playersById.delete(id);
      }
    }

    for (const p of playersArr) {
      const isMe = p.id === this.playerId;
      const slot = Number(p.slot ?? (playersArr.indexOf(p)));
      const texKey = slot === 0 ? "wizard-red" : "wizard-blue";
      const animKey = slot === 0 ? "wiz-red-idle" : "wiz-blue-idle";

      if (!this.playersById.has(p.id)) {
        // local uses physics sprite, remote uses plain sprite to avoid jitter
        const sprite = isMe ? this.physics.add.sprite(p.x, p.y, texKey) : this.add.sprite(p.x, p.y, texKey);
        sprite.play(animKey);
        sprite.setScale(1.0);

        if (isMe) {
          sprite.body.setAllowGravity(false);
          sprite.setCollideWorldBounds(true);
          // collide with walls
          this.physics.add.collider(sprite, this.walls);
        }

        const wand = this.add.sprite(p.x, p.y, "wand-cast", 0);
        wand.setScale(0.35);
        wand.setOrigin(0.2, 0.8);

        const label = this.add.text(p.x, p.y - 52, p.name || "?", {
          fontSize: "12px",
          color: isMe ? "#6ee7ff" : "#ffb86e",
          stroke: "#000",
          strokeThickness: 3,
        }).setOrigin(0.5);

        this.playersById.set(p.id, {
          ...p,
          sprite,
          wand,
          label,
          slot,
          // for remote interpolation
          targetX: p.x,
          targetY: p.y,
          lastPoseAt: Date.now(),
          facingLeft: (typeof p.facingLeft === 'boolean') ? p.facingLeft : false,
        });
      }

      const obj = this.playersById.get(p.id);
      obj.name = p.name; obj.ready = p.ready; obj.hp = p.hp; obj.x = p.x; obj.y = p.y; obj.slot = slot;
      if (typeof p.facingLeft === 'boolean') obj.facingLeft = p.facingLeft;

      // For remote players: do not teleport every room:state; set a target and lerp in update().
      if (!isMe) {
        obj.targetX = Number(p.x ?? obj.targetX);
        obj.targetY = Number(p.y ?? obj.targetY);
      }

      // keep label text updated (position will be updated continuously)
      obj.label?.setText(p.name || "?");

      // Wand positioning uses networked facingLeft
      const facingLeft = (typeof obj.facingLeft === 'boolean') ? obj.facingLeft : false;
      const offX = facingLeft ? -16 : 16;
      obj.wand.setFlipX(facingLeft);
      obj.sprite.setFlipX(facingLeft);

      // show stun (dim)
      const stunned = (p.stunnedUntil ?? 0) > this.serverNow();
      obj.sprite.setAlpha(stunned ? 0.6 : 1);
      obj.wand.setAlpha(stunned ? 0.6 : 1);
    }
  }

  updateHPHud(playersArr) {
    const me = playersArr.find(p => p.id === this.playerId);
    if (me && typeof me.slot === "number") this.mySlot = me.slot;

    // Left UI shows slot 0; Right UI shows slot 1 (so if you're on the right, your HP is on the right)
    const p0 = playersArr.find(p => Number(p.slot ?? 0) === 0);
    const p1 = playersArr.find(p => Number(p.slot ?? 1) === 1);

    if (this.hud?.hpL) this.hud.hpL.textContent = p0 ? `${p0.name}` : "";
    if (this.hud?.hpR) this.hud.hpR.textContent = p1 ? `${p1.name}` : "";

    const wL = Math.max(0, Math.min(100, Number(p0?.hp ?? 0)));
    const wR = Math.max(0, Math.min(100, Number(p1?.hp ?? 0)));

    // Quantize to "pixel" segments so it feels more retro.
    const seg = 46; // ~46 segments across the bar
    const qL = Math.round((wL / 100) * seg) / seg;
    const qR = Math.round((wR / 100) * seg) / seg;

    if (this.hud?.hpBarL) this.hud.hpBarL.style.transform = `scaleX(${qL})`;
    if (this.hud?.hpBarR) this.hud.hpBarR.style.transform = `scaleX(${qR})`;
    if (this.hud?.hpNumL) this.hud.hpNumL.textContent = `${wL}`;
    if (this.hud?.hpNumR) this.hud.hpNumR.textContent = `${wR}`;

    const hpFillBg = (hp, side) => {
      // side: 'L' green-ish, 'R' orange-ish
      if (hp <= 25) {
        return `repeating-linear-gradient(90deg, rgba(255,255,255,0.12) 0px, rgba(255,255,255,0.12) 6px, rgba(0,0,0,0.10) 6px, rgba(0,0,0,0.10) 12px), linear-gradient(90deg, rgba(239,68,68,1), rgba(244,63,94,1))`;
      }
      if (hp <= 50) {
        return `repeating-linear-gradient(90deg, rgba(255,255,255,0.12) 0px, rgba(255,255,255,0.12) 6px, rgba(0,0,0,0.10) 6px, rgba(0,0,0,0.10) 12px), linear-gradient(90deg, rgba(251,191,36,1), rgba(245,158,11,1))`;
      }
      if (side === 'R') {
        return `repeating-linear-gradient(90deg, rgba(255,255,255,0.12) 0px, rgba(255,255,255,0.12) 6px, rgba(0,0,0,0.10) 6px, rgba(0,0,0,0.10) 12px), linear-gradient(90deg, rgba(251,146,60,1), rgba(249,115,22,1))`;
      }
      return `repeating-linear-gradient(90deg, rgba(255,255,255,0.12) 0px, rgba(255,255,255,0.12) 6px, rgba(0,0,0,0.10) 6px, rgba(0,0,0,0.10) 12px), linear-gradient(90deg, rgba(74,222,128,1), rgba(34,197,94,1))`;
    };

    if (this.hud?.hpBarL) this.hud.hpBarL.style.backgroundImage = hpFillBg(wL, 'L');
    if (this.hud?.hpBarR) this.hud.hpBarR.style.backgroundImage = hpFillBg(wR, 'R');

    // Move mana to your side
    if (this.hud?.manaWrapL && this.hud?.manaWrapR && this.hud?.manaTextL && this.hud?.manaTextR) {
      if (this.mySlot === 1) {
        this.hud.manaWrapL.style.display = "none";
        this.hud.manaTextL.style.display = "none";
        this.hud.manaWrapR.style.display = "block";
        this.hud.manaTextR.style.display = "block";
      } else {
        this.hud.manaWrapL.style.display = "block";
        this.hud.manaTextL.style.display = "block";
        this.hud.manaWrapR.style.display = "none";
        this.hud.manaTextR.style.display = "none";
      }
    }
  }

  serverNow() { return Date.now() + this.clockOffsetMs; }

  playImpactVfx(spellId, x, y, blocked = false, heal = false, power = 8) {
    const spell = this.spellData?.[spellId] || {};
    const elKey = elementKeyForSpell(spellId, spell);

    const fxKey = blocked ? "vfx-block" : (heal ? "vfx-water" : ({
      fire: "vfx-fire", water: "vfx-water", wind: "vfx-wind", rock: "vfx-rock", poison: "vfx-poison"
    }[elKey] || "vfx-fire"));

    const animKey = blocked ? "vfx-block-anim" : (heal ? "vfx-water-anim" : ({
      "vfx-fire":"vfx-fire-anim","vfx-water":"vfx-water-anim","vfx-wind":"vfx-wind-anim","vfx-rock":"vfx-rock-anim","vfx-poison":"vfx-poison-anim"
    }[fxKey] || "vfx-fire-anim"));

    const s = this.add.sprite(x, y, fxKey, 0);
    s.setDepth(50);

    // Scale + glow based on impact power (damage/heal)
    const pwr = Math.max(0, Number(power ?? 0));
    const base = blocked ? 0.9 : (heal ? 1.0 : 1.1);
    const extra = Math.min(0.9, pwr / 30);
    s.setScale(base + extra);

    // Additive makes pixel VFX pop on dark backgrounds
    s.setBlendMode(Phaser.BlendModes.ADD);
    s.play(animKey);
    s.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => s.destroy());
  }

  spawnCastRing(x, y) {
    const s = this.add.sprite(x, y, "vfx-cast", 0);
    s.setDepth(40);
    s.setScale(1.0);
    s.play("vfx-cast-anim");
    s.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => s.destroy());
  }

  spawnSpell(evt) {
    const caster = this.playersById.get(evt.casterId);
    if (!caster) return;

    const spellId = String(evt.spellId || "");
    const spell = this.spellData?.[spellId] || {};
    const kind = String(evt.kind || spell.kind || "projectile").toLowerCase();

    // wand cast animation
    if (caster.wand?.active) {
      caster.wand.play("wand-cast-anim");
      caster.wand.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
        if (caster.wand?.active) caster.wand.setFrame(0);
      });
    }

    // cast ring
    this.spawnCastRing(caster.sprite.x, caster.sprite.y);

    // Delay shows charge ring only (actual effect later as hit/heal events)
    const delayMs = Number(evt.delayMs ?? 0);
    if (delayMs > 0) {
      const charge = this.add.circle(caster.sprite.x, caster.sprite.y, 26, 0xffffff, 0.10).setDepth(35);
      this.tweens.add({ targets: charge, alpha: 0, duration: delayMs, onComplete: () => charge.destroy() });
    }

    if (kind === "shield" || kind === "block") {
      // simple wall/shield VFX
      const dir = evt.aimDir || { x: 1, y: 0 };
      const px = caster.sprite.x + dir.x * 70;
      const py = caster.sprite.y + dir.y * 70;
      this.playImpactVfx(spellId, px, py, kind === "block", false);
      return;
    }

    if (kind === "heal") {
      this.playImpactVfx(spellId, caster.sprite.x, caster.sprite.y, false, true);
      return;
    }

    if (kind === "status") {
      // Area status VFX (gas/wind/rock): persistent ring + repeated puffs so it feels \"alive\"
      const dir = evt.aimDir || { x: 1, y: 0 };
      const range = Number(spell?.behavior?.range ?? 420);
      const tx = caster.sprite.x + dir.x * Math.min(range, 380);
      const ty = caster.sprite.y + dir.y * Math.min(range, 380);

      const el = elementKeyForSpell(spellId, spell);
      const puffKey = el === "poison" ? "vfx-poison" : (el === "wind" ? "vfx-wind" : (el === "rock" ? "vfx-rock" : "vfx-poison"));
      const puffAnim = puffKey === "vfx-wind" ? "vfx-wind-anim" : (puffKey === "vfx-rock" ? "vfx-rock-anim" : "vfx-poison-anim");

      const duration = Math.max(1200, Number(spell.durationMs ?? 1800));
      const radius = Number(spell.radius ?? 110);

      // ring hint
      const ringColor = el === "poison" ? 0x7CFF9A : (el === "wind" ? 0x9EEBFF : 0xEBC9A2);
      const ring = this.add.circle(tx, ty, radius, ringColor, 0.10).setDepth(25);
      ring.setStrokeStyle(2, ringColor, 0.28);
      this.tweens.add({ targets: ring, alpha: 0, duration, onComplete: () => ring.destroy() });

      // repeated puffs
      const puffInterval = 260;
      const repeats = Math.max(1, Math.floor(duration / puffInterval));
      const puffTimer = this.time.addEvent({
        delay: puffInterval,
        repeat: repeats,
        callback: () => {
          const ox = (Math.random() - 0.5) * radius * 0.8;
          const oy = (Math.random() - 0.5) * radius * 0.4;
          const cloud = this.add.sprite(tx + ox, ty + oy, puffKey, 0).setDepth(30).setScale(1.35).setAlpha(0.95);
          cloud.setBlendMode(Phaser.BlendModes.ADD);
          cloud.play(puffAnim);
          this.tweens.add({ targets: cloud, alpha: 0, y: cloud.y - 8, duration: 720, onComplete: () => cloud.destroy() });
        }
      });
      this.time.delayedCall(duration, () => puffTimer.remove(false));

      return;
    }

    // projectile visual is server-driven (proj:spawn)
    /* server-driven projectiles */
    return;

    // legacy local projectile visual (disabled)
    const beh = spell.behavior || {};
    const speed = Number(beh.speed ?? 520);
    const lifetime = Number(beh.lifetimeMs ?? 800);
    const radius = Number(beh.radius ?? 7);
    const count = Number(beh.count ?? 1);
    const spreadDeg = Number(beh.spreadDeg ?? 0);

    const seed = evt.seed ?? 1;
    const rnd = prng(seed);
    const baseAngle = Math.atan2(evt.aimDir?.y ?? 0, evt.aimDir?.x ?? 1);

    for (let i = 0; i < count; i++) {
      const spread = Phaser.Math.DegToRad(spreadDeg * (i - (count - 1) / 2));
      const jitter = (rnd() - 0.5) * Phaser.Math.DegToRad(spreadDeg * 0.35);
      const ang = baseAngle + spread + jitter;
      const vx = Math.cos(ang) * speed;
      const vy = Math.sin(ang) * speed;

      const projTexMap = { spark: "proj-spark", wagalona: "proj-wagalona", zephyra: "proj-zephyra" };
      const texKey = projTexMap[spellId];

      let proj;
      if (texKey && this.textures.exists(texKey)) {
        proj = this.physics.add.sprite(caster.sprite.x, caster.sprite.y, texKey);
        proj.setScale(Math.max(0.6, radius / 12));
      } else {
        const color = { fire: 0xff7a45, water: 0x53d0ff, wind: 0x7dd3fc, rock: 0xd6a87a, poison: 0x6dff9a }[elementKeyForSpell(spellId, spell)] || 0xffffff;
        const key = `orb_${spellId}_${radius}`;
        if (!this.textures.exists(key)) {
          const g = this.make.graphics({ add: false });
          g.fillStyle(color, 1);
          g.fillCircle(radius, radius, radius);
          g.lineStyle(2, 0xffffff, 0.55);
          g.strokeCircle(radius, radius, Math.max(2, radius - 1));
          g.generateTexture(key, radius * 2, radius * 2);
          g.destroy();
        }
        proj = this.physics.add.sprite(caster.sprite.x, caster.sprite.y, key);
      }

      proj.body.setAllowGravity(false);
      proj.setVelocity(vx, vy);
      proj.setDepth(20);

      // trail particles (lightweight)
      const el = elementKeyForSpell(spellId, spell);
      const trailColor = { fire: 0xffb86e, water: 0x88ddff, wind: 0xbef3ff, rock: 0xf2d7b9, poison: 0xa7ffbf }[el] || 0xffffff;
      const trailTimer = this.time.addEvent({
        delay: 50, loop: true, callback: () => {
          if (!proj.active) return;
          const p = this.add.circle(proj.x, proj.y, 2, trailColor, 0.35).setDepth(10);
          p.setBlendMode(Phaser.BlendModes.ADD);
          this.tweens.add({ targets: p, alpha: 0, duration: 260, onComplete: () => p.destroy() });
        }
      });

      this.time.delayedCall(lifetime, () => {
        if (trailTimer) trailTimer.remove(false);
        if (proj?.active) proj.destroy();
      });
    }
  }

  showEnd(winnerId) {
    if (!this.endUI?.overlay) return;
    this.endUI.overlay.style.display = "flex";
    const isWin = winnerId === this.playerId;
    if (this.endUI.winner) this.endUI.winner.textContent = isWin ? "VICTORY" : "DEFEAT";

    if (this.endUI.meta) {
      const dur = this.matchStats?.startAt ? (Date.now() - this.matchStats.startAt) : 0;
      this.endUI.meta.textContent = `Room ${this.roomCode || "—"} · ${(dur / 1000).toFixed(1)}s`;
    }

    // Fill per-side cards by slot (left=slot0, right=slot1)
    const arr = Array.from(this.playersById.values());
    const p0 = arr.find(p => Number(p.slot ?? 0) === 0);
    const p1 = arr.find(p => Number(p.slot ?? 1) === 1);
    const s0 = this.ensureStats(p0?.id) || { casts: 0, hitsLanded: 0, dmgDealt: 0, dmgTaken: 0, healsDone: 0 };
    const s1 = this.ensureStats(p1?.id) || { casts: 0, hitsLanded: 0, dmgDealt: 0, dmgTaken: 0, healsDone: 0 };

    if (this.endUI.nameL) this.endUI.nameL.textContent = `${p0?.name || "—"}${p0?.id === this.playerId ? " (you)" : ""}`;
    if (this.endUI.nameR) this.endUI.nameR.textContent = `${p1?.name || "—"}${p1?.id === this.playerId ? " (you)" : ""}`;
    if (this.endUI.hpL) this.endUI.hpL.textContent = `${p0?.hp ?? "—"}`;
    if (this.endUI.hpR) this.endUI.hpR.textContent = `${p1?.hp ?? "—"}`;

    if (this.endUI.dmgL) this.endUI.dmgL.textContent = `${Math.round(s0.dmgDealt)}`;
    if (this.endUI.dmgR) this.endUI.dmgR.textContent = `${Math.round(s1.dmgDealt)}`;
    if (this.endUI.takenL) this.endUI.takenL.textContent = `${Math.round(s0.dmgTaken)}`;
    if (this.endUI.takenR) this.endUI.takenR.textContent = `${Math.round(s1.dmgTaken)}`;
    if (this.endUI.castL) this.endUI.castL.textContent = `${s0.casts}`;
    if (this.endUI.castR) this.endUI.castR.textContent = `${s1.casts}`;
    if (this.endUI.hitsL) this.endUI.hitsL.textContent = `${s0.hitsLanded}`;
    if (this.endUI.hitsR) this.endUI.hitsR.textContent = `${s1.hitsLanded}`;
    if (this.endUI.healL) this.endUI.healL.textContent = `${Math.round(s0.healsDone)}`;
    if (this.endUI.healR) this.endUI.healR.textContent = `${Math.round(s1.healsDone)}`;
  }

  hideEnd() {
    if (this.endUI?.overlay) this.endUI.overlay.style.display = "none";
  }

  serverNowMs() { return Date.now() + this.clockOffsetMs; }

  update(time, delta) {
    if (this.hud?.phase) this.hud.phase.textContent = `Phase: ${this.phase}`;
    if (this.phaseEndTime) {
      const ms = Math.max(0, this.phaseEndTime - (Date.now() + this.clockOffsetMs));
      if (this.hud?.timer) this.hud.timer.textContent = `⏱ ${(ms / 1000).toFixed(1)}s`;
    } else {
      if (this.hud?.timer) this.hud.timer.textContent = "";
    }

    // Mana UI (server authoritative) — shown on your side
    const mpPct = `${(this.mana / (this.maxMana || 100)) * 100}%`;
    const mpTxt = `MP ${Math.floor(this.mana)}`;
    if (this.mySlot === 1) {
      if (this.hud?.manaBarR) this.hud.manaBarR.style.width = mpPct;
      if (this.hud?.manaTextR) this.hud.manaTextR.textContent = mpTxt;
    } else {
      if (this.hud?.manaBarL) this.hud.manaBarL.style.width = mpPct;
      if (this.hud?.manaTextL) this.hud.manaTextL.textContent = mpTxt;
    }

    // Cooldown UI as pills
    if (this.hud?.cd) {
      const now = Date.now();
      const lo = Array.from(this.equipped || []);
      const pills = lo.map((sid, i) => {
        const spell = this.spellData[sid] || {};
        const cdMs = Number(spell.cooldown ?? 0) * 1000;
        const last = this.lastCastTime[sid] || 0;
        const remaining = Math.max(0, cdMs - (now - last));
        const ready = remaining <= 0;
        const cost = Number(spell.manaCost ?? 0);
        const manaOk = this.mana >= cost;
        const cls = `cd-pill ${ready && manaOk ? "ready" : "locked"}`;
        const remTxt = ready ? "READY" : `${(remaining/1000).toFixed(1)}s`;
        const el = elementKeyForSpell(sid, spell);
        const dot = ({ fire: "#ff8a5b", water: "#53d0ff", wind: "#7dd3fc", rock: "#d6a87a", poison: "#6dff9a" }[el] || "#e8eef7");
        const costTxt = cost ? `MP ${cost}` : "";
        return `<span class="${cls}"><span class="k">[${i+1}]</span><span class="dot" style="width:10px;height:10px;border-radius:999px;background:${dot};box-shadow:0 0 10px rgba(255,255,255,0.10);"></span><span class="t">${sid}</span><span class="r">${remTxt}</span><span class="k" style="margin-left:6px;">${costTxt}</span></span>`;
      }).join("");
      this.hud.cd.innerHTML = `<div class="cd-pills">${pills}</div>`;
    }

    // Toggle ready/mic
    if (this.keyR && Phaser.Input.Keyboard.JustDown(this.keyR)) {
      const me = this.playersById.get(this.playerId);
      if (me) getSocket().emit("player:ready", { ready: !me.ready });
    }

    if (this.keyM && Phaser.Input.Keyboard.JustDown(this.keyM)) {
      this.micOn = !this.micOn;
      if (this.micOn) {
        if (!this.voice?.supported) {
          this.micOn = false;
          this.setSubtitle2("Mic unsupported: use Chrome/Edge.");
          if (this.hud?.mic) this.hud.mic.textContent = "🎙 UNSUPPORTED";
        } else {
          this.voice.start();
          this.setSubtitle2("🎙 Listening… say a spell incantation");
          if (this.hud?.mic) this.hud.mic.textContent = "🎙 ON";
        }
      } else {
        this.voice?.stop();
        if (this.hud?.mic) this.hud.mic.textContent = "🎙 OFF";
      }
    }

    // End phase keys
    if (this.keyN && Phaser.Input.Keyboard.JustDown(this.keyN) && this.phase === PHASE.END) getSocket().emit("room:rematch");
    if (this.keyB && Phaser.Input.Keyboard.JustDown(this.keyB) && this.phase === PHASE.END) { localStorage.removeItem("wizardSession"); location.reload(); }

    // Keyboard casting (3 loadout for now)
    const lo = Array.from(this.equipped || []);
    if (this.key1 && Phaser.Input.Keyboard.JustDown(this.key1) && lo[0]) this.castSpell(lo[0]);
    if (this.key2 && Phaser.Input.Keyboard.JustDown(this.key2) && lo[1]) this.castSpell(lo[1]);
    if (this.key3 && Phaser.Input.Keyboard.JustDown(this.key3) && lo[2]) this.castSpell(lo[2]);
    if (this.key4 && Phaser.Input.Keyboard.JustDown(this.key4) && lo[3]) this.castSpell(lo[3]);
    if (this.key5 && Phaser.Input.Keyboard.JustDown(this.key5) && lo[4]) this.castSpell(lo[4]);

    // Smooth remote movement + keep labels/wands attached
    const meObj = this.playersById.get(this.playerId);
    const oppObj = [...this.playersById.values()].find(o => o?.id && o.id !== this.playerId) || null;

    for (const [id, obj] of this.playersById.entries()) {
      if (!obj?.sprite?.active) continue;

      if (id !== this.playerId) {
        // Lerp towards latest server pose
        const tx = Number(obj.targetX ?? obj.sprite.x);
        const ty = Number(obj.targetY ?? obj.sprite.y);
        const dx = tx - obj.sprite.x;
        const dy = ty - obj.sprite.y;
        const dist = Math.hypot(dx, dy);
        const lerp = 0.35;
        if (dist > 0.1) {
          obj.sprite.x += dx * lerp;
          obj.sprite.y += dy * lerp;
        }

        // Simple "walk" feel instead of pure sliding
        const walkKey = obj.slot === 0 ? "wiz-red-walk" : "wiz-blue-walk";
        const idleKey = obj.slot === 0 ? "wiz-red-idle" : "wiz-blue-idle";
        if (dist > 0.8) {
          if (obj.sprite.anims?.currentAnim?.key !== walkKey) obj.sprite.play(walkKey);
        } else {
          if (obj.sprite.anims?.currentAnim?.key !== idleKey) obj.sprite.play(idleKey);
        }
      }

      // Facing uses networked facingLeft (prevents "wrong direction" bugs)
      const faceLeft = (typeof obj.facingLeft === 'boolean') ? obj.facingLeft : false;
      obj.sprite.setFlipX(faceLeft);
      obj.wand?.setFlipX(faceLeft);

      // Attach UI bits
      obj.label?.setPosition(obj.sprite.x, obj.sprite.y - 52);
      const offX = faceLeft ? -16 : 16;
      obj.wand?.setPosition(obj.sprite.x + offX, obj.sprite.y + 4);

      // Wand sway when moving (small, anime-y)
      if (id !== this.playerId) {
        const mx = Math.abs((obj.targetX ?? obj.sprite.x) - obj.sprite.x);
        obj.wand.rotation = mx > 0.6 ? (Math.sin(time / 90) * 0.08) : 0;
      }
    }

    // Movement (local)
    const me = this.playersById.get(this.playerId);
    if (!me) return;

    if (this.phase === PHASE.END) {
      if (me.sprite.body) me.sprite.setVelocity(0, 0);
      return;
    }

    const speed = 260;
    let vx = 0, vy = 0;
    if (this.cursors?.left?.isDown) vx -= speed;
    if (this.cursors?.right?.isDown) vx += speed;
    if (this.cursors?.up?.isDown) vy -= speed;
    if (this.cursors?.down?.isDown) vy += speed;

    if (me.sprite.body) me.sprite.setVelocity(vx, vy);

    if (vx < -1) me.facingLeft = true;
    else if (vx > 1) me.facingLeft = false;
    if (typeof me.facingLeft === 'boolean') {
      me.sprite.setFlipX(me.facingLeft);
      me.wand?.setFlipX(me.facingLeft);
    }

    // Local walk animation
    const moving = Math.abs(vx) + Math.abs(vy) > 0.1;
    const walkKey = me.slot === 0 ? "wiz-red-walk" : "wiz-blue-walk";
    const idleKey = me.slot === 0 ? "wiz-red-idle" : "wiz-blue-idle";
    if (moving) {
      if (me.sprite.anims?.currentAnim?.key !== walkKey) me.sprite.play(walkKey);
      me.wand.rotation = Math.sin(time / 80) * 0.10;
    } else {
      if (me.sprite.anims?.currentAnim?.key !== idleKey) me.sprite.play(idleKey);
      me.wand.rotation = 0;
    }
  }

  sendPoseIfNeeded() {
    if (this.phase === PHASE.END) return;
    const me = this.playersById.get(this.playerId);
    if (!me || !me.sprite?.body) return;

    const x = me.sprite.x, y = me.sprite.y;
    const t = Date.now();
    if (!this._lastPoseSent) this._lastPoseSent = { x, y, t: 0, facingLeft: !!me.facingLeft };

    const moved = Math.hypot(x - this._lastPoseSent.x, y - this._lastPoseSent.y);
    const due = (t - this._lastPoseSent.t) > 200; // keep-alive
    const facingChanged = (!!me.facingLeft) !== (!!this._lastPoseSent.facingLeft);
    if (moved > 0.8 || due || facingChanged) {
      this._lastPoseSent = { x, y, t, facingLeft: !!me.facingLeft };
      getSocket().emit("player:pose", { x, y, facingLeft: !!me.facingLeft });
    }
  }

  // Voice matching (existing)
  levenshtein(a, b) {
    a = String(a || ""); b = String(b || "");
    const n = a.length, m = b.length;
    if (!n) return m; if (!m) return n;
    const dp = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= m; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j-1] + 1, prev + (a[i-1] === b[j-1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[m];
  }

  similarity(a, b) {
    a = String(a || ""); b = String(b || "");
    return 1 - this.levenshtein(a, b) / (Math.max(a.length, b.length) || 1);
  }

  bestSpellsForPhrase(normalized, topK = 3) {
    const scores = new Map();
    for (const [k, sid] of this.keywordToSpell.entries()) {
      const s = this.similarity(normalized, k);
      if (s > (scores.get(sid) ?? 0)) scores.set(sid, s);
    }
    return [...scores.entries()].map(([spellId, score]) => ({ spellId, score })).sort((a, b) => b.score - a.score).slice(0, topK);
  }

  onVoicePhrase(raw, normalized) {
    const exact = this.keywordToSpell.get(normalized);
    if (exact) { this.setSubtitle(`🗣 "${raw}" → ${exact}`); this.castSpell(exact); return; }
    const top = this.bestSpellsForPhrase(normalized, 3);
    const best = top[0];
    if (best?.score >= 0.78) { this.setSubtitle(`🗣 "${raw}" → ${best.spellId} (${(best.score*100)|0}%)`); this.castSpell(best.spellId); return; }
    const shown = top.filter(x => x.score >= 0.55);
    let msg = `🗣 "${raw}" → no match`;
    if (shown.length) msg += `\nMaybe: ${shown.map(x => `${x.spellId}(${(x.score*100)|0}%)`).join(", ")}`;
    this.setSubtitle(msg);
  }

  castSpell(spellId) {
    if (this.equipped && !this.equipped.has(spellId)) return;
    if (![PHASE.PREROUND, PHASE.ROUND].includes(this.phase)) return;

    const spell = this.spellData[spellId];
    if (!spell) return;

    // client cooldown gate
    const cdMs = Number(spell.cooldown ?? 0) * 1000;
    const now = Date.now();
    if (now - (this.lastCastTime[spellId] || 0) < cdMs) return;

    // mana gate (server authoritative, but this prevents spam)
    const cost = Number(spell.manaCost ?? 0);
    if (this.mana < cost) {
      this.setSubtitle2(`Not enough MP for ${spellId} (need ${cost})`);
      makeBeep(this.audioCtx, 200, 0.08, 0.06, "square");
      return;
    }

    this.lastCastTime[spellId] = now;

    // Aim: toward opponent if exists, else right
    const me = this.playersById.get(this.playerId);
    const other = [...this.playersById.values()].find(p => p.id !== this.playerId);
    let aim = { x: 1, y: 0 };
    if (me && other) {
      const dx = other.sprite.x - me.sprite.x;
      const dy = other.sprite.y - me.sprite.y;
      const len = Math.hypot(dx, dy) || 1;
      aim = { x: dx / len, y: dy / len };
    }
    getSocket().emit("spell:cast", { spellId, aimDir: aim });
  }
}
