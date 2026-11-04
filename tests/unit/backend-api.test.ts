import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SheetsGateway, SheetTabInfo } from "../../src/core/exporter.js";
import { PIPELINE_HEADERS, QUARANTINED_HEADERS } from "../../src/core/exporter.js";
import { openLedger } from "../../src/core/db.js";
import { buildApp } from "../../src/api/app.js";
import { parseSignal, whyText } from "../../src/api/services/sheet-rows.js";

function fakeSheets(initial: Record<string, string[][]> = {}) {
  const tabs = new Map<string, { id: number; rows: string[][] }>();
  let nextId = 1;
  const stats = { reads: 0 };
  for (const [t, rows] of Object.entries(initial)) tabs.set(t, { id: nextId++, rows });
  const idx = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range: string) => {
    const [tab, a = ""] = range.split("!");
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a)!;
    return { tab: tab!, c1: idx(m[1]!), r1: m[2] ? Number(m[2]) - 1 : 0, c2: m[3] ? idx(m[3]) : undefined, r2: m[4] ? Number(m[4]) - 1 : undefined };
  };
  const gw: SheetsGateway = {
    async listTabs(): Promise<SheetTabInfo[]> { return [...tabs].map(([title, t]) => ({ title, sheetId: t.id })); },
    async addTabs(titles) { return titles.map((title) => { const t = { id: nextId++, rows: [] as string[][] }; tabs.set(title, t); return { title, sheetId: t.id }; }); },
    async batchUpdate() {},
    async getValues(range) {
      stats.reads++;
      const p = parse(range); const rows = tabs.get(p.tab)?.rows ?? [];
      return rows.slice(p.r1, p.r2 === undefined ? undefined : p.r2 + 1).map((r) => r.slice(p.c1, p.c2 === undefined ? p.c1 + 1 : p.c2 + 1)).filter((r) => r.length > 0);
    },
    async writeValues(range, values) { const p = parse(range); const t = tabs.get(p.tab)!; values.forEach((row, i) => { const r = (t.rows[p.r1 + i] ??= []); row.forEach((v, j) => { r[p.c1 + j] = v; }); }); },
    async appendValues(range, values) { tabs.get(parse(range).tab)!.rows.push(...values.map((v) => [...v])); },
  };
  return { gw, tabs, stats };
}

const H = [...PIPELINE_HEADERS];
const row = (o: Partial<Record<(typeof PIPELINE_HEADERS)[number], string>>) => H.map((h) => o[h] ?? "");

