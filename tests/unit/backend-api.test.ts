import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SheetsGateway, SheetTabInfo } from "../../src/core/exporter.js";
import { PIPELINE_HEADERS, QUARANTINED_HEADERS } from "../../src/core/exporter.js";
import { openLedger } from "../../src/core/db.js";
import { buildApp, SERVER_ERROR } from "../../src/api/app.js";
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
  let app: FastifyInstance; let ledger: ReturnType<typeof openLedger>; let tabs: Map<string, { rows: string[][] }>; let stats: { reads: number };
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
    ledger = openLedger(":memory:");
    app = await buildApp({ gw: () => f.gw, ledger, env: { API_TOKEN: "secret" } });
  });
  afterAll(async () => { await app.close(); });

  const auth = { authorization: "Bearer secret" };

  it("health needs no token; everything else does", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/pipeline" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/pipeline", headers: auth })).statusCode).toBe(200);
  });

  it("adds the draft time and campaign from the ledger to each row", async () => {
    ledger.recordContact({ email: "m.lopez@buckeyelogistics.com", lead_id: "l1", full_name: "Maria Lopez", campaign: "Jobs", status: "EXPORTED" });
    const r = (await app.inject({ method: "GET", url: "/api/pipeline?fresh=true", headers: auth })).json();
    const maria = r.rows.find((x: { email: string }) => x.email === "m.lopez@buckeyelogistics.com");
    expect(maria.campaign).toBe("Jobs");
    expect(Number.isNaN(Date.parse(maria.drafted_at))).toBe(false);
    const other = r.rows.find((x: { email: string }) => x.email === "sam@aweinteractive.com");
    expect(other.drafted_at).toBeUndefined();
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

describe("API: a failed send is visible and can be retried (AutoBooker columns K-O)", () => {
  const AB = ["MessageID", "SentAt", "LastReplyAt", "SendState", "Notes"];
  const H15 = [...H, ...AB];
  const r15 = (o: Partial<Record<string, string>>) => H15.map((h) => o[h] ?? "");
  let app: FastifyInstance; let tabs: Map<string, { rows: string[][] }>;
  beforeAll(async () => {
    const f = fakeSheets({
      Jobs_Pipeline: [H15,
        r15({ Company: "Acme", Name: "Fail Case", Email: "fail@acme.com", Status: "Approved", Subject: "s", DraftBody: "b", SendState: "SEND_FAILED", Notes: "2026-11-05 09:15 send failed: Gmail quota" }),
        r15({ Company: "Acme", Name: "Queued", Email: "queued@acme.com", Status: "Approved", Subject: "s", DraftBody: "b" }),
        r15({ Company: "Acme", Name: "Done", Email: "done@acme.com", Status: "Sent", Subject: "s", DraftBody: "b", ThreadID: "t9", SendState: "SENT", SentAt: "2026-11-05T09:00:00Z" }),
      ],
      // A tab AutoBooker has never touched: only the engine's ten columns.
      Pipeline: [H, row({ Company: "Old", Name: "Ten Cols", Email: "ten@old.com", Status: "Ready for Review", Subject: "s", DraftBody: "b" })],
    });
    tabs = f.tabs;
    app = await buildApp({ gw: () => f.gw, ledger: openLedger(":memory:"), env: {} });
  });
  afterAll(async () => { await app.close(); });

  const get = async () => (await app.inject({ method: "GET", url: "/api/pipeline?fresh=1" })).json().rows as Array<Record<string, string>>;

  it("shows Send Error for a SEND_FAILED row, keeps the Sheet status, and leaves other rows alone", async () => {
    const rows = await get();
    const failed = rows.find((r) => r.email === "fail@acme.com")!;
    expect(failed).toMatchObject({ status: "Send Error", sheet_status: "Approved", send_state: "SEND_FAILED" });
    expect(failed.notes).toContain("send failed: Gmail quota");
    expect(rows.find((r) => r.email === "queued@acme.com")).toMatchObject({ status: "Approved", sheet_status: "Approved", send_state: "" });
    expect(rows.find((r) => r.email === "done@acme.com")).toMatchObject({ status: "Sent", send_state: "SENT", sent_at: "2026-11-05T09:00:00Z" });
    expect(rows.find((r) => r.email === "ten@old.com")).toMatchObject({ status: "Ready for Review", send_state: "", notes: "" }); // ten-column tab still loads
    const summary = (await app.inject({ method: "GET", url: "/api/pipeline/summary" })).json();
    expect(summary.by_status["Send Error"]).toBe(1);
  });

  it("a Send Error row cannot be edited or approved directly", async () => {
    expect((await app.inject({ method: "PATCH", url: "/api/pipeline/fail@acme.com/draft", payload: { subject: "x" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/pipeline/fail@acme.com/approve" })).statusCode).toBe(409);
  });

  it("Retry send (reopen) returns the row to Ready for Review and clears AutoBooker's SendState and Notes", async () => {
    const r = await app.inject({ method: "POST", url: "/api/pipeline/fail@acme.com/reopen" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "Ready for Review", sheet_status: "Ready for Review", send_state: "", notes: "" });
    const sheetRow = tabs.get("Jobs_Pipeline")!.rows[1]!;
    expect(sheetRow[H.indexOf("Status")]).toBe("Ready for Review");
    expect(sheetRow[H15.indexOf("SendState")]).toBe("");
    expect(sheetRow[H15.indexOf("Notes")]).toBe("");
    // approving again now works, and AutoBooker will treat it as a fresh row
    expect((await app.inject({ method: "POST", url: "/api/pipeline/fail@acme.com/approve" })).statusCode).toBe(200);
  });

  it("Reject from Send Error also clears the failure marker", async () => {
    const sheetRow = tabs.get("Jobs_Pipeline")!.rows[1]!;
    sheetRow[H.indexOf("Status")] = "Approved"; sheetRow[H15.indexOf("SendState")] = "SEND_FAILED"; sheetRow[H15.indexOf("Notes")] = "send failed: again";
    expect((await app.inject({ method: "POST", url: "/api/pipeline/fail@acme.com/reject" })).statusCode).toBe(200);
    expect(sheetRow[H.indexOf("Status")]).toBe("Rejected");
    expect(sheetRow[H15.indexOf("SendState")]).toBe("");
  });
});

describe("API: errors come back in plain words (B13)", () => {
  const auth = { authorization: "Bearer secret" };
  const headers = [...PIPELINE_HEADERS];

  it("a wrong request body is 400 and names the field; never 500 with raw Zod JSON", async () => {
    const f = fakeSheets({ Jobs_Pipeline: [headers] });
    const app = await buildApp({ gw: () => f.gw, ledger: openLedger(":memory:"), env: { API_TOKEN: "secret" } });
    const base = { name: "X", mode: "CORPORATE", titles: ["CFO"], states: ["Ohio"], offer: "a 15-minute call about claims review", sender_company: "One Smarter" };
    const noTitles = await app.inject({ method: "POST", url: "/api/campaigns", headers: auth, payload: { ...base, titles: [] } });
    expect(noTitles.statusCode).toBe(400);
    expect(noTitles.json().error).toBe("titles: needs at least 1 entry");
    const capText = await app.inject({ method: "POST", url: "/api/campaigns", headers: auth, payload: { ...base, daily_cap: "abc" } });
    expect(capText.statusCode).toBe(400);
    expect(capText.json().error).toBe("daily_cap: must be a number");
    const badProvider = await app.inject({ method: "POST", url: "/api/campaigns", headers: auth, payload: { ...base, provider: "linkedin" } });
    expect(badProvider.statusCode).toBe(400);
    expect(badProvider.json().error).toMatch(/^provider: must be one of: gemini_xray/);
    const shortOffer = await app.inject({ method: "POST", url: "/api/campaigns", headers: auth, payload: { ...base, offer: "hi" } });
    expect(shortOffer.json().error).toBe("offer: must be at least 10 characters");
    await app.close();
  });

  it("our own 4xx messages pass through unchanged (409 from a status that cannot move)", async () => {
    const f = fakeSheets({ Jobs_Pipeline: [headers, row({ Company: "A", Email: "a@a.com", Status: "Sent", Subject: "s", DraftBody: "b" })] });
    const app = await buildApp({ gw: () => f.gw, ledger: openLedger(":memory:"), env: { API_TOKEN: "secret" } });
    const r = await app.inject({ method: "POST", url: "/api/pipeline/a@a.com/approve", headers: auth });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/Cannot move "Sent" to "Approved"/);
    await app.close();
  });

  it("an unexpected failure is 500 with a fixed sentence; internals stay in the log", async () => {
    const f = fakeSheets({ Jobs_Pipeline: [headers] });
    const secret = "svc-account@proj.iam.gserviceaccount.com at /home/user/secrets/key.json";
    const gw = { ...f.gw, getValues: async () => { throw new Error(`boom: ${secret}`); } };
    const app = await buildApp({ gw: () => gw, ledger: openLedger(":memory:"), env: { API_TOKEN: "secret" } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await app.inject({ method: "GET", url: "/api/pipeline", headers: auth });
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toBe(SERVER_ERROR);
    expect(r.body).not.toContain("gserviceaccount");
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
    await app.close();
  });

  it("a Google refusal is 502 with a hint, not the raw Google error", async () => {
    const f = fakeSheets({ Jobs_Pipeline: [headers] });
    const gw = { ...f.gw, getValues: async () => { throw Object.assign(new Error("The caller does not have permission"), { code: 403, response: { status: 403 } }); } };
    const app = await buildApp({ gw: () => gw, ledger: openLedger(":memory:"), env: { API_TOKEN: "secret" } });
    const r = await app.inject({ method: "GET", url: "/api/pipeline", headers: auth });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/Share the Sheet with the service-account email/);
    await app.close();
  });
});
