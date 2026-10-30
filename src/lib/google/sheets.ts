import { existsSync, readFileSync } from "node:fs";
import { google, type sheets_v4 } from "googleapis";
import type { SheetsGateway, SheetTabInfo } from "../../core/exporter.js";
import { AbortError, withRetry } from "../retry.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_KEY_PATH = "secrets/google-sa.json";

/** Accepts a bare Sheet ID or the whole URL (…/spreadsheets/d/<ID>/edit). */
export function parseSheetId(input: string): string {
  const s = input.trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(s);
  return m?.[1] ?? s;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const n = Number(e.response?.status ?? e.status ?? e.code);
  return Number.isFinite(n) ? n : undefined;
}

/** Turns a Google API error into a message that says what to do. 429 and 5xx are retried; anything else stops. */
function friendly(err: unknown, label: string, serviceAccount: string, sheetId: string): Error {
  const status = statusOf(err);
  const raw = (err as Error).message ?? String(err);
  if (status === 403) {
    return new AbortError(
      `Google refused access (403) while ${label}. Share the Sheet with ${serviceAccount} as Editor, ` +
      `and make sure the Google Sheets API is enabled in that service account's Google Cloud project. (${raw})`,
    );
  }
  if (status === 404) return new AbortError(`Sheet not found (404) while ${label}. Check GOOGLE_SHEET_ID: "${sheetId}".`);
  if (status === 401) return new AbortError(`Google rejected the service account key (401). Check ${DEFAULT_KEY_PATH}. (${raw})`);
  // 429, 5xx and network errors (no HTTP status) are temporary, so they are retried.
  if (status === undefined || status === 429 || status >= 500) return new Error(`${label}: ${raw}`);
  return new AbortError(`${label}: ${raw}`);
}

export interface SheetsEnv {
  GOOGLE_SA_JSON_PATH?: string;
  GOOGLE_SHEET_ID?: string;
}

/** Real Google Sheets connection, using a service account (a robot identity, no login needed). */
export function createSheetsGateway(env: SheetsEnv = process.env): SheetsGateway {
  const keyPath = env.GOOGLE_SA_JSON_PATH?.trim() || DEFAULT_KEY_PATH;
  if (!env.GOOGLE_SHEET_ID?.trim()) {
    throw new Error("GOOGLE_SHEET_ID is empty. Put the ID from the Sheet URL (between /d/ and /edit) in .env.");
  }
  if (!existsSync(keyPath)) {
    throw new Error(`Service account key not found at ${keyPath}. Set GOOGLE_SA_JSON_PATH or save the key there.`);
  }
  let serviceAccount = "the service account";
  try {
    const key = JSON.parse(readFileSync(keyPath, "utf8")) as { client_email?: string };
    if (key.client_email) serviceAccount = key.client_email;
  } catch {
    throw new Error(`${keyPath} is not valid JSON. Download the service account key again.`);
  }

  const spreadsheetId = parseSheetId(env.GOOGLE_SHEET_ID);
  const auth = new google.auth.GoogleAuth({ keyFile: keyPath, scopes: [SCOPE] });
  const api = google.sheets({ version: "v4", auth });

  /** retryServerErrors=false for appends: a timed-out append may have worked, and retrying could add rows twice. */
  const call = <T>(label: string, fn: () => Promise<T>, retryServerErrors = true): Promise<T> =>
    withRetry(async () => {
      try {
        return await fn();
      } catch (err) {
        const mapped = friendly(err, label, serviceAccount, spreadsheetId);
        if (!retryServerErrors && statusOf(err) !== 429 && !(mapped instanceof AbortError)) {
          throw new AbortError(mapped.message);
        }
        throw mapped;
      }
    }, label);

  return {
    async listTabs(): Promise<SheetTabInfo[]> {
      const res = await call("reading the Sheet", () =>
        api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" }));
      return (res.data.sheets ?? []).flatMap((s) =>
        s.properties?.title != null && s.properties.sheetId != null
          ? [{ title: s.properties.title, sheetId: s.properties.sheetId }]
          : []);
    },

    async addTabs(titles: string[]): Promise<SheetTabInfo[]> {
      const res = await call("adding tabs", () =>
        api.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: titles.map((title) => ({ addSheet: { properties: { title } } })) },
        }), false);
      return (res.data.replies ?? []).flatMap((r) => {
        const p = r.addSheet?.properties;
        return p?.title != null && p.sheetId != null ? [{ title: p.title, sheetId: p.sheetId }] : [];
      });
    },

    async batchUpdate(requests: object[]): Promise<void> {
      await call("formatting the Sheet", () =>
        api.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: requests as sheets_v4.Schema$Request[] },
        }));
    },

    async getValues(range: string): Promise<string[][]> {
      const res = await call(`reading ${range}`, () => api.spreadsheets.values.get({ spreadsheetId, range }));
      return (res.data.values ?? []).map((row) => row.map((c) => String(c ?? "")));
    },

    async writeValues(range, values, mode): Promise<void> {
      await call(`writing ${range}`, () =>
        api.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: mode === "formulas" ? "USER_ENTERED" : "RAW",
          requestBody: { values },
        }));
    },

    async appendValues(range, values): Promise<void> {
      await call(`appending to ${range}`, () =>
        api.spreadsheets.values.append({
          spreadsheetId,
          range,
          valueInputOption: "RAW",
          // OVERWRITE writes into the empty rows below the table. INSERT_ROWS would push the Status dropdown
          // down and copy the header formatting onto the new rows.
          insertDataOption: "OVERWRITE",
          requestBody: { values },
        }), false);
    },
  };
}
