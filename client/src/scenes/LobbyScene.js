import Phaser from "phaser";
import { connectSocket } from "../net/socket.js";
import { speak } from "../ui/tts.js";

const MAX_LOADOUT = 3;

function elementColor(spell) {
  const el = String(spell?.element || spell?.kind || "arcane").toLowerCase();
  if (el.includes("fire") || el.includes("sun") || el.includes("magma")) return "#ff6b6b";
  if (el.includes("water")) return "#53d0ff";
  if (el.includes("ice")) return "#a7f3ff";
  if (el.includes("wind")) return "#7dd3fc";
  if (el.includes("rock") || el.includes("stone")) return "#d6a87a";
  if (el.includes("poison") || el.includes("gas")) return "#6dff9a";
  if (el.includes("void")) return "#c084fc";
  return "#bfe9ff";
}

function spellSummary(id, s) {
  const kind = String(s.kind || "projectile");
  const cd = Number(s.cooldown ?? 0).toFixed(1);
  const mp = Number(s.manaCost ?? 0);
  let core = "";
  if (kind === "heal") core = `HEAL ${s.heal ?? 0}`;
  else if (kind === "block") core = `BLOCK ${(s.blockMs ?? 0)/1000}s`;
  else if (kind === "shield") core = `SHIELD ${(s.durationMs ?? 0)/1000}s`;
  else core = `DMG ${s.damage ?? 0}`;
  const extra = [];
  if (s.delayMs) extra.push(`charge ${(s.delayMs/1000).toFixed(1)}s`);
  if (s.ticks || s.hits) extra.push(`x${s.ticks ?? s.hits}`);
  if (s.stunMs) extra.push(`stun ${(s.stunMs/1000).toFixed(1)}s`);
  return `${kind.toUpperCase()} · CD ${cd}s · MP ${mp} · ${core}${extra.length ? " · " + extra.join(" · ") : ""}`;
}

export class LobbyScene extends Phaser.Scene {
  constructor() { super("Lobby"); }

