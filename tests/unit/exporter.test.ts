import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { FailureReason } from "../../src/config/schema.js";
import type { Ledger } from "../../src/core/db.js";
import type { DraftedLead } from "../../src/core/enricher.js";
import {
  PIPELINE_HEADERS, QUARANTINED_HEADERS, STATUS, STATUS_OPTIONS, buildExportRows, colLetter,
  exportToSheet, exportToXlsx, recordExported, summaryRows,
  type SheetsGateway, type SheetTabInfo,
} from "../../src/core/exporter.js";
import type { RunReport } from "../../src/core/pipeline.js";
import { makeLead } from "../helpers.js";

function draft(o: Partial<DraftedLead> = {}): DraftedLead {
  return {
    ...makeLead(),
    research_summary: ["Opened a new plant in Dayton"],
    email_subject: "A note for Acme",
    email_body: "One. Two. Three. Four?",
    draft_status: "READY",
    draft_issues: [],
    ...o,
  };
}

function report(drafts: DraftedLead[], quarantinedLeads = 0): RunReport {
  const quarantined = Array.from({ length: quarantinedLeads }, (_, i) => {
    const lead = makeLead({ email: `info${i}@acme.com`, first_name: "Info", last_name: `Box${i}` });
    return {
      lead,
      result: { lead_id: lead.lead_id, passed: false, failed_gate: 3 as const, failure_reason: "ROLE_ACCOUNT" as const, checked_at: "x" },
    };
  });
  return {
    run_id: "2026-10-30T10-00-00-000Z", campaign: "test-corp", mode: "CORPORATE", provider: "csv_import",
    started_at: "x", finished_at: "x",
    counts: { rows_read: 0, skipped: 0, sourced: 0, passed: drafts.length, quarantined: quarantined.length },
    quarantined_by_reason: {}, skipped_by_reason: {}, passed: drafts, quarantined, skipped: [], drafts,
  };
}

/** An in-memory Google Sheet. Records every call so tests can check what was written and how. */
function fakeSheets(initial: Record<string, string[][]> = {}) {
  const tabs = new Map<string, { id: number; rows: string[][] }>();
  let nextId = 1;
  for (const [t, rows] of Object.entries(initial)) tabs.set(t, { id: nextId++, rows });
  const log = { batches: [] as object[][], writes: [] as { range: string; mode: string }[], appends: [] as { range: string; values: string[][] }[] };

  const idx = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range: string) => {
    const [tab, a = ""] = range.split("!");
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a)!;
    return { tab: tab!, c1: idx(m[1]!), r1: m[2] ? Number(m[2]) - 1 : 0, c2: m[3] ? idx(m[3]) : undefined, r2: m[4] ? Number(m[4]) - 1 : undefined };
  };

  const gw: SheetsGateway = {
    async listTabs(): Promise<SheetTabInfo[]> {
      return [...tabs].map(([title, t]) => ({ title, sheetId: t.id }));
    },
    async addTabs(titles) {
      return titles.map((title) => {
        const t = { id: nextId++, rows: [] as string[][] };
        tabs.set(title, t);
        return { title, sheetId: t.id };
      });
    },
    async batchUpdate(requests) { log.batches.push(requests); },
    async getValues(range) {
      const p = parse(range);
      const rows = tabs.get(p.tab)?.rows ?? [];
      const out = rows.slice(p.r1, p.r2 === undefined ? undefined : p.r2 + 1)
        .map((r) => r.slice(p.c1, p.c2 === undefined ? p.c1 + 1 : p.c2 + 1));
      return out.filter((r) => r.length > 0);
    },
    async writeValues(range, values, mode) {
      log.writes.push({ range, mode });
      const p = parse(range);
      const t = tabs.get(p.tab)!;
      values.forEach((row, i) => {
        const r = (t.rows[p.r1 + i] ??= []);
        row.forEach((v, j) => { r[p.c1 + j] = v; });
      });
    },
    async appendValues(range, values) {
      log.appends.push({ range, values });
      tabs.get(parse(range).tab)!.rows.push(...values.map((v) => [...v]));
    },
  };
  return { gw, tabs, log };
}

