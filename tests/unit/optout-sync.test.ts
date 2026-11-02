import { describe, it, expect, beforeEach, vi } from "vitest";
import { openLedger, type Ledger } from "../../src/core/db.js";
import { formatOptOutSync, syncOptOuts } from "../../src/core/optout-sync.js";
import { verifyBatch, type AsyncGates } from "../../src/core/verifier.js";
import { PIPELINE_HEADERS } from "../../src/core/exporter.js";
import { corporateCfg, makeLead } from "../helpers.js";

/** A Pipeline tab: header + rows of [email, status]; other columns blank. */
function sheet(rows: [string, string][]) {
  const emailCol = PIPELINE_HEADERS.indexOf("Email");
  const statusCol = PIPELINE_HEADERS.indexOf("Status");
  const values = [
    [...PIPELINE_HEADERS],
    ...rows.map(([email, status]) => {
      const r = PIPELINE_HEADERS.map(() => "");
      r[emailCol] = email;
      r[statusCol] = status;
      return r;
    }),
  ];
  const getValues = vi.fn(async (_range: string) => values);
  return { gw: { getValues }, getValues };
}

let ledger: Ledger;
beforeEach(() => { ledger = openLedger(":memory:"); });

describe("syncOptOuts", () => {
  it("adds Opted Out and Bounced rows to the do-not-contact list", async () => {
    const { gw } = sheet([
      ["jane@acme.com", "Opted Out"],
      ["bob@acme.com", "Sent"],
      ["dead@acme.com", "Bounced"],
      ["ann@acme.com", "Meeting Booked"],
    ]);
    const r = await syncOptOuts(gw, ledger);
    expect(r).toMatchObject({ rowsScanned: 4, added: 2, alreadyKnown: 0 });
    expect(ledger.isSuppressed("jane@acme.com")).toBe(true);
    expect(ledger.isSuppressed("dead@acme.com")).toBe(true);
    expect(ledger.isSuppressed("bob@acme.com")).toBe(false);
    expect(ledger.isSuppressed("ann@acme.com")).toBe(false);
  });

  it("matches statuses typed by hand in any case, with spaces", async () => {
    const { gw } = sheet([["a@acme.com", "  opted out "], ["b@acme.com", "UNSUBSCRIBED"], ["c@acme.com", "Do Not Contact"]]);
    expect((await syncOptOuts(gw, ledger)).added).toBe(3);
  });

  it("normalises email case and spaces", async () => {
    const { gw } = sheet([[" Jane@ACME.com ", "Opted Out"]]);
    await syncOptOuts(gw, ledger);
    expect(ledger.isSuppressed("jane@acme.com")).toBe(true);
  });

  it("counts addresses it already knows, and does not add twice", async () => {
    ledger.suppress("jane@acme.com", "earlier");
    const { gw } = sheet([["jane@acme.com", "Opted Out"], ["jane@acme.com", "Opted Out"], ["new@acme.com", "Opted Out"]]);
    const r = await syncOptOuts(gw, ledger);
    expect(r).toMatchObject({ added: 1, alreadyKnown: 1, addedEmails: ["new@acme.com"] });
  });

  it("never removes an opt-out, even if the Sheet row changes later", async () => {
    await syncOptOuts(sheet([["jane@acme.com", "Opted Out"]]).gw, ledger);
    await syncOptOuts(sheet([["jane@acme.com", "Ready for Review"]]).gw, ledger);
    expect(ledger.isSuppressed("jane@acme.com")).toBe(true);
  });

  it("skips blank or broken email cells", async () => {
    const { gw } = sheet([["", "Opted Out"], ["not-an-email", "Opted Out"]]);
    expect((await syncOptOuts(gw, ledger)).added).toBe(0);
  });

  it("only reads the Pipeline tab", async () => {
    const { gw, getValues } = sheet([]);
    await syncOptOuts(gw, ledger);
    expect(getValues.mock.calls[0]![0]).toMatch(/^Pipeline!/);
  });

  it("handles an empty Sheet", async () => {
    const r = await syncOptOuts({ getValues: async () => [] }, ledger);
    expect(r).toMatchObject({ rowsScanned: 0, added: 0 });
  });

  it("stops with a clear error if the columns are missing", async () => {
    await expect(syncOptOuts({ getValues: async () => [["Name", "Company"]] }, ledger)).rejects.toThrow(/Email.*Status/);
  });

  it("passes a Sheet read error up, so the run stops", async () => {
    await expect(syncOptOuts({ getValues: async () => { throw new Error("403 forbidden"); } }, ledger)).rejects.toThrow(/403/);
  });

  it("prints a one-line summary", async () => {
    const r = await syncOptOuts(sheet([["a@acme.com", "Opted Out"]]).gw, ledger);
    expect(formatOptOutSync(r)).toBe("Opt-outs synced from Sheet: 1 new, 0 already known (1 rows checked).");
  });
});

describe("end to end: opt out in the Sheet, then a new run", () => {
  it("rejects the opted-out person as OPTED_OUT in a later run", async () => {
    await syncOptOuts(sheet([["jane.miller@acme.com", "Opted Out"]]).gw, ledger);
    const gates: AsyncGates = { entityCheck: async () => null, mailboxCheck: async () => null };
    const out = await verifyBatch(
      [makeLead({ email: "jane.miller@acme.com" }), makeLead({ lead_id: "other", email: "bob.smith@acme.com", first_name: "Bob", last_name: "Smith" })],
      corporateCfg, ledger, gates,
    );
    expect(out.quarantined.map((q) => q.result.failure_reason)).toEqual(["OPTED_OUT"]);
    expect(out.passed.map((l) => l.email)).toEqual(["bob.smith@acme.com"]);
  });
});
