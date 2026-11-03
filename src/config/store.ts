import { readFile } from "node:fs/promises";
import { z } from "zod";
import { colLetter, type SheetsGateway } from "../core/exporter.js";
import { CampaignConfig, Mode, SourcingProvider } from "./schema.js";

/**
 * Where campaigns live.
 *
 * In development a campaign is a JSON file (campaigns/*.json). In production it is a row in the
 * "Campaigns" tab of the same Google Sheet the team already uses, so a person can add or pause a
 * campaign without a developer or a deploy. Both paths end in the same CampaignConfig object, so
 * nothing downstream knows the difference.
 */

export const CAMPAIGNS_TAB = "Campaigns";

/** Column order of the Campaigns tab. The engine writes Status and UpdatedAt; people fill in the rest. */
export const CAMPAIGN_HEADERS = [
  "Name", "Active", "Mode", "Provider", "States", "Titles", "Keywords", "SignalQuery", "Persona",
  "SenderCompany", "Offer", "MeetingMinutes", "DailyCap", "BlockEmployerDomain", "CsvPath", "Status", "UpdatedAt",
] as const;
export type CampaignHeader = (typeof CAMPAIGN_HEADERS)[number];

const LAST = colLetter(CAMPAIGN_HEADERS.length);
const colIndex = (h: CampaignHeader) => CAMPAIGN_HEADERS.indexOf(h);
const colOf = (h: CampaignHeader) => colLetter(colIndex(h) + 1);

export interface CampaignSummary {
  name: string;
  active: boolean;
  mode: string;
  status: string;
  rowNumber: number;
}

export interface CampaignStore {
  readonly kind: "file" | "sheet";
  list(): Promise<CampaignSummary[]>;
  get(name: string): Promise<CampaignConfig>;
  /** Adds a campaign (or replaces the row with the same name). Writes Status = OK. */
  save(cfg: CampaignConfig, opts?: { active?: boolean }): Promise<CampaignSummary>;
  setActive(name: string, active: boolean): Promise<void>;
  /** Re-checks every row and writes OK or a plain-words problem into its Status cell. */
  validateAll(): Promise<CampaignSummary[]>;
}

// ---------------------------------------------------------------------------
// Row <-> CampaignConfig
// ---------------------------------------------------------------------------

/** "Ohio, Indiana ,Michigan" -> ["Ohio", "Indiana", "Michigan"]. Semicolons and newlines also split. */
export function splitList(cell: string | undefined): string[] {
  return String(cell ?? "").split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

export function isTrue(cell: string | undefined): boolean {
  return /^(true|yes|y|1|x|✓)$/i.test(String(cell ?? "").trim());
}

/** Turns one Zod issue into a sentence a non-developer can act on. */
function plainIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.map(String).join(".") || "row";
  const nice: Record<string, string> = {
    campaign_name: "Name", mode: "Mode", sourcing_provider: "Provider", target_geography: "States",
    decision_maker_titles: "Titles", industry_keywords: "Keywords", signal_query: "SignalQuery",
    outreach_persona: "Persona", sender_company: "SenderCompany", offer: "Offer",
    calendar_duration_minutes: "MeetingMinutes", daily_send_cap: "DailyCap",
    block_current_employer_domain: "BlockEmployerDomain", csv_path: "CsvPath",
  };
  const label = nice[field] ?? field;
  if (issue.code === "too_small" && "minimum" in issue && issue.minimum === 1) return `${label} is empty`;
  if (issue.code === "invalid_value" && "values" in issue) return `${label} must be one of: ${(issue.values as string[]).join(", ")}`;
  if (issue.code === "invalid_type") return `${label} has the wrong kind of value (${issue.message})`;
  return `${label}: ${issue.message}`;
}

export interface RowParse {
  name: string;
  active: boolean;
  config?: CampaignConfig;
  error?: string;
}

/** Builds a CampaignConfig from a header row and a data row. Never throws; the problem comes back as text. */
export function rowToCampaign(headers: readonly string[], row: readonly string[]): RowParse {
  const get = (h: CampaignHeader) => {
    const i = headers.indexOf(h);
    return i === -1 ? "" : String(row[i] ?? "").trim();
  };
  const name = get("Name");
  const active = isTrue(get("Active"));
  const mode = get("Mode").toUpperCase();
  const num = (h: CampaignHeader) => (get(h) === "" ? undefined : Number(get(h)));

  const raw: Record<string, unknown> = {
    campaign_name: name,
    mode,
    sourcing_provider: get("Provider") || "gemini_xray",
    target_geography: splitList(get("States")),
    decision_maker_titles: splitList(get("Titles")),
    industry_keywords: splitList(get("Keywords")),
    ...(get("SignalQuery") ? { signal_query: get("SignalQuery") } : {}),
    ...(get("Persona") ? { outreach_persona: get("Persona") } : {}),
    ...(get("SenderCompany") ? { sender_company: get("SenderCompany") } : {}),
    ...(get("Offer") ? { offer: get("Offer") } : {}),
    ...(num("MeetingMinutes") !== undefined ? { calendar_duration_minutes: num("MeetingMinutes") } : {}),
    ...(num("DailyCap") !== undefined ? { daily_send_cap: num("DailyCap") } : {}),
    // A candidate campaign must never email someone at their current job. Derive it from Mode unless the cell says otherwise.
    block_current_employer_domain: get("BlockEmployerDomain") ? isTrue(get("BlockEmployerDomain")) : mode === "CANDIDATE",
    ...(get("CsvPath") ? { csv_path: get("CsvPath") } : {}),
  };

  const problems: string[] = [];
  if (!name) problems.push("Name is empty");
  if (!raw.sender_company) problems.push("SenderCompany is empty");
  if (!raw.offer) problems.push("Offer is empty (one sentence: the only thing the email may offer)");

  const parsed = CampaignConfig.safeParse(raw);
  if (!parsed.success) problems.push(...parsed.error.issues.map(plainIssue));
  if (problems.length) return { name, active, error: [...new Set(problems)].join("; ") };
  return { name, active, config: parsed.data };
}

