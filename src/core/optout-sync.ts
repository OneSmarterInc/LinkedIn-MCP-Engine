import type { Ledger } from "./db.js";
import { TAB, type SheetsGateway } from "./exporter.js";

/**
 * Sheet statuses that mean "never contact this address again".
 * Matched case-insensitively, so a status typed by hand still counts.
 */
export const DO_NOT_CONTACT_STATUSES: Record<string, string> = {
  "opted out": "OPTED_OUT",
  "unsubscribed": "OPTED_OUT",
  "do not contact": "OPTED_OUT",
  "bounced": "BOUNCED",
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OptOutSyncResult {
  /** Pipeline rows read (header not counted). */
  rowsScanned: number;
  /** Do-not-contact emails added to the ledger in this sync. */
  added: number;
  /** Do-not-contact emails the ledger already had. */
  alreadyKnown: number;
  addedEmails: string[];
}

/**
 * Copies every Opted Out / Bounced address from the Sheet's Pipeline tab into the ledger's
 * suppression list, so Gate 2 rejects it (OPTED_OUT) in every future run and campaign.
 *
 * Read-only on the Sheet. Only ever adds to the ledger, never removes.
 * Throws if the Sheet cannot be read or its headers are missing: a run should stop
 * rather than risk emailing someone who asked us to stop.
 */
export async function syncOptOuts(
  gw: Pick<SheetsGateway, "getValues">,
  ledger: Pick<Ledger, "isSuppressed" | "suppress">,
): Promise<OptOutSyncResult> {
  const rows = await gw.getValues(`${TAB.pipeline}!A1:Z`);
  if (rows.length === 0) return { rowsScanned: 0, added: 0, alreadyKnown: 0, addedEmails: [] };

  const headers = rows[0]!.map((h) => String(h ?? "").trim().toLowerCase());
  const emailCol = headers.indexOf("email");
  const statusCol = headers.indexOf("status");
  if (emailCol === -1 || statusCol === -1) {
    throw new Error(`Opt-out sync: the ${TAB.pipeline} tab has no "Email" or "Status" column.`);
  }

  const result: OptOutSyncResult = { rowsScanned: rows.length - 1, added: 0, alreadyKnown: 0, addedEmails: [] };
  const seen = new Set<string>();

  for (const row of rows.slice(1)) {
    const status = String(row[statusCol] ?? "").trim().toLowerCase();
    const reason = DO_NOT_CONTACT_STATUSES[status];
    if (!reason) continue;

    const email = String(row[emailCol] ?? "").trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email) || seen.has(email)) continue;
    seen.add(email);

    if (ledger.isSuppressed(email)) {
      result.alreadyKnown += 1;
    } else {
      ledger.suppress(email, `${reason} (from Sheet)`);
      result.added += 1;
      result.addedEmails.push(email);
    }
  }
  return result;
}

export function formatOptOutSync(r: OptOutSyncResult): string {
  return `Opt-outs synced from Sheet: ${r.added} new, ${r.alreadyKnown} already known (${r.rowsScanned} rows checked).`;
}
