import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { FailureReason } from "../config/schema.js";
import type { Ledger } from "./db.js";
import type { DraftedLead } from "./enricher.js";
import type { RunReport } from "./pipeline.js";
import type { Quarantined } from "./verifier.js";

// ---------------------------------------------------------------------------
// Layout. The Pipeline columns and their ORDER must match apps_script/AutoBooker.gs.
// ---------------------------------------------------------------------------

export const TAB = { pipeline: "Pipeline", quarantined: "Quarantined", summary: "Summary" } as const;

export const PIPELINE_HEADERS = [
  "Company", "Domain", "Name", "Title", "Email", "Research", "Status", "Subject", "DraftBody", "ThreadID",
] as const;

export const QUARANTINED_HEADERS = [
  "Company", "Domain", "Name", "Title", "Email", "Location", "FailedGate", "FailureReason", "Campaign", "RunID", "LeadID",
] as const;

const PIPELINE_WIDTHS = [160, 140, 150, 170, 220, 280, 130, 220, 480, 120];
const QUARANTINED_WIDTHS = [160, 140, 150, 170, 220, 140, 90, 210, 180, 190, 110];

/** Status dropdown. Only a human moves a row to "Approved"; the sender (Phase 5) acts on nothing else. */
export const STATUS = {
  ready: "Ready for Review",
  needsRewrite: "Needs Rewrite",
  approved: "Approved",
  rejected: "Rejected",
  sent: "Sent",
  replied: "Replied",
  meetingBooked: "Meeting Booked",
  optedOut: "Opted Out",
} as const;
export const STATUS_OPTIONS: string[] = Object.values(STATUS);

/** A draft that could not be written at all. It goes to the Quarantined tab with this reason. */
export const DRAFT_ERROR_REASON = "DRAFT_ERROR";

const MAX_CELL = 49_000; // Google Sheets allows 50,000 characters per cell.

/** 1 -> A, 26 -> Z, 27 -> AA. */
export function colLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function col(headers: readonly string[], name: string): string {
  const i = headers.indexOf(name);
  if (i < 0) throw new Error(`Unknown column "${name}"`);
  return colLetter(i + 1);
}

function cell(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v);
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type RunRef = Pick<RunReport, "campaign" | "run_id">;

function domainOf(l: { company_domain?: string; email?: string }): string {
  return l.company_domain || l.email?.split("@")[1] || "";
}

export function pipelineRow(d: DraftedLead): string[] {
  const research = d.research_summary.join(" | ");
  const note = d.draft_status === "NEEDS_REWRITE" ? `REWRITE NEEDED: ${d.draft_issues.join("; ")}` : "";
  return [
    d.company_name,
    domainOf(d),
    `${d.first_name} ${d.last_name}`.trim(),
    d.title,
    d.email ?? "",
    [note, research].filter(Boolean).join(" || "),
    d.draft_status === "READY" ? STATUS.ready : STATUS.needsRewrite,
    d.email_subject,
    d.email_body,
    "", // ThreadID: filled by the Apps Script when the email is sent
  ].map(cell);
}

export function quarantinedRow(q: Quarantined, run: RunRef): string[] {
  const l = q.lead;
  return [
    l.company_name,
    domainOf(l),
    `${l.first_name} ${l.last_name}`.trim(),
    l.title,
    l.email ?? "",
    l.location,
    q.result.failed_gate ?? "",
    q.result.failure_reason ?? "UNKNOWN",
    run.campaign,
    run.run_id,
    l.lead_id,
  ].map(cell);
}

function draftErrorRow(d: DraftedLead, run: RunRef): string[] {
  return [
    d.company_name, domainOf(d), `${d.first_name} ${d.last_name}`.trim(), d.title, d.email ?? "", d.location,
    "", DRAFT_ERROR_REASON, run.campaign, run.run_id, d.lead_id,
  ].map(cell);
}

export interface ExportRows {
  pipeline: string[][];
  quarantined: string[][];
  /** Leads that land in the Pipeline tab. These get recorded in the ledger. */
  exported: DraftedLead[];
}

export function buildExportRows(report: RunReport): ExportRows {
  if (!report.drafts) {
    throw new Error("This report has no drafts. Export a report made by `run`, not by `verify`.");
  }
  const inPipeline = report.drafts.filter((d) => d.draft_status !== "DRAFT_ERROR");
  const failed = report.drafts.filter((d) => d.draft_status === "DRAFT_ERROR");
  return {
    pipeline: inPipeline.map(pipelineRow),
    quarantined: [
      ...report.quarantined.map((q) => quarantinedRow(q, report)),
      ...failed.map((d) => draftErrorRow(d, report)),
    ],
    exported: inPipeline,
  };
}

// ---------------------------------------------------------------------------
// Summary tab: every number is a formula over the other tabs. Nothing is hard-coded.
// ---------------------------------------------------------------------------

type RangeOf = (column: string) => string;

