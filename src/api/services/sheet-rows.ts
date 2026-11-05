import { PIPELINE_HEADERS, QUARANTINED_HEADERS, STATUS, TAB, JOB_TABS, colLetter, type SheetsGateway } from "../../core/exporter.js";

/**
 * Reads and updates rows in the Pipeline-shaped tabs (Pipeline, Jobs_Pipeline) and the Quarantine tabs.
 * Rows are found by Email, never by row number, because people insert and delete rows in the Sheet by hand.
 * The Sheet stays the system of record; this file is the only place the API touches it.
 */

export type PipelineTab = typeof TAB.pipeline | typeof JOB_TABS.pipeline;
export const PIPELINE_TABS: PipelineTab[] = [JOB_TABS.pipeline, TAB.pipeline];
export const QUARANTINE_TABS = [JOB_TABS.quarantined, TAB.quarantined] as const;

export interface PipelineRow {
  tab: PipelineTab;
  row_number: number;
  company: string;
  domain: string;
  name: string;
  title: string;
  email: string;
  research: string;
  status: string;
  subject: string;
  body: string;
  thread_id: string;
  /** Parsed from the Research cell when the row came from a hiring signal or job post. */
  signal?: { role: string; posted?: string; url?: string };
  /** The Status cell exactly as written in the Sheet. `status` above is what to show: "Send Error" when AutoBooker's SendState says SEND_FAILED. */
  sheet_status: string;
  /** AutoBooker's own columns (K-O). Empty until its first run on that row. */
  send_state: string;
  notes: string;
  sent_at: string;
}

export interface QuarantineRow {
  tab: string;
  row_number: number;
  company: string;
  domain: string;
  name: string;
  title: string;
  email: string;
  location: string;
  failed_gate: string;
  reason: string;
  campaign: string;
  run_id: string;
  /** Plain words for the reason code. */
  why: string;
}

/**
 * AutoBooker (apps_script/*.gs (AutoBooker)) adds these five columns after the engine's ten. They are read here so the
 * console can show a failed send, and cleared when a person retries one. Positions match COL in AutoBooker.gs.
 */
export const AUTOBOOKER_HEADERS = ["MessageID", "SentAt", "LastReplyAt", "SendState", "Notes"] as const;
export const SEND_FAILED = "SEND_FAILED";
const abCol = (h: (typeof AUTOBOOKER_HEADERS)[number]) => colLetter(PIPELINE_HEADERS.length + AUTOBOOKER_HEADERS.indexOf(h) + 1);

const LAST_P = colLetter(PIPELINE_HEADERS.length + AUTOBOOKER_HEADERS.length);
const LAST_Q = colLetter(QUARANTINED_HEADERS.length);
const col = (h: (typeof PIPELINE_HEADERS)[number]) => colLetter(PIPELINE_HEADERS.indexOf(h) + 1);

const SIGNAL = /^HIRING:\s*(.+?)(?:\s*\(posted\s+([^)]+)\))?\s*(https?:\/\/\S+)?\s*(?:\||$)/i;

export function parseSignal(research: string): PipelineRow["signal"] | undefined {
  const m = SIGNAL.exec(research.trim());
  if (!m) return undefined;
  return { role: m[1]!.trim(), ...(m[2] ? { posted: m[2].trim() } : {}), ...(m[3] ? { url: m[3] } : {}) };
}

const WHY: Record<string, string> = {
  MISSING_EMAIL: "No email could be found for this person.",
  SHARED_OR_DUPLICATE_EMAIL: "Two people share this email, so we cannot tell who would read it.",
  ALREADY_CONTACTED: "Someone at this company was emailed recently.",
  OPTED_OUT: "This person asked not to be contacted.",
  CONSUMER_DOMAIN: "The only email is a personal one (gmail, yahoo), not a work address.",
  ROLE_ACCOUNT: "The only email is a shared mailbox such as info@ or hr@.",
  DOMAIN_MISMATCH: "The email domain does not match the company.",
  CURRENT_EMPLOYER_DOMAIN: "This is their work address at the company we are trying to recruit from.",
  ENTITY_MISMATCH: "We could not confirm this person works at this company.",
  NO_MX_RECORD: "The email domain does not accept mail.",
  MAILBOX_INVALID: "The mailbox does not exist.",
  MAILBOX_CATCH_ALL: "The domain accepts every address, so this one cannot be confirmed.",
  MAILBOX_UNKNOWN: "The mail server did not answer; the address could not be checked.",
  MAILBOX_DO_NOT_MAIL: "This address is flagged as unsafe to email.",
  GATE_ERROR: "A check failed to run; the lead was held back rather than passed.",
  DRAFT_ERROR: "The email could not be written.",
};
export const whyText = (reason: string) => WHY[reason] ?? reason.replace(/_/g, " ").toLowerCase();

