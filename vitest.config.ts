import { defineConfig } from "vitest/config";
import { aliases } from "./aliases";

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
