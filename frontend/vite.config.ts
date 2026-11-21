import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "../custom_components/outglow/frontend",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    minify: true,
    lib: {
      entry: {
        "outglow-panel": "src/outglow-panel.ts",
        "outglow-cards": "src/outglow-cards.ts",
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
  },
});