/** What the console shows. AutoBooker leaves Status = Approved after a failed send and records the failure in SendState. */
export function effectiveStatus(sheetStatus: string, sendState: string): string {
  return sendState === SEND_FAILED ? STATUS.sendError : sheetStatus;
}

/** The tabs that exist, asked once, then every tab read at the same time: two Google round trips, not two per tab. */
async function readTabs(gw: SheetsGateway, tabs: readonly string[], lastCol: string): Promise<Array<{ tab: string; rows: string[][] }>> {
  const existing = new Set((await gw.listTabs()).map((t) => t.title));
  const present = tabs.filter((t) => existing.has(t));
  const values = await Promise.all(present.map((t) => gw.getValues(`${t}!A1:${lastCol}`)));
  return present.map((tab, i) => ({ tab, rows: values[i]! }));
}

export async function readPipeline(gw: SheetsGateway, tabs: PipelineTab[] = PIPELINE_TABS): Promise<PipelineRow[]> {
  const out: PipelineRow[] = [];
  for (const { tab: tabName, rows } of await readTabs(gw, tabs, LAST_P)) {
    const tab = tabName as PipelineTab;
    const headers = (rows[0] ?? []).map((h) => h.trim());
    if (headers.slice(0, PIPELINE_HEADERS.length).join("|") !== PIPELINE_HEADERS.join("|")) {
      throw Object.assign(new Error(`The "${tab}" tab does not have the expected columns (${PIPELINE_HEADERS.join(", ")}).`), { statusCode: 409 });
    }
    // AutoBooker's columns are found by header name, so a tab it has not touched yet (no K-O) still loads.
    const abIndex = (h: (typeof AUTOBOOKER_HEADERS)[number]) => headers.indexOf(h, PIPELINE_HEADERS.length);
    rows.slice(1).forEach((r, i) => {
      const g = (h: (typeof PIPELINE_HEADERS)[number]) => (r[PIPELINE_HEADERS.indexOf(h)] ?? "").trim();
      const ab = (h: (typeof AUTOBOOKER_HEADERS)[number]) => { const idx = abIndex(h); return idx === -1 ? "" : String(r[idx] ?? "").trim(); };
      if (!g("Email") && !g("Name")) return;
      const research = g("Research");
      const sheetStatus = g("Status");
      const sendState = ab("SendState");
      out.push({
        tab, row_number: i + 2,
        company: g("Company"), domain: g("Domain"), name: g("Name"), title: g("Title"), email: g("Email").toLowerCase(),
        research, status: effectiveStatus(sheetStatus, sendState), subject: g("Subject"), body: g("DraftBody"), thread_id: g("ThreadID"),
        ...(parseSignal(research) ? { signal: parseSignal(research) } : {}),
        sheet_status: sheetStatus, send_state: sendState, notes: ab("Notes"), sent_at: ab("SentAt"),
      });
    });
  }
  return out;
}

export async function readQuarantine(gw: SheetsGateway, tabs: readonly string[] = QUARANTINE_TABS): Promise<QuarantineRow[]> {
  const out: QuarantineRow[] = [];
  for (const { tab, rows } of await readTabs(gw, tabs, LAST_Q)) {
    const headers = (rows[0] ?? []).map((h) => h.trim());
    if (headers.join("|") !== QUARANTINED_HEADERS.join("|")) continue;
    rows.slice(1).forEach((r, i) => {
      const g = (h: (typeof QUARANTINED_HEADERS)[number]) => (r[QUARANTINED_HEADERS.indexOf(h)] ?? "").trim();
      if (!g("Company") && !g("Name")) return;
      out.push({
        tab, row_number: i + 2, company: g("Company"), domain: g("Domain"), name: g("Name"), title: g("Title"), email: g("Email"),
        location: g("Location"), failed_gate: g("FailedGate"), reason: g("FailureReason"), campaign: g("Campaign"), run_id: g("RunID"),
        why: whyText(g("FailureReason")),
      });
    });
  }
  return out;
}

