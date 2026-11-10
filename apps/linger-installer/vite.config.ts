import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", emptyOutDir: true },
  server: { host: "127.0.0.1" },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"] },
});
