import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://onourimpram.github.io",
  base: "/vocation-os",
  srcDir: "./site",
  publicDir: "./assets",
  outDir: "./site-dist",
  output: "static"
});