describe("columns", () => {
  it("keeps the Pipeline column order the sender depends on", () => {
    expect([...PIPELINE_HEADERS]).toEqual([
      "Company", "Domain", "Name", "Title", "Email", "Research", "Status", "Subject", "DraftBody", "ThreadID",
    ]);
  });
  it("names columns by letter", () => {
    expect([colLetter(1), colLetter(7), colLetter(10), colLetter(26), colLetter(27)]).toEqual(["A", "G", "J", "Z", "AA"]);
  });
});

describe("buildExportRows", () => {
  it("puts READY drafts in the Pipeline as Ready for Review", () => {
    const rows = buildExportRows(report([draft()]));
    expect(rows.pipeline).toHaveLength(1);
    const r = rows.pipeline[0]!;
    expect(r).toHaveLength(PIPELINE_HEADERS.length);
    expect(r[PIPELINE_HEADERS.indexOf("Status")]).toBe(STATUS.ready);
    expect(r[PIPELINE_HEADERS.indexOf("Name")]).toBe("Jane Miller");
    expect(r[PIPELINE_HEADERS.indexOf("Domain")]).toBe("acme.com");
    expect(r[PIPELINE_HEADERS.indexOf("Subject")]).toBe("A note for Acme");
    expect(r[PIPELINE_HEADERS.indexOf("ThreadID")]).toBe("");
  });

  it("keeps NEEDS_REWRITE drafts in the Pipeline, flagged, so they are never silently lost", () => {
    const rows = buildExportRows(report([draft({ draft_status: "NEEDS_REWRITE", draft_issues: ["no question at the end"] })]));
    const r = rows.pipeline[0]!;
    expect(r[PIPELINE_HEADERS.indexOf("Status")]).toBe(STATUS.needsRewrite);
    expect(r[PIPELINE_HEADERS.indexOf("Research")]).toContain("REWRITE NEEDED: no question at the end");
  });

  it("sends DRAFT_ERROR leads to Quarantined, not the Pipeline", () => {
    const rows = buildExportRows(report([draft({ draft_status: "DRAFT_ERROR", email_subject: "", email_body: "" })]));
    expect(rows.pipeline).toHaveLength(0);
    expect(rows.exported).toHaveLength(0);
    expect(rows.quarantined[0]![QUARANTINED_HEADERS.indexOf("FailureReason")]).toBe("DRAFT_ERROR");
  });

  it("writes gate failures to Quarantined with their reason and gate", () => {
    const rows = buildExportRows(report([], 2));
    expect(rows.quarantined).toHaveLength(2);
    const r = rows.quarantined[0]!;
    expect(r).toHaveLength(QUARANTINED_HEADERS.length);
    expect(r[QUARANTINED_HEADERS.indexOf("FailureReason")]).toBe("ROLE_ACCOUNT");
    expect(r[QUARANTINED_HEADERS.indexOf("FailedGate")]).toBe("3");
  });

  it("refuses a report that has no drafts (made by verify)", () => {
    const r = report([]);
    delete r.drafts;
    expect(() => buildExportRows(r)).toThrow(/no drafts/);
  });
});

describe("Summary formulas", () => {
  const flat = summaryRows().map((r) => r.join(" ")).join("\n");
  it("counts every status from the Status column (G)", () => {
    for (const s of STATUS_OPTIONS) expect(flat).toContain(`=COUNTIF(Pipeline!G2:G,"${s}")`);
  });
  it("counts every failure reason from the FailureReason column (H)", () => {
    for (const reason of [...FailureReason.options, "DRAFT_ERROR"]) {
      expect(flat).toContain(`=COUNTIF(Quarantined!H2:H,"${reason}")`);
    }
  });
  it("hard-codes no numbers", () => {
    for (const row of summaryRows().slice(1)) expect(row[1]).toMatch(/^=COUNT/);
  });
});

