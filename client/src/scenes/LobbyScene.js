import Phaser from "phaser";
import { connectSocket } from "../net/socket.js";
import { speak } from "../ui/tts.js";

export class LobbyScene extends Phaser.Scene {
  constructor() { super("Lobby"); }

  create() {
    this.add.text(24, 24, "Voice-Cast Wizard Duel", { fontSize: "18px", color: "#6ee7ff" });
    this.add.text(24, 50, "Use the overlay to Create/Join a room.", { fontSize: "13px", color: "#aaa" });

    const overlay = document.getElementById("lobbyOverlay");
    const loadoutOverlay = document.getElementById("loadoutOverlay");
    const loadoutRoom = document.getElementById("loadoutRoom");
    const spellList = document.getElementById("spellList");
    const loadoutHint = document.getElementById("loadoutHint");
    const loadoutContinueBtn = document.getElementById("loadoutContinueBtn");

    const AVAILABLE_SPELLS = [
      { id: "spark",    name: "Spark",    incantation: "spark",    guide: "spark (quick)", desc: "Fast bolt, low damage", color: "#ffee58" },
      { id: "wagalona", name: "Wagalona", incantation: "wagalona", guide: "wah-guh-LOH-nuh", desc: "Powerful fire blast", color: "#ff5252" },
      { id: "zephyra",  name: "Zephyra",  incantation: "zephyra",  guide: "ZEF-ear-uh", desc: "Twin wind shards", color: "#40c4ff" },
      { id: "vortium",  name: "Vortium",  incantation: "vortium",  guide: "VOR-tee-um", desc: "Devastating void burst", color: "#b040ff" },
      { id: "shieldra", name: "Shieldra", incantation: "shieldra", guide: "SHEEL-druh", desc: "Blocks next hit (3s)", color: "#40ffa0" },
    ];

    const MAX_LOADOUT = 3;

    function updateHint(sel) {
      if (!loadoutHint) return;
      loadoutHint.textContent = sel.length === MAX_LOADOUT
        ? "Looks good. Hit Continue." : `Pick exactly ${MAX_LOADOUT} spells. (${sel.length}/${MAX_LOADOUT})`;
    }

    function renderSpellList(sel) {
      if (!spellList) return;
      spellList.innerHTML = "";
      for (const s of AVAILABLE_SPELLS) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex; gap:10px; align-items:center; padding:6px 8px; border:1px solid rgba(255,255,255,0.08); border-radius:3px; background:rgba(255,255,255,0.02);";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = sel.includes(s.id);
        cb.style.cssText = "width:18px; height:18px; accent-color:" + s.color;
        cb.onchange = () => {
          const next = new Set(sel);
          if (cb.checked) next.add(s.id); else next.delete(s.id);
          const arr = [...next];
          if (arr.length > MAX_LOADOUT) { cb.checked = false; return; }
          sel.length = 0; sel.push(...arr);
          updateHint(sel); renderSpellList(sel);
        };

        const info = document.createElement("div");
        info.style.flex = "1";
        info.innerHTML = `<div style="font-weight:700; color:${s.color}">${s.name}</div>
          <div style="font-size:11px; opacity:0.7">${s.incantation} · ${s.guide}</div>
          <div style="font-size:10px; opacity:0.5">${s.desc}</div>`;

        const play = document.createElement("button");
        play.textContent = "▶";
        play.style.cssText = "width:36px; height:36px; font-size:16px; padding:0; text-align:center;";
        play.onclick = () => speak(s.incantation);

        row.appendChild(cb);
        row.appendChild(info);
        row.appendChild(play);
        spellList.appendChild(row);
      }
    }

    const nameInput = document.getElementById("nameInput");
    const roomInput = document.getElementById("roomInput");
    const serverInput = document.getElementById("serverInput");
    const errBox = document.getElementById("errBox");
    const createBtn = document.getElementById("createBtn");
    const joinBtn = document.getElementById("joinBtn");

    // Leave blank to connect same-origin (recommended for HTTPS + Vite proxy).
    // This avoids the browser attempting wss://<ip>:3001 when the page is HTTPS.
    const defaultServer = () => "";
    if (serverInput && !serverInput.placeholder) {
      serverInput.placeholder = "(leave blank for same-origin)";
    }
    serverInput.value = serverInput.value || defaultServer();

    const handleJoined = (socket, { roomCode, playerId, reconnectToken }) => {
      const prev = (() => { try { return JSON.parse(localStorage.getItem("wizardSession") || "null"); } catch { return null; } })();
      const session = {
        roomCode, name: nameInput.value?.trim() || prev?.name || "Wizard",
        reconnectToken, serverUrl: serverInput.value?.trim() || prev?.serverUrl || defaultServer(),
        loadout: prev?.loadout || ["spark", "wagalona", "zephyra"],
      };
      localStorage.setItem("wizardSession", JSON.stringify(session));

      if (loadoutOverlay) {
        overlay.style.display = "none";
        loadoutOverlay.style.display = "flex";
        if (loadoutRoom) loadoutRoom.textContent = `Room: ${roomCode}`;
        const selected = [...(session.loadout || [])];
        updateHint(selected); renderSpellList(selected);

        if (loadoutContinueBtn) {
          loadoutContinueBtn.onclick = () => {
            if (selected.length !== MAX_LOADOUT) return;
            const next = { ...session, loadout: selected };
            localStorage.setItem("wizardSession", JSON.stringify(next));
            loadoutOverlay.style.display = "none";
            this.scene.start("Game", { roomCode, playerId, loadout: selected });
          };
        }
      } else {
        overlay.style.display = "none";
        this.scene.start("Game", { roomCode, playerId, loadout: session.loadout });
      }
    };

    const setErr = (msg) => { errBox.textContent = msg || ""; };

    // Auto-reconnect
    const sessRaw = localStorage.getItem("wizardSession");
    if (sessRaw) {
      try {
        const sess = JSON.parse(sessRaw);
        if (sess?.serverUrl) serverInput.value = sess.serverUrl;
        if (sess?.name) nameInput.value = sess.name;
        const socket = connectSocket(serverInput.value?.trim() || defaultServer());
        socket.on("connect_error", () => setErr("Cannot reach server."));
        socket.on("room:error", ({ reason }) => setErr(reason));
        socket.on("room:joined", (data) => handleJoined(socket, data));
        if (sess?.roomCode && sess?.reconnectToken) {
          socket.emit("room:reconnect", {
            roomCode: sess.roomCode, reconnectToken: sess.reconnectToken,
            name: sess.name || nameInput.value?.trim() || "Wizard",
          });
        }
      } catch {}
    }

    const connect = () => {
      const url = serverInput.value?.trim() || defaultServer();
      const socket = connectSocket(url);
      socket.on("connect_error", () => setErr("Cannot reach server. Check URL / firewall."));
      socket.on("room:error", ({ reason }) => setErr(reason));
      socket.on("room:joined", (data) => handleJoined(socket, data));
      return socket;
    };

    createBtn.onclick = () => { setErr(""); connect().emit("room:create", { name: nameInput.value?.trim() || "Wizard" }); };
    joinBtn.onclick = () => { setErr(""); connect().emit("room:join", { roomCode: roomInput.value?.trim(), name: nameInput.value?.trim() || "Wizard" }); };
  }
}
