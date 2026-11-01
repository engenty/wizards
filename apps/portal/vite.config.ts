import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// The SPA under /portal; in development the portal server answers /portal/api and /portal/auth.
export default defineConfig({
  base: "/portal/",
  plugins: [react()],
  resolve: {
    // "wizards-source": the shared packages are read as TypeScript, no build of them needed.
    conditions: ["wizards-source", ...defaultClientConditions],
  },
  server: {
    port: Number(process.env.PORTAL_WEB_PORT || 5190),
    host: "127.0.0.1",
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/portal/api": { target: `http://127.0.0.1:${process.env.PORTAL_PORT || 8893}`, xfwd: true },
      "/portal/auth": { target: `http://127.0.0.1:${process.env.PORTAL_PORT || 8893}`, xfwd: true },
    },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
});
