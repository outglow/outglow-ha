import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repo = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: "mock",
  server: { fs: { allow: [repo] } },
});
