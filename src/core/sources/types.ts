import { createHash } from "node:crypto";
import type { LeadRecord } from "../../config/schema.js";

export type SkipReason =
  | "BLANK_ROW"
  | "MISSING_NAME"
  | "MISSING_COMPANY"
  | "INVALID_LINKEDIN_URL"
  | "DUPLICATE_PROFILE";

/** A row the source could not turn into a lead. It never reaches the gates. */
export interface SkippedRow {
  row: number;
  reason: SkipReason;
  detail?: string;
}

export interface SourceResult {
  provider: string;
  leads: LeadRecord[];
  skipped: SkippedRow[];
}

/** Stable ID: the same person in the same source always gets the same lead_id across runs. */
export function stableId(prefix: string, ...parts: (string | undefined)[]): string {
  const h = createHash("sha1").update(parts.map((p) => (p ?? "").toLowerCase().trim()).join("|")).digest("hex");
  return `${prefix}-${h.slice(0, 12)}`;
}

const LINKEDIN_PROFILE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]+)\/?(?:\?.*)?$/i;

/** Returns https://www.linkedin.com/in/<slug>, or undefined if it is not a profile URL. */
export function normalizeLinkedinUrl(url: string | undefined | null): string | undefined {
  const m = (url ?? "").trim().match(LINKEDIN_PROFILE);
  return m ? `https://www.linkedin.com/in/${m[1]!.toLowerCase()}` : undefined;
}

export function splitFullName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  // Drop a leading honorific so "Dr. Jane Smith" splits as Jane / Smith. Gate 1 cleans the rest.
  if (parts.length > 2 && /^(dr|mr|mrs|ms|prof)\.?$/i.test(parts[0]!)) parts.shift();
  const first = parts.shift() ?? "";
  return { first, last: parts.join(" ") };
}
