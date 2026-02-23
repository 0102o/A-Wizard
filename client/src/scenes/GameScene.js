import Phaser from "phaser";
import { getSocket } from "../net/socket.js";
import { VoiceCaster } from "../voice/VoiceCaster.js";

const PHASE = Object.freeze({
  LOBBY: "LOBBY",
  PREROUND: "PREROUND",
  ROUND: "ROUND",
  END: "END",
});

const SPELL_BEHAVIOR = Object.freeze({
  spark:    { speed: 580, lifetimeMs: 650, radius: 6,  count: 1, spreadDeg: 0  },
  wagalona: { speed: 400, lifetimeMs: 1100, radius: 12, count: 1, spreadDeg: 0  },
  zephyra:  { speed: 520, lifetimeMs: 850, radius: 7,  count: 2, spreadDeg: 12 },
  vortium:  { speed: 340, lifetimeMs: 1400, radius: 16, count: 1, spreadDeg: 0  },
  shieldra: { speed: 0,   lifetimeMs: 3000, radius: 22, count: 0, spreadDeg: 0, isShield: true },
});

const SPELL_COLORS = Object.freeze({
  spark:    0xffee58,
  wagalona: 0xff4444,
  zephyra:  0x40c4ff,
  vortium:  0xb040ff,
  shieldra: 0x40ffa0,
});

const MAX_MANA = 100;
const MANA_REGEN_PER_SEC = 12;

