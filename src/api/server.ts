import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";

import { openLedger } from "../core/db.js";
import { createSheetsGateway } from "../lib/google/sheets.js";
import { buildApp } from "./app.js";

/**
 * Starts the HTTP API and, when the built frontend exists (FRONTEND_DIST), serves it from the same port.
 *   Development: `npm run api` here and `npm run dev` in the frontend repo (Vite proxies /api to this port).
 *   Production:  `npm run build` in the frontend repo once, then `npm run api` here; open http://localhost:8787.
 */
const port = Number(process.env.API_PORT ?? 8787);
const host = process.env.API_HOST ?? "127.0.0.1";

const ledger = openLedger();
const app = await buildApp({ gw: () => createSheetsGateway(), ledger });

const dist = resolve(process.cwd(), process.env.FRONTEND_DIST ?? "../LinkedIn-MCP-Engine-Frontend/dist");
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

const stop = () => { ledger.close(); app.close().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await app.listen({ port, host });
console.log(`API on http://${host}:${port}${existsSync(dist) ? " (serving the built frontend)" : " (frontend: run `npm run dev` in the frontend repo)"}`);
