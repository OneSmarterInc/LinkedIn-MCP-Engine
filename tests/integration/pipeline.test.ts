import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCampaign } from "../../src/config/load.js";
import { openLedger } from "../../src/core/db.js";
import { runVerify, writeReport, formatSummary } from "../../src/core/pipeline.js";
import type { AsyncGates } from "../../src/core/verifier.js";

// Gate 4 and 5 stand-ins with known answers, so the test is offline and exact.
const gates: AsyncGates = {
  entityCheck: async (l) => (l.email?.endsWith("@kettering.edu") ? "ENTITY_MISMATCH" : null),
  mailboxCheck: async (l) => (l.email?.endsWith(".invalid") ? "NO_MX_RECORD" : null),
};

describe("pipeline: dirty CSV through all 5 gates", async () => {
  const cfg = await loadCampaign("campaigns/b2b_healthcare.json");
  const report = await runVerify(cfg, { limit: 100, csvPath: "tests/fixtures/dirty_leads.csv" },
    { ledger: openLedger(":memory:"), gates });

  it("counts every row exactly once", () => {
    expect(report.counts).toEqual({ rows_read: 20, skipped: 2, sourced: 18, passed: 5, quarantined: 13 });
  });

  it("quarantines each row for the right reason", () => {
    expect(report.quarantined_by_reason).toEqual({
      ROLE_ACCOUNT: 4,
      SHARED_OR_DUPLICATE_EMAIL: 3,
      CONSUMER_DOMAIN: 2,
      MISSING_EMAIL: 1,
      DOMAIN_MISMATCH: 1,
      ENTITY_MISMATCH: 1,
      NO_MX_RECORD: 1,
    });
  });

  it("passes the clean leads with cleaned names and emails", () => {
    const names = report.passed.map((l) => `${l.first_name} ${l.last_name} <${l.email}>`).sort();
    expect(names).toEqual([
      "Amy Wong <amy.wong@caresource.com>",
      "Jane Miller <jane.miller@caresource.com>",
      "Mark Davis <mark.davis@kroger.com>",
      "Robert Chen <robert.chen@premierhealth.com>",
      "Susan Patel <susan.patel@reyrey.com>",
    ]);
  });

  it("writes a JSON report and a readable summary", async () => {
    const path = await writeReport(report, mkdtempSync(join(tmpdir(), "out-")));
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.counts.passed).toBe(5);
    expect(formatSummary(report)).toContain("PASSED");
  });
});
