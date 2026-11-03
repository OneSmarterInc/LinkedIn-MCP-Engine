import type { Ledger } from "./db.js";
import { JOB_TABS, TAB, type SheetsGateway } from "./exporter.js";

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
  /** Rows read from Pipeline and Jobs_Pipeline (headers not counted). */
  rowsScanned: number;
  /** Do-not-contact emails added to the ledger in this sync. */
  added: number;
  /** Do-not-contact emails the ledger already had. */
  alreadyKnown: number;
  addedEmails: string[];
}

/**
 * Copies every Opted Out / Bounced address from the Sheet's Pipeline tab, and from Jobs_Pipeline when it
 * exists, into the ledger's suppression list, so Gate 2 rejects it (OPTED_OUT) in every future run.
 * Someone who opts out from a job email is never written to from a lead campaign, and the other way round.
 *
 * Read-only on the Sheet. Only ever adds to the ledger, never removes.
 * Throws if the Pipeline tab cannot be read or a tab's headers are missing: a run should stop
 * rather than risk emailing someone who asked us to stop.
 */
export async function syncOptOuts(
  gw: Pick<SheetsGateway, "getValues"> & Partial<Pick<SheetsGateway, "listTabs">>,
  ledger: Pick<Ledger, "isSuppressed" | "suppress">,
): Promise<OptOutSyncResult> {
  const result: OptOutSyncResult = { rowsScanned: 0, added: 0, alreadyKnown: 0, addedEmails: [] };
  const seen = new Set<string>();

  // Jobs_Pipeline is read only when the Sheet has it (it appears after the first search_jobs run).
  const tabs: string[] = [TAB.pipeline];
  if (gw.listTabs && (await gw.listTabs()).some((t) => t.title === JOB_TABS.pipeline)) tabs.push(JOB_TABS.pipeline);

  for (const tab of tabs) {
    const rows = await gw.getValues(`${tab}!A1:Z`);
    if (rows.length === 0) continue;

    const headers = rows[0]!.map((h) => String(h ?? "").trim().toLowerCase());
    const emailCol = headers.indexOf("email");
    const statusCol = headers.indexOf("status");
    if (emailCol === -1 || statusCol === -1) {
      throw new Error(`Opt-out sync: the ${tab} tab has no "Email" or "Status" column.`);
    }
    result.rowsScanned += rows.length - 1;

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
  }
  return result;
}

export function formatOptOutSync(r: OptOutSyncResult): string {
  return `Opt-outs synced from Sheet: ${r.added} new, ${r.alreadyKnown} already known (${r.rowsScanned} rows checked).`;
}