/** The reverse: a CampaignConfig as a Sheet row, in CAMPAIGN_HEADERS order. */
export function campaignToRow(cfg: CampaignConfig, active: boolean, status = "OK", updatedAt = new Date()): string[] {
  const cells: Record<CampaignHeader, string> = {
    Name: cfg.campaign_name,
    Active: active ? "TRUE" : "FALSE",
    Mode: cfg.mode,
    Provider: cfg.sourcing_provider,
    States: cfg.target_geography.join(", "),
    Titles: cfg.decision_maker_titles.join(", "),
    Keywords: cfg.industry_keywords.join(", "),
    SignalQuery: cfg.signal_query ?? "",
    Persona: cfg.outreach_persona ?? "",
    SenderCompany: cfg.sender_company ?? "",
    Offer: cfg.offer ?? "",
    MeetingMinutes: String(cfg.calendar_duration_minutes),
    DailyCap: String(cfg.daily_send_cap),
    BlockEmployerDomain: cfg.block_current_employer_domain ? "TRUE" : "FALSE",
    CsvPath: cfg.csv_path ?? "",
    Status: status,
    UpdatedAt: updatedAt.toISOString(),
  };
  return CAMPAIGN_HEADERS.map((h) => cells[h]);
}

// ---------------------------------------------------------------------------
// File store: campaigns/*.json (development and tests)
// ---------------------------------------------------------------------------

export function fileCampaignStore(): CampaignStore {
  const fail = (): never => { throw new Error("A JSON campaign is read-only here. Edit the file, or use the Sheet store."); };
  return {
    kind: "file",
    async list() { return []; },
    async get(path) {
      const raw = JSON.parse(await readFile(path, "utf8"));
      const result = CampaignConfig.safeParse(raw);
      if (!result.success) throw new Error(`Invalid campaign file ${path}:\n${result.error.issues.map(plainIssue).join("\n")}`);
      return result.data;
    },
    save: fail,
    setActive: fail,
    async validateAll() { return []; },
  };
}

// ---------------------------------------------------------------------------
// Sheet store: the "Campaigns" tab
// ---------------------------------------------------------------------------