describe("API", () => {
  let app: FastifyInstance; let tabs: Map<string, { rows: string[][] }>; let stats: { reads: number };
  beforeAll(async () => {
    const f = fakeSheets({
      Jobs_Pipeline: [H,
        row({ Company: "Buckeye Logistics", Domain: "buckeyelogistics.com", Name: "Maria Lopez", Title: "CTO", Email: "m.lopez@buckeyelogistics.com", Research: "HIRING: Senior Java Developer (posted 2026-11-01) https://www.linkedin.com/posts/x | Grew 20%", Status: "Ready for Review", Subject: "Your Java opening", DraftBody: "Hi Maria,\n\nbody" }),
        row({ Company: "Awe Interactive", Name: "Sam Ortiz", Email: "sam@aweinteractive.com", Status: "Sent", Subject: "s", DraftBody: "b", ThreadID: "t1" }),
      ],
      Pipeline: [H, row({ Company: "NOW CFO", Name: "Amy Farrow", Email: "afarrow@nowcfo.com", Status: "Meeting Booked", Subject: "s", DraftBody: "b" })],
      Jobs_Quarantine: [[...QUARANTINED_HEADERS], ["Miami Valley Care", "mvcare.org", "Dana Kim", "Director of Nursing", "", "Dayton, OH", "1", "MISSING_EMAIL", "Jobs", "jobs-1", "job-1"]],
    });
    tabs = f.tabs; stats = f.stats;
    app = await buildApp({ gw: () => f.gw, ledger: openLedger(":memory:"), env: { API_TOKEN: "secret" } });
  });
  afterAll(async () => { await app.close(); });

  const auth = { authorization: "Bearer secret" };

  it("health needs no token; everything else does", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/pipeline" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/pipeline", headers: auth })).statusCode).toBe(200);
  });

  it("lists rows from both tabs with the hiring signal parsed", async () => {
    const r = (await app.inject({ method: "GET", url: "/api/pipeline", headers: auth })).json();
    expect(r.rows).toHaveLength(3);
    const maria = r.rows.find((x: { email: string }) => x.email === "m.lopez@buckeyelogistics.com");
    expect(maria.tab).toBe("Jobs_Pipeline");
    expect(maria.signal).toEqual({ role: "Senior Java Developer", posted: "2026-11-01", url: "https://www.linkedin.com/posts/x" });
    const only = (await app.inject({ method: "GET", url: "/api/pipeline?tab=Pipeline", headers: auth })).json();
    expect(only.rows.map((x: { name: string }) => x.name)).toEqual(["Amy Farrow"]);
  });

  it("explains left-out rows in plain words", async () => {
    const r = (await app.inject({ method: "GET", url: "/api/pipeline/left-out", headers: auth })).json();
    expect(r.rows[0]).toMatchObject({ company: "Miami Valley Care", reason: "MISSING_EMAIL", why: "No email could be found for this person." });
  });

  it("approves only a Ready for Review row, edits the draft, and refuses the wrong moves", async () => {
    const edit = await app.inject({ method: "PATCH", url: "/api/pipeline/m.lopez@buckeyelogistics.com/draft", headers: auth, payload: { subject: "New subject" } });
    expect(edit.statusCode).toBe(200);
    expect(tabs.get("Jobs_Pipeline")!.rows[1]![H.indexOf("Subject")]).toBe("New subject");

    const ok = await app.inject({ method: "POST", url: "/api/pipeline/m.lopez@buckeyelogistics.com/approve", headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(tabs.get("Jobs_Pipeline")!.rows[1]![H.indexOf("Status")]).toBe("Approved");

    const sent = await app.inject({ method: "POST", url: "/api/pipeline/sam@aweinteractive.com/approve", headers: auth });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error).toMatch(/Cannot move "Sent"/);

    const missing = await app.inject({ method: "POST", url: "/api/pipeline/nobody@x.com/approve", headers: auth });
    expect(missing.statusCode).toBe(404);

    const undo = await app.inject({ method: "POST", url: "/api/pipeline/m.lopez@buckeyelogistics.com/reopen", headers: auth });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().status).toBe("Ready for Review");
  });

  it("summarises statuses and reasons", async () => {
    const r = (await app.inject({ method: "GET", url: "/api/pipeline/summary?fresh=1", headers: auth })).json();
    expect(r.by_status["Sent"]).toBe(1);
    expect(r.quarantined).toBe(1);
    expect(r.by_reason["MISSING_EMAIL"]).toBe(1);
  });

  it("creates the Config tab on first read and writes known settings only", async () => {
    const g = (await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json();
    expect(g.values.DryRun).toBe("TRUE");
    expect(tabs.has("Config")).toBe(true);
    const p = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { DryRun: false, DailySendCap: 12 } });
    expect(p.json().values).toMatchObject({ DryRun: "FALSE", DailySendCap: "12" });
    const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { Nonsense: "x" } });
    expect(bad.statusCode).toBe(400);
  });

  it("lists and creates campaigns through the Campaigns tab", async () => {
    const c = await app.inject({ method: "POST", url: "/api/campaigns", headers: auth, payload: { name: "KY CFOs", mode: "CORPORATE", titles: ["CFO"], states: ["Kentucky"], offer: "a 15-minute call about claims review", sender_company: "One Smarter" } });
    expect(c.statusCode).toBe(200);
    const l = (await app.inject({ method: "GET", url: "/api/campaigns", headers: auth })).json();
    expect(l.campaigns.map((x: { name: string }) => x.name)).toContain("KY CFOs");
    const on = await app.inject({ method: "POST", url: "/api/campaigns/KY%20CFOs/active", headers: auth, payload: { active: true } });
    expect(on.json()).toEqual({ name: "KY CFOs", active: true });
  });

  it("serves repeat campaign reads from cache, and a change shows at once", async () => {
    await app.inject({ method: "GET", url: "/api/campaigns", headers: auth });
    await app.inject({ method: "GET", url: "/api/campaigns/KY%20CFOs", headers: auth });
    const before = stats.reads;
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "GET", url: "/api/campaigns", headers: auth });
      await app.inject({ method: "GET", url: "/api/campaigns/KY%20CFOs", headers: auth });
    }
    expect(stats.reads).toBe(before);
    await app.inject({ method: "POST", url: "/api/campaigns/KY%20CFOs/active", headers: auth, payload: { active: false } });
    const l = (await app.inject({ method: "GET", url: "/api/campaigns", headers: auth })).json();
    expect(l.campaigns.find((x: { name: string }) => x.name === "KY CFOs").active).toBe(false);
  });
});

describe("helpers", () => {
  it("parses the Research cell", () => {
    expect(parseSignal("HIRING: RPG Developer https://www.linkedin.com/jobs/view/1")).toEqual({ role: "RPG Developer", url: "https://www.linkedin.com/jobs/view/1" });
    expect(parseSignal("Grew 20% last year")).toBeUndefined();
  });
  it("has words for every reason code it knows and a fallback", () => {
    expect(whyText("ROLE_ACCOUNT")).toMatch(/shared mailbox/);
    expect(whyText("SOMETHING_NEW")).toBe("something new");
  });
});