function summaryRowsFor(pipelineRange: RangeOf, quarRange: RangeOf): string[][] {
  const status = pipelineRange(col(PIPELINE_HEADERS, "Status"));
  const reason = quarRange(col(QUARANTINED_HEADERS, "FailureReason"));
  return [
    ["Metric", "Count"],
    ["Leads in Pipeline", `=COUNTA(${pipelineRange(col(PIPELINE_HEADERS, "Email"))})`],
    ...STATUS_OPTIONS.map((s) => [s, `=COUNTIF(${status},"${s}")`]),
    ["Quarantined (total)", `=COUNTA(${reason})`],
    ...[...FailureReason.options, DRAFT_ERROR_REASON].map((r) => [`  ${r}`, `=COUNTIF(${reason},"${r}")`]),
  ];
}

/** Google Sheets accepts open-ended ranges such as Pipeline!G2:G. */
export function summaryRows(): string[][] {
  return summaryRowsFor((c) => `${TAB.pipeline}!${c}2:${c}`, (c) => `${TAB.quarantined}!${c}2:${c}`);
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

export interface SheetTabInfo { title: string; sheetId: number }

/** The few Sheets operations the exporter needs. The real one is lib/google/sheets.ts; tests use a fake. */
export interface SheetsGateway {
  listTabs(): Promise<SheetTabInfo[]>;
  addTabs(titles: string[]): Promise<SheetTabInfo[]>;
  /** Raw Sheets API requests: formatting and the Status dropdown. */
  batchUpdate(requests: object[]): Promise<void>;
  getValues(range: string): Promise<string[][]>;
  /** "raw" stores text exactly as given. "formulas" lets "=..." run. Only the Summary tab uses formulas. */
  writeValues(range: string, values: string[][], mode: "raw" | "formulas"): Promise<void>;
  /** Always raw, so text from leads or the AI can never run as a formula. */
  appendValues(range: string, values: string[][]): Promise<void>;
}

function formatRequests(sheetId: number, widths: number[], wrapCols: number[]): object[] {
  return [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    ...widths.map((pixelSize, i) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    })),
    ...wrapCols.map((c) => ({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: c, endColumnIndex: c + 1 },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
        fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
      },
    })),
  ];
}

/** Writes the header row if the tab is empty. If it already has a different header, stop: never write under the wrong columns. */
async function ensureHeader(
  gw: SheetsGateway, tab: string, headers: readonly string[], sheetId: number, widths: number[], wrapCols: number[],
): Promise<void> {
  const last = colLetter(headers.length);
  const current = ((await gw.getValues(`${tab}!A1:${last}1`))[0] ?? []).map((c) => String(c).trim());
  if (current.every((c) => c === "")) {
    await gw.writeValues(`${tab}!A1:${last}1`, [[...headers]], "raw");
    await gw.batchUpdate(formatRequests(sheetId, widths, wrapCols));
    return;
  }
  if (headers.some((h, i) => current[i] !== h)) {
    throw new Error(
      `The "${tab}" tab does not have the expected headers (${headers.join(", ")}). ` +
      `Found: ${current.join(", ") || "(empty)"}. Fix the header row or use a fresh Sheet. Nothing was written.`,
    );
  }
}

