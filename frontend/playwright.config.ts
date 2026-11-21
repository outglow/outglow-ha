import { defineConfig } from "@playwright/test";

const port = Number(process.env.PW_PORT ?? 5174);

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/../../docs/images/{arg}{ext}",
  timeout: 90_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    deviceScaleFactor: 1,
  },
  projects: [
    { name: "chrome", use: { channel: process.env.PW_CHANNEL ?? "chrome" } },
    { name: "webkit", use: { browserName: "webkit" }, testMatch: /(plan-focus|sheet-focus)\.spec\.ts/ },
  ],
  webServer: {
    command: `npx vite --config vite.mock.config.ts --port ${port} --strictPort`,
    port,
    reuseExistingServer: true,
  },
});