  async create() {
    // Lobby is mostly DOM-based; keep camera sizing safe (scene can be shutdown while resize still fires).
    const applyCamera = (w = this.scale.width, h = this.scale.height) => {
      const cam = this.cameras?.main;
      if (!cam) return;
      // With FIT scaling, keep a stable 1280x720 camera.
      if (typeof cam.setViewport === "function") cam.setViewport(0, 0, 1280, 720);
      cam.setZoom(1);
      cam.centerOn(640, 360);
    };
    const onResize = (gs) => applyCamera(gs.width, gs.height);
    applyCamera();
    this.scale.on("resize", onResize);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.scale.off("resize", onResize));
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.scale.off("resize", onResize));


    this.add.text(24, 24, "Voice-Cast Wizard Duel", { fontSize: "18px", color: "#6ee7ff" });
    this.add.text(24, 50, "Use the overlay to Create/Join a room.", { fontSize: "13px", color: "#aaa" });

    const overlay = document.getElementById("lobbyOverlay");
    const loadoutOverlay = document.getElementById("loadoutOverlay");
    const loadoutRoom = document.getElementById("loadoutRoom");
    const spellList = document.getElementById("spellList");
    const spellSearch = document.getElementById("spellSearch");
    const loadoutHint = document.getElementById("loadoutHint");
    const loadoutContinueBtn = document.getElementById("loadoutContinueBtn");

    const nameInput = document.getElementById("nameInput");
    const roomInput = document.getElementById("roomInput");
    const serverInput = document.getElementById("serverInput");
    const errBox = document.getElementById("errBox");
    const createBtn = document.getElementById("createBtn");
    const joinBtn = document.getElementById("joinBtn");

    const defaultServer = () => "";
    if (serverInput && !serverInput.placeholder) serverInput.placeholder = "(leave blank for same-origin)";
    serverInput.value = serverInput.value || defaultServer();

    const setErr = (msg) => { if (errBox) errBox.textContent = msg || ""; };

    // load spells + keywords (for pronunciation button)
    let spells = {};
    let keywords = {};
    try {
      const [spellsRes, kwRes] = await Promise.all([fetch("/data/spells.json"), fetch("/data/keywords.json")]);
      spells = await spellsRes.json();
      keywords = await kwRes.json();
    } catch {}

    const spellRows = Object.entries(spells)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a,b) => a.id.localeCompare(b.id));

    const updateHint = (sel) => {
      if (!loadoutHint) return;
      loadoutHint.textContent = sel.length === MAX_LOADOUT
        ? "Looks good. Hit Continue."
        : `Pick exactly ${MAX_LOADOUT} spells. (${sel.length}/${MAX_LOADOUT})`;
    };

    const renderSpellList = (sel) => {
      if (!spellList) return;
      const q = (spellSearch?.value || "").trim().toLowerCase();
      spellList.innerHTML = "";
      for (const s of spellRows) {
        if (q && !s.id.includes(q)) continue;

        const color = elementColor(s);

        const row = document.createElement("div");
        row.style.cssText = "display:flex; gap:10px; align-items:center; padding:8px 10px; border:1px solid rgba(255,255,255,0.10); border-radius:6px; background:rgba(0,0,0,0.20);";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = sel.includes(s.id);
        cb.style.cssText = "width:18px; height:18px; accent-color:" + color;

        const info = document.createElement("div");
        info.style.flex = "1";
        info.innerHTML = `
          <div style="font-weight:800; letter-spacing:0.2px; color:${color}">${s.id}</div>
          <div style="font-size:11px; opacity:0.85; margin-top:2px;">${spellSummary(s.id, s)}</div>
        `;

        const play = document.createElement("button");
        play.textContent = "▶";
        play.title = "Speak incantation";
        play.style.cssText = "width:40px; height:40px; font-size:16px; padding:0; text-align:center;";
        play.onclick = () => speak((keywords?.[s.id]?.incantation) || s.id);

        cb.onchange = () => {
          const next = new Set(sel);
          if (cb.checked) next.add(s.id); else next.delete(s.id);
          const arr = [...next];
          if (arr.length > MAX_LOADOUT) { cb.checked = false; return; }
          sel.length = 0; sel.push(...arr);
          updateHint(sel);
          renderSpellList(sel);
        };

        row.appendChild(cb);
        row.appendChild(info);
        row.appendChild(play);
        spellList.appendChild(row);
      }
    };

    if (spellSearch) {
      spellSearch.oninput = () => {
        const sess = (() => { try { return JSON.parse(localStorage.getItem("wizardSession") || "null"); } catch { return null; } })();
        const selected = [...(sess?.loadout || ["spark","wagalona","zephyra"])];
        renderSpellList(selected);
      };
    }

    const handleJoined = (_socket, { roomCode, playerId, reconnectToken }) => {
      const prev = (() => { try { return JSON.parse(localStorage.getItem("wizardSession") || "null"); } catch { return null; } })();
      const session = {
        roomCode,
        name: nameInput.value?.trim() || prev?.name || "Wizard",
        reconnectToken,
        serverUrl: serverInput.value?.trim() || prev?.serverUrl || defaultServer(),
        loadout: prev?.loadout || ["spark","wagalona","zephyra"],
      };
      localStorage.setItem("wizardSession", JSON.stringify(session));

      overlay.style.display = "none";
      if (!loadoutOverlay) {
        this.scene.start("Game", { roomCode, playerId, loadout: session.loadout });
        return;
      }

      loadoutOverlay.style.display = "flex";
      if (loadoutRoom) loadoutRoom.textContent = `Room: ${roomCode}`;
      const selected = [...(session.loadout || [])].slice(0, MAX_LOADOUT);
      updateHint(selected);
      renderSpellList(selected);

      loadoutContinueBtn.onclick = () => {
        if (selected.length !== MAX_LOADOUT) return;
        const next = { ...session, loadout: selected };
        localStorage.setItem("wizardSession", JSON.stringify(next));
        loadoutOverlay.style.display = "none";
        this.scene.start("Game", { roomCode, playerId, loadout: selected });
      };
    };

    // Auto-reconnect
    const sessRaw = localStorage.getItem("wizardSession");
    if (sessRaw) {
      try {
        const sess = JSON.parse(sessRaw);
        if (sess?.serverUrl) serverInput.value = sess.serverUrl;
        if (sess?.name) nameInput.value = sess.name;
        const socket = connectSocket(serverInput.value?.trim() || defaultServer());
        socket.on("connect_error", () => setErr("Cannot reach server."));
        socket.on("room:error", ({ reason }) => {
          const r = String(reason || "");
          // Common case after server restart: clear stale reconnect token so the UI looks clean.
          if (r.toLowerCase().includes("reconnect token")) {
            localStorage.removeItem("wizardSession");
            setErr("Session expired. Please Create/Join again.");
            return;
          }
          setErr(r);
        });
        socket.on("room:joined", (data) => handleJoined(socket, data));
        if (sess?.roomCode && sess?.reconnectToken) {
          socket.emit("room:reconnect", { roomCode: sess.roomCode, reconnectToken: sess.reconnectToken, name: sess.name || nameInput.value?.trim() || "Wizard" });
        }
      } catch {}
    }

    const connect = () => {
      const url = serverInput.value?.trim() || defaultServer();
      const socket = connectSocket(url);
      socket.on("connect_error", () => setErr("Cannot reach server. Check URL / firewall."));
      socket.on("room:error", ({ reason }) => {
        const r = String(reason || "");
        if (r.toLowerCase().includes("reconnect token")) {
          localStorage.removeItem("wizardSession");
          setErr("Session expired. Please Create/Join again.");
          return;
        }
        setErr(r);
      });
      socket.on("room:joined", (data) => handleJoined(socket, data));
      return socket;
    };

    createBtn.onclick = () => { setErr(""); connect().emit("room:create", { name: nameInput.value?.trim() || "Wizard" }); };
    joinBtn.onclick = () => { setErr(""); connect().emit("room:join", { roomCode: roomInput.value?.trim(), name: nameInput.value?.trim() || "Wizard" }); };
  }
}
