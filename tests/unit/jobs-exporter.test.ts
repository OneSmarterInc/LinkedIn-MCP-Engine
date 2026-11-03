import { describe, it, expect } from "vitest";
import type { SheetsGateway, SheetTabInfo } from "../../src/core/exporter.js";
import { JOBS_HEADERS, JOBS_TAB, exportJobsToSheet, jobRow } from "../../src/core/jobs/jobs-exporter.js";
import { startJobSearch, loadJobSearchRecord, type JobSearchOutput } from "../../src/core/jobs/job-search.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeSheets(initial: Record<string, string[][]> = {}) {
  const tabs = new Map<string, { id: number; rows: string[][] }>();
  let nextId = 1;
  for (const [t, rows] of Object.entries(initial)) tabs.set(t, { id: nextId++, rows });
  const batches: object[][] = [];
  const idx = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range: string) => {
    const [tab, a = ""] = range.split("!");
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a)!;
    return { tab: tab!, c1: idx(m[1]!), r1: m[2] ? Number(m[2]) - 1 : 0, c2: m[3] ? idx(m[3]) : undefined, r2: m[4] ? Number(m[4]) - 1 : undefined };
  };
  const gw: SheetsGateway = {
    async listTabs(): Promise<SheetTabInfo[]> { return [...tabs].map(([title, t]) => ({ title, sheetId: t.id })); },
    async addTabs(titles) { return titles.map((title) => { const t = { id: nextId++, rows: [] as string[][] }; tabs.set(title, t); return { title, sheetId: t.id }; }); },
    async batchUpdate(requests) { batches.push(requests); },
    async getValues(range) {
      const p = parse(range); const rows = tabs.get(p.tab)?.rows ?? [];
      return rows.slice(p.r1, p.r2 === undefined ? undefined : p.r2 + 1).map((r) => r.slice(p.c1, p.c2 === undefined ? p.c1 + 1 : p.c2 + 1)).filter((r) => r.length > 0);
    },
    async writeValues(range, values) { const p = parse(range); const t = tabs.get(p.tab)!; values.forEach((row, i) => { const r = (t.rows[p.r1 + i] ??= []); row.forEach((v, j) => { r[p.c1 + j] = v; }); }); },
    async appendValues(range, values) { tabs.get(parse(range).tab)!.rows.push(...values.map((v) => [...v])); },
  };
  return { gw, tabs, batches };
}

const out: JobSearchOutput = {
  searched_at: "2026-11-03T09:00:00.000Z", searches: 2, window: { from: "2026-10-27", to: "2026-11-03" }, total: 2, with_email: 1, seamless_lookups_used: 2,
  jobs: [
    { job_title: "Senior Java Developer", company: "Buckeye Logistics", company_domain: "buckeyelogistics.com", location: "Columbus, OH", posted_date_unconfirmed: "2026-11-01", description: "Build the TMS backend.", url: "https://www.linkedin.com/jobs/view/111", email: "maria@buckeyelogistics.com", email_source: "seamless_poster", contact_name: "Maria Lopez", contact_title: "CTO" },
    { job_title: "Data Engineer", company: "=Evil Corp", location: "Remote", posted_date_unconfirmed: null, description: "Pipelines.", url: "https://www.linkedin.com/posts/x_y-activity-222", email: null, email_source: "not_found" },
  ],
  skipped: [],
};

describe("jobRow", () => {
  it("maps a job to the header order and neutralises formula-looking text", () => {
    const r = jobRow(out.jobs[1]!, out.searched_at);
    expect(r).toHaveLength(JOBS_HEADERS.length);
    expect(r[JOBS_HEADERS.indexOf("Company")]).toBe("'=Evil Corp");
    expect(r[JOBS_HEADERS.indexOf("Status")]).toBe("New");
    expect(r[JOBS_HEADERS.indexOf("EmailSource")]).toBe("not_found");
  });
});

describe("exportJobsToSheet", () => {
  it("creates the Jobs tab with headers and a Status dropdown, then appends rows", async () => {
    const { gw, tabs, batches } = fakeSheets({ Pipeline: [["Company"]] });
    const res = await exportJobsToSheet(out, gw);
    expect(res).toEqual({ tab: JOBS_TAB, added: 2, already_present: 0, without_email: 1 });
    const rows = tabs.get(JOBS_TAB)!.rows;
    expect(rows[0]).toEqual([...JOBS_HEADERS]);
    expect(rows[1]![JOBS_HEADERS.indexOf("Email")]).toBe("maria@buckeyelogistics.com");
    const kinds = (batches.flat() as Array<{ setDataValidation?: unknown }>).filter((r) => r.setDataValidation);
    expect(kinds).toHaveLength(1);
  });
  it("skips jobs already in the tab, by URL", async () => {
    const { gw, tabs } = fakeSheets();
    await exportJobsToSheet(out, gw);
    const again = await exportJobsToSheet(out, gw);
    expect(again).toMatchObject({ added: 0, already_present: 2 });
    expect(tabs.get(JOBS_TAB)!.rows).toHaveLength(3);
  });
  it("refuses a Jobs tab with foreign headers", async () => {
    const { gw } = fakeSheets({ [JOBS_TAB]: [["Something", "Else"]] });
    await expect(exportJobsToSheet(out, gw)).rejects.toThrow(/unexpected headers/);
  });
});

describe("startJobSearch afterDone hook", () => {
  it("records the sheet result on the DONE record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobs-"));
    const { record, done } = await startJobSearch(async () => out, dir, () => new Date("2026-11-03T09:00:00Z"),
      async () => ({ tab: JOBS_TAB, added: 2, already_present: 0, without_email: 1 }));
    await done;
    const rec = await loadJobSearchRecord(record.search_id, dir);
    expect(rec.status).toBe("DONE");
    expect(rec.sheet).toEqual({ tab: JOBS_TAB, added: 2, already_present: 0, without_email: 1 });
  });
  it("keeps DONE and records the error when the sheet write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobs-"));
    const { record, done } = await startJobSearch(async () => out, dir, () => new Date(), async () => { throw new Error("403 share the Sheet"); });
    await done;
    const rec = await loadJobSearchRecord(record.search_id, dir);
    expect(rec.status).toBe("DONE");
    expect(rec.sheet?.error).toMatch(/403/);
  });
});
