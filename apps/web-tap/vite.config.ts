import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/tap/",
  plugins: [react()],
  build: { outDir: "../web/dist/tap", emptyOutDir: true },
  server: { proxy: {
    "/api": "http://127.0.0.1:8787",
    "/ws": { target: "ws://127.0.0.1:8787", ws: true },
  } },
});
