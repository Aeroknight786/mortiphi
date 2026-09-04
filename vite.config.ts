import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  build: { outDir: "dist/client", emptyOutDir: true },
  server: { host: "127.0.0.1", strictPort: true },
});
