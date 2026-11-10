import { preview } from "vite";
import { createStaticHost } from "../static-host.mjs";

// Serve the production host and assets; Vite supplies only the local API/WS proxy.
const serve = createStaticHost();
await preview({
  mode: "production",
  preview: {
    host: "127.0.0.1",
    port: Number(process.env.PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT),
    strictPort: true,
    proxy: {
      "/v0": {
        target: `http://127.0.0.1:${process.env.PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT}`,
        changeOrigin: true,
        ws: true,
      },
      "/document-collaboration": {
        target: `http://127.0.0.1:${process.env.PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  plugins: [
    {
      name: "room-startup-production-host",
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          if (
            /^\/(v0|document-collaboration)(?:\/|\?|$)/.test(request.url ?? "")
          ) {
            next();
          } else {
            void serve(request, response);
          }
        });
      },
    },
  ],
});
