import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// stdio サーバーを1つのファイルにまとめる。SDK と zod は依存のまま残し、データは data/ に写す。
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  build: {
    ssr: here("src/server.ts"),
    outDir: here("dist"),
    emptyOutDir: true,
    target: "node20",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: [/^@modelcontextprotocol\//, /^zod/, /^node:/],
      output: { entryFileNames: "server.mjs", format: "es" },
    },
  },
  plugins: [
    {
      name: "copy-data",
      closeBundle() {
        mkdirSync(here("data"), { recursive: true });
        copyFileSync(here("../public/data/furusato.json"), here("data/furusato.json"));
      },
    },
  ],
});
