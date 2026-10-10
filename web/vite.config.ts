import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // shared is TypeScript source; let Vite compile it instead of pre-bundling
  optimizeDeps: { exclude: ["@pocketed/shared"] },
  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:8787",
      "/v1": "http://127.0.0.1:8787",
    },
  },
  preview: { host: true, allowedHosts: true },
});
