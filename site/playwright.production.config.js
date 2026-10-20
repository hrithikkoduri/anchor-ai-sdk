import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: ["**/tests/*.spec.js", "**/production-tests/*.spec.js"],
  use: { ...base.use, baseURL: "http://localhost:4174" },
  webServer: {
    command: "npm run preview -- --port 4174 --strictPort",
    url: "http://localhost:4174",
    reuseExistingServer: !process.env.CI,
  },
});
