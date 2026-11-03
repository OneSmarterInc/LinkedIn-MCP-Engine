import { colLetter, type SheetsGateway } from "../exporter.js";
import type { JobSearchOutput, JobView } from "./job-search.js";

/**
 * Writes job-search results to a "Jobs" tab in the same Google Sheet the Pipeline lives in.
 * One row per job. A job already in the tab (same URL) is not added again, so re-exporting is safe.
 * The tab is created with headers and a Status dropdown the first time.
 */

export const JOBS_TAB = "Jobs";

export const JOBS_HEADERS = [
  "FoundAt", "JobTitle", "Company", "Domain", "Location", "PostedDate", "Description", "URL",
  "Email", "EmailSource", "ContactName", "ContactTitle", "Status", "Notes",
] as const;

export const JOB_STATUS = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  skip: "Skip",
} as const;
export const JOB_STATUS_OPTIONS: string[] = Object.values(JOB_STATUS);

const WIDTHS = [150, 220, 170, 140, 140, 110, 420, 260, 220, 140, 160, 170, 110, 240];
const LAST = colLetter(JOBS_HEADERS.length);
const col = (h: (typeof JOBS_HEADERS)[number]) => colLetter(JOBS_HEADERS.indexOf(h) + 1);

/** Text that cannot run as a formula. Anything from the web or an AI goes through this. */
function cell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

export function jobRow(j: JobView, foundAt: string): string[] {
  const r: Record<(typeof JOBS_HEADERS)[number], string> = {
    FoundAt: foundAt,
    JobTitle: j.job_title,
    Company: j.company,
    Domain: j.company_domain ?? "",
    Location: j.location,
    PostedDate: j.posted_date_unconfirmed ?? "",
    Description: j.description,
    URL: j.url,
    Email: j.email ?? "",
    EmailSource: j.email_source,
    ContactName: j.contact_name ?? "",
    ContactTitle: j.contact_title ?? "",
    Status: JOB_STATUS.new,
    Notes: "",
  };
  return JOBS_HEADERS.map((h) => cell(r[h]));
}

async function ensureJobsTab(gw: SheetsGateway): Promise<number> {
  let tab = (await gw.listTabs()).find((t) => t.title === JOBS_TAB);
  if (!tab) tab = (await gw.addTabs([JOBS_TAB]))[0]!;
  const sheetId = tab.sheetId;

  const current = ((await gw.getValues(`${JOBS_TAB}!A1:${LAST}1`))[0] ?? []).map((c) => c.trim());
  if (current.every((c) => c === "")) {
    await gw.writeValues(`${JOBS_TAB}!A1:${LAST}1`, [[...JOBS_HEADERS]], "raw");
    const statusIdx = JOBS_HEADERS.indexOf("Status");
    await gw.batchUpdate([
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      ...WIDTHS.map((pixelSize, i) => ({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize }, fields: "pixelSize" } })),
      { repeatCell: { range: { sheetId, startRowIndex: 1, startColumnIndex: JOBS_HEADERS.indexOf("Description"), endColumnIndex: JOBS_HEADERS.indexOf("Description") + 1 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat(wrapStrategy,verticalAlignment)" } },
      { setDataValidation: { range: { sheetId, startRowIndex: 1, startColumnIndex: statusIdx, endColumnIndex: statusIdx + 1 }, rule: { condition: { type: "ONE_OF_LIST", values: JOB_STATUS_OPTIONS.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: true } } },
    ]);
    return sheetId;
  }
  if (JOBS_HEADERS.some((h, i) => current[i] !== h)) {
    throw new Error(
      `The "${JOBS_TAB}" tab has unexpected headers. Expected: ${JOBS_HEADERS.join(", ")}. Found: ${current.join(", ")}. ` +
      `Fix the header row or delete the tab; nothing was written.`,
    );
  }
  return sheetId;
}

export interface JobsExportResult {
  tab: string;
  added: number;
  already_present: number;
  without_email: number;
}

/** Appends new jobs to the Jobs tab. Jobs whose URL is already there are skipped. */
export async function exportJobsToSheet(out: JobSearchOutput, gw: SheetsGateway): Promise<JobsExportResult> {
  await ensureJobsTab(gw);
  const urlCol = col("URL");
  const present = new Set(
    (await gw.getValues(`${JOBS_TAB}!${urlCol}2:${urlCol}`)).map((r) => (r[0] ?? "").trim().toLowerCase()),
  );
  const fresh = out.jobs.filter((j) => !present.has(j.url.trim().toLowerCase()));
  const rows = fresh.map((j) => jobRow(j, out.searched_at));
  if (rows.length) await gw.appendValues(`${JOBS_TAB}!A1`, rows);
  return {
    tab: JOBS_TAB,
    added: rows.length,
    already_present: out.jobs.length - rows.length,
    without_email: fresh.filter((j) => !j.email).length,
  };
}

export function formatJobsExport(r: JobsExportResult): string {
  return `Jobs tab: ${r.added} added (${r.without_email} without an email), ${r.already_present} already there.`;
}
