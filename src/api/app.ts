import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";

import type { SheetsGateway } from "../core/exporter.js";
import type { Ledger } from "../core/db.js";
import { STATUS } from "../core/exporter.js";
import { CampaignConfig, Mode, SourcingProvider } from "../config/schema.js";
import { sheetCampaignStore } from "../config/store.js";
import { readPipeline, readQuarantine, setStatus, updateDraft, summary, findByEmail, PIPELINE_TABS, type PipelineTab } from "./services/sheet-rows.js";
import { readConfig, writeConfig, CONFIG_DEFAULTS } from "./services/config-tab.js";
import * as engine from "./services/engine.js";

/**
 * The HTTP API the React frontend talks to. Every route is a thin wrapper over src/api/services, which in turn
 * call src/core. Google credentials never reach the browser; the browser only ever talks to this process.
 *
 * Auth: when API_TOKEN is set in .env, every /api request must carry `Authorization: Bearer <token>`.
 * Leave it empty on a laptop; set it on a shared server.
 */
export interface AppDeps {
  gw: () => SheetsGateway;
  ledger: Ledger;
  env?: NodeJS.ProcessEnv;
}

type HttpError = Error & { statusCode?: number };

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const env = deps.env ?? process.env;
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // ---- auth ----
  const token = env.API_TOKEN?.trim();
  app.addHook("onRequest", async (req, reply) => {
    if (!token || !req.url.startsWith("/api/") || req.url === "/api/health") return;
    const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (got !== token) return reply.code(401).send({ error: "Sign in required." });
  });

  // ---- errors in plain words ----
  app.setErrorHandler((err: HttpError & { validation?: unknown }, _req, reply) => {
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : err.validation ? 400 : 500;
    reply.code(code).send({ error: err.message });
  });

  const gw = () => deps.gw();
  const cache = new Map<string, { at: number; v: unknown }>();
  const cached = async <T,>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
    const v = await fn(); cache.set(key, { at: Date.now(), v }); return v;
  };
  const bust = () => cache.clear();

  app.get("/api/health", async () => ({ ok: true, sheet: !!env.GOOGLE_SHEET_ID, auth: !!token }));

  // ---- pipeline rows (Jobs_Pipeline + Pipeline) ----
  app.get("/api/pipeline", async (req) => {
    const q = z.object({ tab: z.enum(["Jobs_Pipeline", "Pipeline", "all"]).default("all"), status: z.string().optional(), fresh: z.coerce.boolean().optional() }).parse(req.query);
    if (q.fresh) bust();
    const tabs = q.tab === "all" ? PIPELINE_TABS : [q.tab as PipelineTab];
    const rows = await cached(`pipeline:${tabs.join()}`, 20_000, () => readPipeline(gw(), tabs));
    return { rows: q.status ? rows.filter((r) => r.status === q.status) : rows };
  });
  app.get("/api/pipeline/left-out", async () => ({ rows: await cached("quarantine", 30_000, () => readQuarantine(gw())) }));
  app.get("/api/pipeline/summary", async () => cached("summary", 20_000, () => summary(gw())));
  app.get("/api/pipeline/:email", async (req) => findByEmail(gw(), (req.params as { email: string }).email));

  app.post("/api/pipeline/:email/approve", async (req) => { const r = await setStatus(gw(), (req.params as { email: string }).email, STATUS.approved); bust(); return r; });
  app.post("/api/pipeline/:email/reject", async (req) => { const r = await setStatus(gw(), (req.params as { email: string }).email, STATUS.rejected); bust(); return r; });
  app.post("/api/pipeline/:email/reopen", async (req) => { const r = await setStatus(gw(), (req.params as { email: string }).email, STATUS.ready); bust(); return r; });
  app.patch("/api/pipeline/:email/draft", async (req) => {
    const body = z.object({ subject: z.string().max(200).optional(), body: z.string().max(5000).optional() }).parse(req.body);
    const r = await updateDraft(gw(), (req.params as { email: string }).email, body); bust(); return r;
  });

  // ---- job search ----
  app.post("/api/search", async () => engine.startSearch({ gw, ledger: deps.ledger, env }));
  app.get("/api/search", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
    return { searches: await engine.listSearches(q.limit), defaults: engine.searchDefaults };
  });
  app.get("/api/search/latest", async () => engine.getSearch_());
  app.get("/api/search/:id", async (req) => engine.getSearch_((req.params as { id: string }).id));

  // ---- campaign runs ----
  app.post("/api/runs", async (req) => {
    const b = z.object({ campaign: z.string().min(1), limit: z.number().int().min(1).max(100).default(10), export: z.boolean().default(true) }).parse(req.body);
    return engine.startRun({ gw, ledger: deps.ledger, env }, b.campaign, b.limit, b.export);
  });
  app.get("/api/runs", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
    return { runs: await engine.listRuns(q.limit) };
  });
  app.get("/api/runs/:id", async (req) => {
    const q = z.object({ bodies: z.coerce.boolean().default(false) }).parse(req.query);
    return engine.getRun((req.params as { id: string }).id, q.bodies);
  });

  // ---- campaigns (the Campaigns tab) ----
  const store = () => sheetCampaignStore(gw());
  // Cached for 30 s: the Campaigns page asks for every campaign at once, and Google allows 60 Sheet reads a minute.
  app.get("/api/campaigns", async () => ({ campaigns: await cached("campaigns", 30_000, () => store().list()) }));
  app.get("/api/campaigns/:name", async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    return cached(`campaign:${name}`, 30_000, () => store().get(name));
  });
  const CampaignBody = z.object({
    name: z.string().min(1), mode: Mode, provider: SourcingProvider.default("gemini_xray"),
    titles: z.array(z.string().min(1)).min(1), states: z.array(z.string().min(1)).min(1), keywords: z.array(z.string()).default([]),
    offer: z.string().min(10), sender_company: z.string().min(1), persona: z.string().optional(), signal_query: z.string().optional(),
    meeting_minutes: z.number().int().positive().default(15), daily_cap: z.number().int().positive().default(20), active: z.boolean().default(false),
  });
  app.post("/api/campaigns", async (req) => {
    const a = CampaignBody.parse(req.body);
    const cfg = CampaignConfig.parse({
      campaign_name: a.name, mode: a.mode, sourcing_provider: a.provider, target_geography: a.states, decision_maker_titles: a.titles,
      industry_keywords: a.keywords, offer: a.offer, sender_company: a.sender_company,
      ...(a.persona ? { outreach_persona: a.persona } : {}), ...(a.signal_query ? { signal_query: a.signal_query } : {}),
      calendar_duration_minutes: a.meeting_minutes, daily_send_cap: a.daily_cap, block_current_employer_domain: a.mode === "CANDIDATE",
    });
    const r = await store().save(cfg, { active: a.active }); bust(); return r;
  });
  app.patch("/api/campaigns/:name", async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const a = CampaignBody.partial().parse(req.body);
    const cur = await store().get(name);
    const next = CampaignConfig.parse({
      ...cur,
      campaign_name: a.name ?? cur.campaign_name, mode: a.mode ?? cur.mode, sourcing_provider: a.provider ?? cur.sourcing_provider,
      decision_maker_titles: a.titles ?? cur.decision_maker_titles, target_geography: a.states ?? cur.target_geography, industry_keywords: a.keywords ?? cur.industry_keywords,
      offer: a.offer ?? cur.offer, sender_company: a.sender_company ?? cur.sender_company,
      ...(a.persona !== undefined ? { outreach_persona: a.persona } : {}), ...(a.signal_query !== undefined ? { signal_query: a.signal_query } : {}),
      calendar_duration_minutes: a.meeting_minutes ?? cur.calendar_duration_minutes, daily_send_cap: a.daily_cap ?? cur.daily_send_cap,
    });
    const r = await store().save(next, { active: a.active }); bust(); return r;
  });
  app.post("/api/campaigns/:name/active", async (req) => {
    const b = z.object({ active: z.boolean() }).parse(req.body);
    const name = decodeURIComponent((req.params as { name: string }).name);
    await store().setActive(name, b.active); bust(); return { name, active: b.active };
  });
  app.post("/api/campaigns/validate", async () => ({ campaigns: await store().validateAll() }));

  // ---- settings (the Config tab AutoBooker reads) ----
  app.get("/api/settings", async () => ({ values: await cached("settings", 30_000, () => readConfig(gw())), fields: CONFIG_DEFAULTS.map(([key, def, help]) => ({ key, default: def, help })) }));
  app.put("/api/settings", async (req) => {
    const patch = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).parse(req.body);
    const asText = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v)]));
    const values = await writeConfig(gw(), asText); bust(); return { values };
  });

  return app;
}
