// Spec: knowledge/components/aeion-engine.md

import { app } from "./app.ts";
import { stopLoopbackRelayServer } from "./relay/context-relay.ts";

const port = Number(process.env.AEION_API_PORT || 4171);

// Elysia shares the port by default; a second instance must fail instead of silently splitting traffic.
const server = app.listen({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 255,
  reusePort: false,
});

console.log(
  `[aeion-spec] Elysia API listening on http://127.0.0.1:${server.server?.port ?? port}`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopLoopbackRelayServer();
    process.exit(0);
  });
}
