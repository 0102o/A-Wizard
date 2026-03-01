import Phaser from "phaser";
import { LobbyScene } from "./scenes/LobbyScene.js";
import { GameScene } from "./scenes/GameScene.js";

const config = {
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#0b0f14",
  physics: {
    default: "arcade",
    arcade: { debug: false }
  },
  scale: {
    // FIT keeps a stable 1280x720 world across different screens (no drifting).
    // Any letterbox is filled by the page background.
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1280,
    height: 720,
  },
  scene: [LobbyScene, GameScene],
};

new Phaser.Game(config);
