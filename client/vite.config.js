import { defineConfig } from "vite";
import fs from "node:fs";

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    https: {
      key: fs.readFileSync("./key.pem"),
      cert: fs.readFileSync("./cert.pem"),
    },
    proxy: {
      "/socket.io": {
        target: "http://127.0.0.1:3001",
        ws: true,
      },
      // ❌ 删掉 /data 的 proxy！！
      // "/data": { target: "http://127.0.0.1:3001" },
    },
  },
});