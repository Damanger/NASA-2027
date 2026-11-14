import { defineConfig } from "astro/config";
import node from "@astrojs/node";

// Server output is required: the /api routes proxy IRSA (which sends no CORS
// headers) and convert SPHEREx FITS cutouts into compact binary frames.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: { host: true, port: 4321 },
  devToolbar: { enabled: false },
});
