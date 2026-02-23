import Phaser from "phaser";
import { LobbyScene } from "./scenes/LobbyScene.js";
import { GameScene } from "./scenes/GameScene.js";

const config = {
  type: Phaser.AUTO,
  parent: "game",
  width: 640,
  height: 400,
  backgroundColor: "#0b0f14",
  physics: {
    default: "arcade",
    arcade: { debug: false }
  },
  scene: [LobbyScene, GameScene],
};

new Phaser.Game(config);