export async function findByEmail(gw: SheetsGateway, email: string, tabs: PipelineTab[] = PIPELINE_TABS): Promise<PipelineRow> {
  const want = email.trim().toLowerCase();
  const hits = (await readPipeline(gw, tabs)).filter((r) => r.email === want);
  if (hits.length === 0) throw Object.assign(new Error(`No row found for ${email}.`), { statusCode: 404 });
  if (hits.length > 1) throw Object.assign(new Error(`${hits.length} rows match ${email}. Fix the duplicate in the Sheet first.`), { statusCode: 409 });
  return hits[0]!;
}

/** Status moves a human may make from the UI. Anything else belongs to AutoBooker or the engine. */
const ALLOWED: Record<string, string[]> = {
  [STATUS.approved]: [STATUS.ready, STATUS.needsRewrite],
  [STATUS.rejected]: [STATUS.ready, STATUS.needsRewrite, STATUS.approved, STATUS.sendError],
  [STATUS.ready]: [STATUS.approved, STATUS.rejected, STATUS.needsRewrite, STATUS.sendError],
};

export async function setStatus(gw: SheetsGateway, email: string, next: string): Promise<PipelineRow> {
  const row = await findByEmail(gw, email);
  const from = ALLOWED[next];
  if (!from) throw Object.assign(new Error(`Status "${next}" cannot be set from the UI.`), { statusCode: 400 });
  if (row.status === next) return row;
  if (!from.includes(row.status)) {
    throw Object.assign(new Error(`Cannot move "${row.status}" to "${next}". Allowed from: ${from.join(", ")}.`), { statusCode: 409 });
  }
  await gw.writeValues(`${row.tab}!${col("Status")}${row.row_number}`, [[next]], "raw");
  if (row.send_state === SEND_FAILED) {
    // Leaving a failed send ("Retry send" or Reject): clear AutoBooker's SendState and Notes, otherwise it keeps
    // skipping the row (it never resends a row that has a SendState) even after a fresh approval.
    await gw.writeValues(`${row.tab}!${abCol("SendState")}${row.row_number}:${abCol("Notes")}${row.row_number}`, [["", ""]], "raw");
    return { ...row, status: next, sheet_status: next, send_state: "", notes: "" };
  }
  return { ...row, status: next, sheet_status: next };
}

export async function updateDraft(gw: SheetsGateway, email: string, patch: { subject?: string; body?: string }): Promise<PipelineRow> {
  const row = await findByEmail(gw, email);
  if (![STATUS.ready, STATUS.needsRewrite].includes(row.status as never)) {
    throw Object.assign(new Error(`Only a draft that is "${STATUS.ready}" or "${STATUS.needsRewrite}" can be edited; this one is "${row.status}".`), { statusCode: 409 });
  }
  const subject = patch.subject ?? row.subject;
  const body = patch.body ?? row.body;
  await gw.writeValues(`${row.tab}!${col("Subject")}${row.row_number}:${col("DraftBody")}${row.row_number}`, [[subject, body]], "raw");
  return { ...row, subject, body };
}

/** Counts by status across the given tabs, plus the quarantine total. */
export async function summary(gw: SheetsGateway, pre?: { rows: PipelineRow[]; quarantine: QuarantineRow[] }): Promise<{ by_status: Record<string, number>; quarantined: number; by_reason: Record<string, number> }> {
  // The API passes rows it already holds in its cache, so the summary costs no extra Sheet reads.
  const [rows, q] = pre ? [pre.rows, pre.quarantine] : await Promise.all([readPipeline(gw), readQuarantine(gw)]);
  const by_status: Record<string, number> = {};
  for (const r of rows) by_status[r.status] = (by_status[r.status] ?? 0) + 1;
  const by_reason: Record<string, number> = {};
  for (const r of q) by_reason[r.reason] = (by_reason[r.reason] ?? 0) + 1;
  return { by_status, quarantined: q.length, by_reason };
}
