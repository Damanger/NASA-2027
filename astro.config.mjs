import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import vercel from "@astrojs/vercel";

// Server output is required: the /api routes proxy IRSA (which sends no CORS
// headers) and convert SPHEREx FITS cutouts into compact binary frames.
// On Vercel the build uses the Vercel adapter (serverless functions); everywhere
// else (local dev, `npm start`, Docker, a VPS) it uses the standalone Node server.
const onVercel = Boolean(process.env.VERCEL);

export default defineConfig({
  output: "server",
  adapter: onVercel ? vercel({ maxDuration: 60 }) : node({ mode: "standalone" }),
  server: { host: true, port: 4321 },
  devToolbar: { enabled: false },
});
