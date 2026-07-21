import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

function apiOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("API_SERVER_URL must use HTTPS, except on an explicit loopback host");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("API_SERVER_URL must be an origin without a path, credentials, query, or fragment");
  }
  return url.origin;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = apiOrigin(env.API_SERVER_URL ?? "https://api.stingle.org");
  return {
  plugins: [
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/media",
      filename: "service-worker.ts",
      injectRegister: false,
      injectManifest: {
        injectionPoint: undefined,
        // virtual:pwa-register installs a classic service worker in production.
        // Keep the generated bundle classic too: the default ES output can retain
        // `import.meta` from libsodium, which makes classic-worker installation fail.
        rollupFormat: "iife",
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
      manifest: {
        name: "Stingle Photos",
        short_name: "Stingle",
        description: "End-to-end encrypted photo and video storage",
        theme_color: "#15161a",
        background_color: "#15161a",
        display: "standalone",
        icons: [{
          src: "/icons/stingle-logo-720.png",
          sizes: "720x720",
          type: "image/png",
          purpose: "any maskable",
        }],
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/u, ""),
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  worker: {
    format: "es",
  },
  };
});