describe("exportToSheet", () => {
  it("builds the three tabs, headers, dropdown and summary on an empty Sheet", async () => {
    const { gw, tabs, log } = fakeSheets();
    const res = await exportToSheet(report([draft(), draft({ email: "b@acme.com", first_name: "Bo" })], 1), gw);

    expect([...tabs.keys()].sort()).toEqual(["Pipeline", "Quarantined", "Summary"]);
    expect(tabs.get("Pipeline")!.rows[0]).toEqual([...PIPELINE_HEADERS]);
    expect(tabs.get("Quarantined")!.rows[0]).toEqual([...QUARANTINED_HEADERS]);
    expect(tabs.get("Pipeline")!.rows).toHaveLength(3);
    expect(tabs.get("Quarantined")!.rows).toHaveLength(2);
    expect(res).toMatchObject({ pipeline_added: 2, pipeline_already_present: 0, quarantined_added: 1 });

    const rule = JSON.stringify(log.batches.flat());
    expect(rule).toContain("ONE_OF_LIST");
    expect(rule).toContain("Ready for Review");
    expect(rule).toContain('"startColumnIndex":6'); // Status = column G

    const summary = log.writes.find((w) => w.range.startsWith("Summary"))!;
    expect(summary.mode).toBe("formulas");
  });

  it("re-applies the Status dropdown after adding rows, so new rows always have it", async () => {
    const { gw, log } = fakeSheets();
    await exportToSheet(report([draft()]), gw);
    const last = JSON.stringify(log.batches.at(-1));
    expect(last).toContain("ONE_OF_LIST");
    expect(last).toContain('"startRowIndex":1');
  });

  it("writes lead and draft text as plain text, never as formulas", async () => {
    const { gw, log } = fakeSheets();
    await exportToSheet(report([draft({ company_name: '=HYPERLINK("http://evil","x")' })]), gw);
    expect(log.appends.length).toBeGreaterThan(0);
    expect(log.writes.filter((w) => w.mode === "formulas").map((w) => w.range)).toEqual(["Summary!A1"]);
    expect(log.appends[0]!.values[0]![0]).toBe('=HYPERLINK("http://evil","x")');
  });

  it("appends on a second run without touching rows a human already changed", async () => {
    const { gw, tabs } = fakeSheets();
    await exportToSheet(report([draft()]), gw);
    tabs.get("Pipeline")!.rows[1]![PIPELINE_HEADERS.indexOf("Status")] = STATUS.approved; // human approves

    const again = await exportToSheet(report([draft(), draft({ email: "new@acme.com", first_name: "New" })]), gw);
    expect(again).toMatchObject({ pipeline_added: 1, pipeline_already_present: 1 });
    const rows = tabs.get("Pipeline")!.rows;
    expect(rows).toHaveLength(3);
    expect(rows[1]![PIPELINE_HEADERS.indexOf("Status")]).toBe(STATUS.approved);
  });

  it("stops without writing anything if the Pipeline headers are wrong", async () => {
    const { gw, log } = fakeSheets({ Pipeline: [["Name", "Email", "Status"]] });
    await expect(exportToSheet(report([draft()]), gw)).rejects.toThrow(/expected headers/);
    expect(log.appends).toHaveLength(0);
  });
});

describe("recordExported", () => {
  it("records each exported lead in the ledger as EXPORTED", () => {
    const saved: Parameters<Ledger["recordContact"]>[0][] = [];
    const ledger = { recordContact: (c: Parameters<Ledger["recordContact"]>[0]) => void saved.push(c) } as Ledger;
    const rows = buildExportRows(report([draft(), draft({ draft_status: "DRAFT_ERROR" })]));
    expect(recordExported({ campaign: "test-corp" }, rows.exported, ledger)).toBe(1);
    expect(saved[0]).toMatchObject({ email: "jane.miller@acme.com", campaign: "test-corp", status: "EXPORTED" });
  });
});

describe("exportToXlsx", () => {
  it("writes the same three tabs with a Status dropdown and live Summary formulas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xlsx-"));
    const res = await exportToXlsx(report([draft()], 1), dir);
    expect(res.pipeline_added).toBe(1);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(res.path);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Pipeline", "Quarantined", "Summary"]);

    const pipe = wb.getWorksheet("Pipeline")!;
    expect(pipe.getRow(1).values).toEqual([undefined, ...PIPELINE_HEADERS]);
    expect(pipe.getCell("G2").value).toBe(STATUS.ready);
    expect(pipe.getCell("G2").dataValidation.type).toBe("list");

    const summary = wb.getWorksheet("Summary")!;
    const formulaCell = summary.getCell("B3").value as { formula: string };
    expect(formulaCell.formula).toContain("COUNTIF(Pipeline!G2:G1000");
  });
});
