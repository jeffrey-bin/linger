import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    rollupOptions: {
      input: fileURLToPath(
        new URL("./mermaid-preview-runtime.html", import.meta.url),
      ),
    },
  },
  publicDir: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  root: appRoot,
});
