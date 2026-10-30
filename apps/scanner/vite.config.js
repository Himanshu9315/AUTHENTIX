import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the browser talks to Vite, which forwards /api to the gateway. The camera needs a secure context:
// http://localhost works, a phone on the LAN needs HTTPS.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": process.env.VITE_API_TARGET ?? "http://localhost:3000" } },
  build: { rollupOptions: { external: [] } },
});