function prng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple Web Audio beep generator
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
    this.mana = MAX_MANA;
    this.lastCastTime = {};  // spellId -> timestamp
    this.audioCtx = null;
    this.shieldActive = false;
    this.shieldSprite = null;
  }

  init(data) {
    this.roomCode = data?.roomCode;
    this.playerId = data?.playerId;
    this.loadout = data?.loadout || null;
  }

  preload() {
    // Art assets
    this.load.spritesheet("wizard-red", "/assets/wizard-idle.png", { frameWidth: 50, frameHeight: 81 });
    this.load.spritesheet("wizard-blue", "/assets/wizard-idle-blue.png", { frameWidth: 50, frameHeight: 81 });
    this.load.spritesheet("wand-cast", "/assets/wand-cast.png", { frameWidth: 113, frameHeight: 98 });
    this.load.image("arena-bg", "/assets/arena-bg.png");
    this.load.image("proj-spark", "/assets/proj-spark.png");
    this.load.image("proj-wagalona", "/assets/proj-wagalona.png");
    this.load.image("proj-zephyra", "/assets/proj-zephyra.png");
  }

  async create(data) {
    this.roomCode = data?.roomCode;
    this.playerId = data?.playerId;
    this.loadout = data?.loadout || this.loadout || null;
    this.equipped = new Set((this.loadout?.length) ? this.loadout : ["spark","wagalona","zephyra"]);
    this.mana = MAX_MANA;
    this.lastCastTime = {};
    this.shieldActive = false;

    // Load spell data
    try {
      const [spellsRes, keywordsRes] = await Promise.all([
        fetch("/data/spells.json"), fetch("/data/keywords.json"),
      ]);
      this.spellData = await spellsRes.json();
      const keywords = await keywordsRes.json();
      this.buildKeywordIndex(keywords);
    } catch (e) { console.warn("Failed to load spell data:", e); }

    // Audio context (user gesture required)
    this.input.once("pointerdown", () => {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    });
    // Also try on key
    this.input.keyboard.once("keydown", () => {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    });

    const socket = getSocket();

    // Arena background
    if (this.textures.exists("arena-bg")) {
      this.add.image(320, 200, "arena-bg").setDisplaySize(640, 400);
    } else {
      this.add.rectangle(320, 200, 640, 400, 0x0f1723);
    }

    // Wizard idle animations
    if (!this.anims.exists("wiz-red-idle")) {
      this.anims.create({ key: "wiz-red-idle", frames: this.anims.generateFrameNumbers("wizard-red", { start: 0, end: 1 }), frameRate: 3, repeat: -1 });
    }
    if (!this.anims.exists("wiz-blue-idle")) {
      this.anims.create({ key: "wiz-blue-idle", frames: this.anims.generateFrameNumbers("wizard-blue", { start: 0, end: 1 }), frameRate: 3, repeat: -1 });
    }

    // DOM HUD
    this.hud = {
      root: document.getElementById("hudOverlay"),
      room: document.getElementById("hudRoom"),
      phase: document.getElementById("hudPhase"),
      timer: document.getElementById("hudTimer"),
      mic: document.getElementById("hudMic"),
      sub: document.getElementById("hudSubtitle"),
      hpL: document.getElementById("hudHPLeft"),
      hpR: document.getElementById("hudHPRight"),
      hpBarL: document.getElementById("hudHPBarLeft"),
      hpBarR: document.getElementById("hudHPBarRight"),
      manaBar: document.getElementById("hudManaBar"),
      manaText: document.getElementById("hudManaText"),
      readyL: document.getElementById("hudReadyLeft"),
      readyR: document.getElementById("hudReadyRight"),
      cd: document.getElementById("hudCooldowns"),
    };
    this.endUI = {
      overlay: document.getElementById("endOverlay"),
      winner: document.getElementById("endWinner"),
      rematchBtn: document.getElementById("rematchBtn"),
      backBtn: document.getElementById("backBtn"),
    };

    if (this.hud.root) this.hud.root.style.display = "block";
    if (this.hud.room) this.hud.room.textContent = `Room: ${this.roomCode}`;

    // Physics
    this.physics.world.setBounds(40, 80, 560, 280);
    this.playerGroup = this.physics.add.group();
    this.projectiles = this.physics.add.group();

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
      // Some browsers / embeds may not provide the Keyboard plugin; don't crash the scene.
      console.warn("[GameScene] Keyboard input unavailable; disabling keyboard controls.");
      this.cursors = null;
      this.keyR = this.keyM = this.key1 = this.key2 = this.key3 = this.key4 = this.key5 = this.keyN = this.keyB = null;
    }

    // Ready HUD
    this.updateReadyHud = (playersArr) => {
      if (!this.hud?.readyL || !this.hud?.readyR) return;
      const me = playersArr.find(p => p.id === this.playerId);
      const other = playersArr.find(p => p.id !== this.playerId);
      const fmt = (p, isMe) => {
        if (!p) return "";
        return `${p.name}${isMe ? " (you)" : ""}: ${p.ready ? "✓ READY" : "✗ not ready"}`;
      };
      this.hud.readyL.textContent = fmt(me, true);
      this.hud.readyR.textContent = other ? fmt(other) : "Waiting…";
    };

    // Socket handlers
    socket.on("room:state", (st) => {
      this.phase = st.phase;
      this.phaseEndTime = st.phaseEndTime;
      this.updatePlayers(st.players);
      this.updateHPHud(st.players);
      this.updateReadyHud?.(st.players);
      if (st.phase !== PHASE.END) this.hideEnd();
    });

    socket.on("phase:start", ({ phase, durationMs, serverTime }) => {
      this.phase = phase;
      this.clockOffsetMs = (serverTime ?? Date.now()) - Date.now();
      this.phaseEndTime = durationMs ? (serverTime + durationMs) : null;
      if (phase === PHASE.ROUND) {
        this.mana = MAX_MANA;
        makeBeep(this.audioCtx, 880, 0.15, 0.1);
        setTimeout(() => makeBeep(this.audioCtx, 1100, 0.2, 0.12), 150);
      }
      if (phase === PHASE.PREROUND) {
        makeBeep(this.audioCtx, 440, 0.3, 0.08);
      }
    });

    socket.on("spell:event", (evt) => {
      this.spawnSpell(evt);
      // Cast sound
      const freq = { spark: 900, wagalona: 300, zephyra: 600, vortium: 200, shieldra: 500 };
      makeBeep(this.audioCtx, freq[evt.spellId] || 440, 0.12, 0.08, evt.spellId === "vortium" ? "sawtooth" : "sine");
    });

    socket.on("hit:event", (evt) => {
      const caster = this.playersById.get(evt.casterId);
      const target = this.playersById.get(evt.targetId);
      this.setSubtitle(`${caster?.name || "?"} hit ${target?.name || "?"} with ${evt.spellId} (-${evt.damage}) HP=${evt.targetHp}`);

      // Hit flash on target sprite
      const tObj = this.playersById.get(evt.targetId);
      if (tObj?.sprite) {
        tObj.sprite.setTint(0xff0000);
        this.time.delayedCall(120, () => { if (tObj.sprite?.active) tObj.sprite.clearTint(); });
      }

      if (evt.targetId === this.playerId) {
        this.cameras.main.shake(180, 0.012);
        this.cameras.main.flash(100, 255, 50, 50, true);
        makeBeep(this.audioCtx, 150, 0.25, 0.15, "sawtooth");
      } else {
        makeBeep(this.audioCtx, 500, 0.08, 0.06);
      }
    });

    socket.on("match:end", ({ winnerId }) => {
      this.phase = PHASE.END;
      this.phaseEndTime = null;
      this.showEnd(winnerId);
      const isWin = winnerId === this.playerId;
      if (isWin) {
        makeBeep(this.audioCtx, 523, 0.15, 0.1);
        setTimeout(() => makeBeep(this.audioCtx, 659, 0.15, 0.1), 150);
        setTimeout(() => makeBeep(this.audioCtx, 784, 0.3, 0.12), 300);
      } else {
        makeBeep(this.audioCtx, 300, 0.4, 0.1, "sawtooth");
      }
    });

    // Voice
    this.voice = new VoiceCaster(
      ({ raw, normalized }) => this.onVoicePhrase(raw, normalized),
      (err) => this.setSubtitle(`Mic error: ${err}`)
    );

    // End overlay buttons
    if (this.endUI?.rematchBtn) this.endUI.rematchBtn.onclick = () => getSocket().emit("room:rematch");
    if (this.endUI?.backBtn) this.endUI.backBtn.onclick = () => { localStorage.removeItem("wizardSession"); location.reload(); };

    this.micOn = false;
    if (this.hud?.mic) this.hud.mic.textContent = "🎙 OFF";
    const lo = Array.from(this.equipped || []);
    this.setSubtitle(`Loadout: ${lo.map((s,i) => `${i+1}=${s}`).join(", ")} | M=Mic R=Ready`);

    // Pose sync
    this.poseTimer = this.time.addEvent({ delay: 50, loop: true, callback: () => this.sendPoseIfNeeded() });

    this.events.once("shutdown", () => {
      if (this.hud?.root) this.hud.root.style.display = "none";
      this.hideEnd();
      try { this.voice?.stop(); } catch {}
    });
  }

  buildKeywordIndex(kw) {
    this.keywordToSpell.clear();
    for (const [sid, obj] of Object.entries(kw)) {
      for (const s of [obj.incantation, ...(obj.aliases || [])].filter(Boolean)) {
        this.keywordToSpell.set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(), sid);
      }
    }
  }

  // ─── End overlay ───
  showEnd(winnerId) {
    if (!this.endUI?.overlay) return;
    const isMe = winnerId === this.playerId;
    const winner = this.playersById.get(winnerId);
    if (this.endUI.winner) {
      this.endUI.winner.textContent = isMe ? `🏆 You win!` : `${winner?.name || "Opponent"} wins!`;
      this.endUI.winner.style.color = isMe ? "#6ee7ff" : "#ffb86e";
    }
    this.endUI.overlay.style.display = "flex";
  }
  hideEnd() { if (this.endUI?.overlay) this.endUI.overlay.style.display = "none"; }
  setSubtitle(s) { if (this.hud?.sub) this.hud.sub.textContent = s; }

  // ─── Players ───
  updatePlayers(playersArr) {
    let myIdx = 0;
    const myEntry = playersArr.find(p => p.id === this.playerId);
    if (myEntry) myIdx = playersArr.indexOf(myEntry);

    for (const p of playersArr) {
      if (!this.playersById.has(p.id)) {
        const isMe = p.id === this.playerId;
        const pIdx = playersArr.indexOf(p);
        const texKey = pIdx === 0 ? "wizard-red" : "wizard-blue";
        const animKey = pIdx === 0 ? "wiz-red-idle" : "wiz-blue-idle";

        let sprite;
        if (this.textures.exists(texKey)) {
          sprite = this.physics.add.sprite(p.x, p.y, texKey);
          sprite.play(animKey);
          sprite.setScale(1.0);
        } else {
          const color = isMe ? 0x6ee7ff : 0xffb86e;
          const key = `wiz_${p.id}`;
          if (!this.textures.exists(key)) {
            const g = this.make.graphics({ add: false });
            g.fillStyle(color); g.fillRect(0, 0, 28, 28);
            g.generateTexture(key, 28, 28); g.destroy();
          }
          sprite = this.physics.add.sprite(p.x, p.y, key).setDisplaySize(28, 28);
        }
        sprite.setCollideWorldBounds(true);
        sprite.body.setAllowGravity(false);

        // Flip sprite: player 2 faces left
        if (pIdx === 1) sprite.setFlipX(true);

        const label = this.add.text(p.x, p.y - 48, p.name || "?", {
          fontSize: "11px", color: isMe ? "#6ee7ff" : "#ffb86e", align: "center",
          stroke: "#000", strokeThickness: 2,
        }).setOrigin(0.5);

        this.playersById.set(p.id, { ...p, sprite, label });
      }
      const obj = this.playersById.get(p.id);
      obj.name = p.name; obj.ready = p.ready; obj.hp = p.hp;
      if (p.id !== this.playerId) obj.sprite.setPosition(p.x, p.y);
      if (obj.label) { obj.label.setPosition(obj.sprite.x, obj.sprite.y - 48); obj.label.setText(p.name || "?"); }

      // Flip toward opponent
      const opponent = playersArr.find(pp => pp.id !== p.id);
      if (opponent) obj.sprite.setFlipX(opponent.x < p.x);
    }

    const ids = new Set(playersArr.map(p => p.id));
    for (const [id, obj] of this.playersById.entries()) {
      if (!ids.has(id)) { obj.sprite.destroy(); obj.label?.destroy(); this.playersById.delete(id); }
    }
  }

  updateHPHud(playersArr) {
    const me = playersArr.find(p => p.id === this.playerId);
    const other = playersArr.find(p => p.id !== this.playerId);
    if (this.hud?.hpL) this.hud.hpL.textContent = me ? `${me.name}: ${me.hp}` : "";
    if (this.hud?.hpR) this.hud.hpR.textContent = other ? `${other.name}: ${other.hp}` : "";
    if (this.hud?.hpBarL) this.hud.hpBarL.style.width = `${Math.max(0, me?.hp || 0)}%`;
    if (this.hud?.hpBarR) this.hud.hpBarR.style.width = `${Math.max(0, other?.hp || 0)}%`;

    // Color changes at low HP
    if (this.hud?.hpBarL) {
      const hp = me?.hp || 0;
      this.hud.hpBarL.style.background = hp > 50 ? "#4ade80" : hp > 25 ? "#fbbf24" : "#ef4444";
    }
    if (this.hud?.hpBarR) {
      const hp = other?.hp || 0;
      this.hud.hpBarR.style.background = hp > 50 ? "#fb923c" : hp > 25 ? "#fbbf24" : "#ef4444";
    }
  }

  serverNow() { return Date.now() + this.clockOffsetMs; }

  update(time, delta) {
    if (this.hud?.phase) this.hud.phase.textContent = `Phase: ${this.phase}`;
    if (this.phaseEndTime) {
      const ms = Math.max(0, this.phaseEndTime - this.serverNow());
      if (this.hud?.timer) this.hud.timer.textContent = `⏱ ${(ms / 1000).toFixed(1)}s`;
    } else {
      if (this.hud?.timer) this.hud.timer.textContent = "";
    }

    // Mana regen
    if (this.phase === PHASE.ROUND || this.phase === PHASE.PREROUND) {
      this.mana = Math.min(MAX_MANA, this.mana + MANA_REGEN_PER_SEC * (delta / 1000));
    }
    if (this.hud?.manaBar) this.hud.manaBar.style.width = `${(this.mana / MAX_MANA) * 100}%`;
    if (this.hud?.manaText) this.hud.manaText.textContent = `MP ${Math.floor(this.mana)}`;

    // Cooldown display
    if (this.hud?.cd) {
      const lo = Array.from(this.equipped || []);
      const now = Date.now();
      const parts = lo.map((sid, i) => {
        const spell = this.spellData[sid];
        const cdMs = (spell?.cooldown ?? 0) * 1000;
        const last = this.lastCastTime[sid] || 0;
        const remaining = Math.max(0, cdMs - (now - last));
        const ready = remaining <= 0;
        const manaOk = this.mana >= (spell?.manaCost || 0);
        const style = ready && manaOk ? "color:#4ade80" : "color:#666";
        const cdText = ready ? "" : ` (${(remaining/1000).toFixed(1)}s)`;
        return `<span style="${style}">[${i+1}] ${sid}${cdText}</span>`;
      });
      this.hud.cd.innerHTML = parts.join("  ");
    }

    // Toggle ready
    if (this.keyR && Phaser.Input.Keyboard.JustDown(this.keyR)) {
      const me = this.playersById.get(this.playerId);
      getSocket().emit("player:ready", { ready: !(me?.ready) });
    }

    // Toggle mic
    if (this.keyM && Phaser.Input.Keyboard.JustDown(this.keyM)) {
      this.micOn = !this.micOn;
      if (this.micOn) {
        if (!this.voice.supported) {
          this.micOn = false;
          this.setSubtitle("Mic unsupported: use Chrome/Edge.");
          if (this.hud?.mic) this.hud.mic.textContent = "🎙 UNSUPPORTED";
        } else {
          this.voice.start();
          this.setSubtitle("🎙 Listening… say a spell incantation");
          if (this.hud?.mic) this.hud.mic.textContent = "🎙 ON";
        }
      } else {
        this.voice.stop();
        this.setSubtitle("🎙 OFF");
        if (this.hud?.mic) this.hud.mic.textContent = "🎙 OFF";
      }
    }

    // End phase keys
    if (this.keyN && Phaser.Input.Keyboard.JustDown(this.keyN) && this.phase === PHASE.END) getSocket().emit("room:rematch");
    if (this.keyB && Phaser.Input.Keyboard.JustDown(this.keyB) && this.phase === PHASE.END) { localStorage.removeItem("wizardSession"); location.reload(); }

    // Keyboard casting
    const lo = Array.from(this.equipped || []);
    if (this.key1 && Phaser.Input.Keyboard.JustDown(this.key1) && lo[0]) this.castSpell(lo[0]);
    if (this.key2 && Phaser.Input.Keyboard.JustDown(this.key2) && lo[1]) this.castSpell(lo[1]);
    if (this.key3 && Phaser.Input.Keyboard.JustDown(this.key3) && lo[2]) this.castSpell(lo[2]);
    if (this.key4 && Phaser.Input.Keyboard.JustDown(this.key4) && lo[3]) this.castSpell(lo[3]);
    if (this.key5 && Phaser.Input.Keyboard.JustDown(this.key5) && lo[4]) this.castSpell(lo[4]);

    // Movement
    const me = this.playersById.get(this.playerId);
    if (!me) return;
    if (me.label) me.label.setPosition(me.sprite.x, me.sprite.y - 48);

    // Shield visual follows player
    if (this.shieldSprite?.active) {
      this.shieldSprite.setPosition(me.sprite.x, me.sprite.y);
    }

    if (this.phase !== PHASE.ROUND) { me.sprite.setVelocity(0, 0); return; }

    const speed = 200;
    let vx = 0, vy = 0;
    if (this.cursors?.left?.isDown) vx -= speed;
    if (this.cursors?.right?.isDown) vx += speed;
    if (this.cursors?.up?.isDown) vy -= speed;
    if (this.cursors?.down?.isDown) vy += speed;
    me.sprite.setVelocity(vx, vy);
  }

  sendPoseIfNeeded() {
    if (this.phase !== PHASE.ROUND) return;
    const me = this.playersById.get(this.playerId);
    if (!me) return;
    getSocket().emit("player:pose", { x: me.sprite.x, y: me.sprite.y });
  }

  // ─── Voice ───
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
    const me = this.playersById.get(this.playerId);
    if (!me) return;

    // Client-side cooldown check
    const spell = this.spellData[spellId];
    const cdMs = (spell?.cooldown ?? 0) * 1000;
    const now = Date.now();
    if (now - (this.lastCastTime[spellId] || 0) < cdMs) return;

    // Mana check
    const cost = spell?.manaCost ?? 0;
    if (this.mana < cost) {
      this.setSubtitle(`Not enough mana for ${spellId} (need ${cost}, have ${Math.floor(this.mana)})`);
      makeBeep(this.audioCtx, 200, 0.15, 0.06, "square");
      return;
    }
    this.mana -= cost;
    this.lastCastTime[spellId] = now;

    // Aim
    const others = [...this.playersById.values()].filter(p => p.id !== this.playerId);
    let ax = 1, ay = 0;
    if (others.length) {
      const o = others[0].sprite;
      const dx = o.x - me.sprite.x, dy = o.y - me.sprite.y;
      const len = Math.hypot(dx, dy) || 1;
      ax = dx / len; ay = dy / len;
    }

    getSocket().emit("spell:cast", { spellId, aimDir: { x: ax, y: ay } });
  }

  spawnSpell(evt) {
    const caster = this.playersById.get(evt.casterId);
    if (!caster) return;

    const spellId = evt.spellId;
    const beh = SPELL_BEHAVIOR[spellId] ?? SPELL_BEHAVIOR.spark;
    const color = SPELL_COLORS[spellId] ?? 0xffffff;

    // Shield spell — special behavior
    if (beh.isShield) {
      if (evt.casterId === this.playerId) {
        this.shieldActive = true;
        // Visual shield bubble
        if (this.shieldSprite?.active) this.shieldSprite.destroy();
        const key = "_shield_tex";
        if (!this.textures.exists(key)) {
          const g = this.make.graphics({ add: false });
          g.lineStyle(2, 0x40ffa0, 0.6);
          g.strokeCircle(30, 30, 28);
          g.fillStyle(0x40ffa0, 0.15);
          g.fillCircle(30, 30, 28);
          g.generateTexture(key, 60, 60); g.destroy();
        }
        this.shieldSprite = this.add.sprite(caster.sprite.x, caster.sprite.y, key);
        this.time.delayedCall(beh.lifetimeMs, () => {
          this.shieldActive = false;
          if (this.shieldSprite?.active) this.shieldSprite.destroy();
        });
      }
      return;
    }

    const seed = evt.seed ?? 1;
    const rnd = prng(seed);
    const baseAngle = Math.atan2(evt.aimDir?.y ?? 0, evt.aimDir?.x ?? 1);

    for (let i = 0; i < (beh.count ?? 1); i++) {
      const spread = Phaser.Math.DegToRad((beh.spreadDeg ?? 0) * ((i - (beh.count - 1) / 2)));
      const jitter = (rnd() - 0.5) * Phaser.Math.DegToRad((beh.spreadDeg ?? 0) * 0.35);
      const ang = baseAngle + spread + jitter;
      const vx = Math.cos(ang) * beh.speed;
      const vy = Math.sin(ang) * beh.speed;

      // Use image-based projectiles if available
      const projTexMap = { spark: "proj-spark", wagalona: "proj-wagalona", zephyra: "proj-zephyra" };
      let proj;
      const texKey = projTexMap[spellId];
      if (texKey && this.textures.exists(texKey)) {
        proj = this.physics.add.sprite(caster.sprite.x, caster.sprite.y, texKey);
        const scale = (beh.radius ?? 6) / 16;
        proj.setScale(scale);
      } else {
        const r = beh.radius ?? 6;
        const key = `proj_${spellId}_${r}`;
        if (!this.textures.exists(key)) {
          const g = this.make.graphics({ add: false });
          g.fillStyle(color); g.fillCircle(r, r, r);
          g.generateTexture(key, r * 2, r * 2); g.destroy();
        }
        proj = this.physics.add.sprite(caster.sprite.x, caster.sprite.y, key);
      }

      proj.body.setAllowGravity(false);
      proj.setVelocity(vx, vy);
      this.projectiles.add(proj);

      this.time.delayedCall(beh.lifetimeMs ?? 800, () => {
        if (proj?.active) proj.destroy();
      });
    }
  }
}