/** The Status dropdown for every Pipeline row from row 2 down. Applying it again is harmless. */
function statusDropdownRequest(pipelineSheetId: number): object {
  const statusCol = PIPELINE_HEADERS.indexOf("Status");
  return {
    setDataValidation: {
      range: { sheetId: pipelineSheetId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 },
      rule: {
        condition: { type: "ONE_OF_LIST", values: STATUS_OPTIONS.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict: true,
      },
    },
  };
}

/** Creates missing tabs, writes headers, sets the Status dropdown, and writes the Summary formulas. Safe to run every time. */
export async function ensureSheetLayout(gw: SheetsGateway): Promise<{ pipelineSheetId: number }> {
  const ids = new Map((await gw.listTabs()).map((t) => [t.title, t.sheetId]));
  const missing = Object.values(TAB).filter((t) => !ids.has(t));
  if (missing.length) for (const t of await gw.addTabs(missing)) ids.set(t.title, t.sheetId);

  const pid = ids.get(TAB.pipeline)!;
  const qid = ids.get(TAB.quarantined)!;
  const sid = ids.get(TAB.summary)!;

  await ensureHeader(gw, TAB.pipeline, PIPELINE_HEADERS, pid, PIPELINE_WIDTHS, [5, 7, 8]);
  await ensureHeader(gw, TAB.quarantined, QUARANTINED_HEADERS, qid, QUARANTINED_WIDTHS, []);
  if (missing.includes(TAB.summary)) await gw.batchUpdate(formatRequests(sid, [260, 90], []));

  await gw.batchUpdate([statusDropdownRequest(pid)]);
  await gw.writeValues(`${TAB.summary}!A1`, summaryRows(), "formulas");
  return { pipelineSheetId: pid };
}

export interface SheetExportResult {
  target: "sheet";
  pipeline_added: number;
  pipeline_already_present: number;
  quarantined_added: number;
  exported: DraftedLead[];
}

/** Appends this run to the Sheet. Existing rows, and any Status a human already set, are never touched. */
export async function exportToSheet(report: RunReport, gw: SheetsGateway): Promise<SheetExportResult> {
  const rows = buildExportRows(report);
  const { pipelineSheetId } = await ensureSheetLayout(gw);

  // Skip emails already in the Pipeline tab, so exporting the same run twice cannot create duplicate rows.
  const emailCol = col(PIPELINE_HEADERS, "Email");
  const present = new Set(
    (await gw.getValues(`${TAB.pipeline}!${emailCol}2:${emailCol}`)).map((r) => (r[0] ?? "").trim().toLowerCase()),
  );
  const emailIdx = PIPELINE_HEADERS.indexOf("Email");
  const fresh = rows.pipeline.filter((r) => !present.has((r[emailIdx] ?? "").toLowerCase()));

  if (fresh.length) await gw.appendValues(`${TAB.pipeline}!A1`, fresh);
  if (rows.quarantined.length) await gw.appendValues(`${TAB.quarantined}!A1`, rows.quarantined);
  // Belt and braces: make sure every row, including the ones just added, has the dropdown.
  if (fresh.length) await gw.batchUpdate([statusDropdownRequest(pipelineSheetId)]);

  return {
    target: "sheet",
    pipeline_added: fresh.length,
    pipeline_already_present: rows.pipeline.length - fresh.length,
    quarantined_added: rows.quarantined.length,
    exported: rows.exported,
  };
}

// ---------------------------------------------------------------------------
// Local .xlsx (works with no Google account)
// ---------------------------------------------------------------------------

export interface XlsxExportResult {
  target: "xlsx";
  path: string;
  pipeline_added: number;
  quarantined_added: number;
  exported: DraftedLead[];
}

const XLSX_ROWS = 1000; // Excel has no open-ended ranges, so the Summary formulas cover this many rows.

export async function exportToXlsx(report: RunReport, dir = "out"): Promise<XlsxExportResult> {
  const rows = buildExportRows(report);
  const wb = new ExcelJS.Workbook();

  const addSheet = (name: string, headers: readonly string[], data: string[][], widths: number[]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = headers.map((h, i) => ({ header: h, key: h, width: Math.round((widths[i] ?? 140) / 7) }));
    ws.getRow(1).font = { bold: true };
    // Plain strings are stored as text, never as formulas.
    for (const r of data) ws.addRow(r.map((v) => (v === "" ? null : v)));
    return ws;
  };

  const pipe = addSheet(TAB.pipeline, PIPELINE_HEADERS, rows.pipeline, PIPELINE_WIDTHS);
  addSheet(TAB.quarantined, QUARANTINED_HEADERS, rows.quarantined, QUARANTINED_WIDTHS);

  const statusCol = col(PIPELINE_HEADERS, "Status");
  for (let r = 2; r <= XLSX_ROWS; r++) {
    pipe.getCell(`${statusCol}${r}`).dataValidation = {
      type: "list", allowBlank: true, formulae: [`"${STATUS_OPTIONS.join(",")}"`],
    };
  }

  const summary = wb.addWorksheet(TAB.summary);
  const closed = summaryRowsFor(
    (c) => `${TAB.pipeline}!${c}2:${c}${XLSX_ROWS}`,
    (c) => `${TAB.quarantined}!${c}2:${c}${XLSX_ROWS}`,
  );
  closed.forEach((r, i) => {
    const row = summary.addRow([r[0], i === 0 ? r[1] : { formula: r[1]!.slice(1) }]);
    if (i === 0) row.font = { bold: true };
  });
  summary.getColumn(1).width = 34;

  await mkdir(dir, { recursive: true });
  const path = join(dir, `pipeline-${report.run_id}.xlsx`);
  await wb.xlsx.writeFile(path);
  return {
    target: "xlsx", path,
    pipeline_added: rows.pipeline.length, quarantined_added: rows.quarantined.length, exported: rows.exported,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** Records every lead that reached the Pipeline tab so it is never contacted twice. Returns how many were recorded. */
export function recordExported(report: Pick<RunReport, "campaign">, leads: DraftedLead[], ledger: Ledger): number {
  let n = 0;
  for (const d of leads) {
    if (!d.email) continue;
    ledger.recordContact({
      email: d.email,
      lead_id: d.lead_id,
      full_name: `${d.first_name} ${d.last_name}`.trim(),
      campaign: report.campaign,
      status: "EXPORTED",
    });
    n += 1;
  }
  return n;
}

export function formatExportSummary(r: SheetExportResult | XlsxExportResult, ledgerRecorded: number): string {
  return [
    r.target === "sheet" ? "Exported to Google Sheet" : `Exported to Excel file ${r.path}`,
    `  Pipeline rows added ......... ${r.pipeline_added}`,
    ...(r.target === "sheet" ? [`  Already in Pipeline ......... ${r.pipeline_already_present}`] : []),
    `  Quarantined rows added ...... ${r.quarantined_added}`,
    `  Recorded in ledger .......... ${ledgerRecorded}`,
  ].join("\n");
}
