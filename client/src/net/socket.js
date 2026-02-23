import { io } from "socket.io-client";

let socket = null;

export function connectSocket(serverUrl) {
  if (socket) socket.disconnect();

  // IMPORTANT:
  // If the page is served over HTTPS (e.g. https://192.168.x.x:5173),
  // connecting to an explicit http://...:3001 will cause the browser to try
  // wss://...:3001 and fail unless your server also speaks TLS.
  // Prefer SAME-ORIGIN by default (io() with no URL) and use Vite's proxy
  // to forward /socket.io to your HTTP server.
  const url = (typeof serverUrl === "string" && serverUrl.trim()) ? serverUrl.trim() : undefined;

  socket = url ? io(url, {
    transports: ["websocket"],
    timeout: 8000,
  }) : io({
    transports: ["websocket"],
    timeout: 8000,
  });

  return socket;
}

export function getSocket() {
  if (!socket) throw new Error("Socket not connected yet");
  return socket;
}
