import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 43118,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:43117",
        changeOrigin: false
      }
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 43119,
    strictPort: false
  },
  build: {
    outDir: "dist/workbench",
    emptyOutDir: false,
    sourcemap: true
  }
});