export function sheetCampaignStore(gw: SheetsGateway): CampaignStore {
  /** Creates the tab with headers, the Mode/Provider dropdowns, and an Active checkbox. Safe to call every time. */
  async function ensureTab(): Promise<void> {
    let tab = (await gw.listTabs()).find((t) => t.title === CAMPAIGNS_TAB);
    if (!tab) tab = (await gw.addTabs([CAMPAIGNS_TAB]))[0]!;
    const current = ((await gw.getValues(`${CAMPAIGNS_TAB}!A1:${LAST}1`))[0] ?? []).map((c) => c.trim());
    if (current.every((c) => c === "")) {
      await gw.writeValues(`${CAMPAIGNS_TAB}!A1:${LAST}1`, [[...CAMPAIGN_HEADERS]], "raw");
      const sheetId = tab.sheetId;
      const oneOf = (h: CampaignHeader, values: readonly string[]) => ({
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: colIndex(h), endColumnIndex: colIndex(h) + 1 },
          rule: { condition: { type: "ONE_OF_LIST", values: values.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: true },
        },
      });
      const checkbox = (h: CampaignHeader) => ({
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: colIndex(h), endColumnIndex: colIndex(h) + 1 },
          rule: { condition: { type: "BOOLEAN" }, showCustomUi: true, strict: true },
        },
      });
      await gw.batchUpdate([
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        oneOf("Mode", Mode.options),
        oneOf("Provider", SourcingProvider.options),
        checkbox("Active"),
        checkbox("BlockEmployerDomain"),
      ]);
      return;
    }
    if (CAMPAIGN_HEADERS.some((h, i) => current[i] !== h)) {
      throw new Error(
        `The "${CAMPAIGNS_TAB}" tab has unexpected headers. Expected: ${CAMPAIGN_HEADERS.join(", ")}. ` +
        `Found: ${current.join(", ")}. Fix the header row; nothing was changed.`,
      );
    }
  }

  async function readAll(): Promise<{ headers: string[]; rows: string[][] }> {
    await ensureTab();
    const all = await gw.getValues(`${CAMPAIGNS_TAB}!A1:${LAST}`);
    const headers = (all[0] ?? []).map((c) => c.trim());
    return { headers, rows: all.slice(1) };
  }

  async function writeStatus(rowNumber: number, status: string): Promise<void> {
    await gw.writeValues(`${CAMPAIGNS_TAB}!${colOf("Status")}${rowNumber}:${colOf("UpdatedAt")}${rowNumber}`, [[status, new Date().toISOString()]], "raw");
  }

  const summary = (p: RowParse, rowNumber: number): CampaignSummary => ({
    name: p.name, active: p.active, mode: p.config?.mode ?? "", status: p.error ? `ERROR: ${p.error}` : "OK", rowNumber,
  });

  async function findRow(name: string): Promise<{ rowNumber: number; parse: RowParse } | undefined> {
    const { headers, rows } = await readAll();
    const want = name.trim().toLowerCase();
    for (let i = 0; i < rows.length; i++) {
      const p = rowToCampaign(headers, rows[i]!);
      if (p.name.toLowerCase() === want) return { rowNumber: i + 2, parse: p };
    }
    return undefined;
  }

  return {
    kind: "sheet",

    async list() {
      const { headers, rows } = await readAll();
      return rows.map((r, i) => summary(rowToCampaign(headers, r), i + 2)).filter((s) => s.name);
    },

    async get(name) {
      const hit = await findRow(name);
      if (!hit) {
        const names = (await this.list()).map((s) => s.name);
        throw new Error(`No campaign named "${name}" in the ${CAMPAIGNS_TAB} tab. Known: ${names.join(", ") || "(none)"}.`);
      }
      if (hit.parse.error) {
        await writeStatus(hit.rowNumber, `ERROR: ${hit.parse.error}`);
        throw new Error(`Campaign "${name}" is not valid: ${hit.parse.error}`);
      }
      return hit.parse.config!;
    },

    async save(cfg, opts = {}) {
      const existing = await findRow(cfg.campaign_name);
      const active = opts.active ?? existing?.parse.active ?? false;
      const row = campaignToRow(cfg, active);
      if (existing) {
        await gw.writeValues(`${CAMPAIGNS_TAB}!A${existing.rowNumber}:${LAST}${existing.rowNumber}`, [row], "raw");
        return { name: cfg.campaign_name, active, mode: cfg.mode, status: "OK", rowNumber: existing.rowNumber };
      }
      // Two cases. If blank rows exist (checkbox cells hold FALSE, so Google's append would skip past them to row 1001),
      // write into the first row with no Name. If the grid has no spare row at all, append: a direct write to a row
      // beyond the grid fails with "exceeds grid limits", while append grows the sheet.
      const { rows } = await readAll();
      const nameIdx = colIndex("Name");
      const target = rows.findIndex((r) => !(r[nameIdx] ?? "").trim());
      if (target !== -1) {
        const rowNumber = target + 2;
        await gw.writeValues(`${CAMPAIGNS_TAB}!A${rowNumber}:${LAST}${rowNumber}`, [row], "raw");
        return { name: cfg.campaign_name, active, mode: cfg.mode, status: "OK", rowNumber };
      }
      await gw.appendValues(`${CAMPAIGNS_TAB}!A1:${LAST}`, [row]);
      return { name: cfg.campaign_name, active, mode: cfg.mode, status: "OK", rowNumber: rows.length + 2 };
    },

    async setActive(name, active) {
      const hit = await findRow(name);
      if (!hit) throw new Error(`No campaign named "${name}".`);
      if (active && hit.parse.error) throw new Error(`Cannot activate "${name}" until it is valid: ${hit.parse.error}`);
      await gw.writeValues(`${CAMPAIGNS_TAB}!${colOf("Active")}${hit.rowNumber}`, [[active ? "TRUE" : "FALSE"]], "raw");
      await writeStatus(hit.rowNumber, hit.parse.error ? `ERROR: ${hit.parse.error}` : "OK");
    },

    async validateAll() {
      const { headers, rows } = await readAll();
      const out: CampaignSummary[] = [];
      for (let i = 0; i < rows.length; i++) {
        const p = rowToCampaign(headers, rows[i]!);
        if (!p.name && rows[i]!.every((c) => !c.trim())) continue;
        const s = summary(p, i + 2);
        await writeStatus(s.rowNumber, s.status);
        out.push(s);
      }
      return out;
    },
  };
}

/** A path ending in .json is a file. Anything else is the Name of a row in the Campaigns tab. */
export function isCampaignFile(ref: string): boolean {
  return /\.json$/i.test(ref.trim());
}
