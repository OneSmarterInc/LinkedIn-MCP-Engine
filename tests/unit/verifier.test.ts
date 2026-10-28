import { describe, it, expect, beforeEach } from "vitest";
import { CampaignConfig, type LeadRecord } from "../../src/config/schema.js";
import { openLedger, type Ledger } from "../../src/core/db.js";
import { gate1Sanitize, gate2Dedup, gate3Domain, verifyBatch, type AsyncGates } from "../../src/core/verifier.js";

const corporate = CampaignConfig.parse({
  campaign_name: "test-corp", mode: "CORPORATE", sourcing_provider: "csv_import",
  target_geography: ["Ohio"], decision_maker_titles: ["CFO"],
});
const candidate = CampaignConfig.parse({
  campaign_name: "test-cand", mode: "CANDIDATE", sourcing_provider: "csv_import",
  target_geography: ["Ohio"], decision_maker_titles: ["Engineer"], block_current_employer_domain: true,
});

let n = 0;
function lead(o: Partial<LeadRecord> = {}): LeadRecord {
  n += 1;
  return {
    lead_id: `L${n}`, first_name: "Jane", last_name: "Miller", title: "CFO",
    company_name: "Acme", company_domain: "acme.com", location: "Dayton, OH",
    email: `jane${n}@acme.com`, source: "csv_import", ...o,
  };
}
const allPass: AsyncGates = { entityCheck: async () => null, mailboxCheck: async () => null };

let ledger: Ledger;
beforeEach(() => { ledger = openLedger(":memory:"); });

describe("gate 1: sanitize", () => {
  it("strips titles and credentials", () => {
    const r = gate1Sanitize(lead({ first_name: "Dr. John", last_name: "Smith, MD" }));
    expect("lead" in r && r.lead.first_name).toBe("John");
    expect("lead" in r && r.lead.last_name).toBe("Smith");
  });
  it("removes newlines and extra spaces", () => {
    const r = gate1Sanitize(lead({ first_name: "  Ja\nne ", company_name: "Acme\r\n Corp" }));
    expect("lead" in r && r.lead.company_name).toBe("Acme Corp");
  });
  it("strips DO but keeps the surname Do", () => {
    const a = gate1Sanitize(lead({ last_name: "Nguyen DO" }));
    const b = gate1Sanitize(lead({ last_name: "Do" }));
    expect("lead" in a && a.lead.last_name).toBe("Nguyen");
    expect("lead" in b && b.lead.last_name).toBe("Do");
  });
  it("quarantines missing email", () => {
    expect(gate1Sanitize(lead({ email: undefined }))).toEqual({ reason: "MISSING_EMAIL" });
  });
});

describe("gate 2: dedup", () => {
  it("quarantines ALL people sharing one email", () => {
    const shared = "assistant@acme.com";
    const r = gate2Dedup([
      lead({ email: shared, first_name: "Ann" }),
      lead({ email: shared, first_name: "Bob" }),
    ], ledger);
    expect(r.kept).toHaveLength(0);
    expect(r.failed.every((f) => f.result.failure_reason === "SHARED_OR_DUPLICATE_EMAIL")).toBe(true);
  });
  it("keeps one copy of the same person listed twice", () => {
    const l = lead();
    const r = gate2Dedup([l, { ...l, lead_id: "dup" }], ledger);
    expect(r.kept).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
  });
  it("blocks opted-out and already-contacted emails", () => {
    ledger.suppress("out@acme.com", "unsubscribed");
    ledger.recordContact({ email: "old@acme.com", lead_id: "X", full_name: "Old", campaign: "c", status: "sent" });
    const r = gate2Dedup([lead({ email: "out@acme.com" }), lead({ email: "old@acme.com" })], ledger);
    expect(r.failed.map((f) => f.result.failure_reason).sort()).toEqual(["ALREADY_CONTACTED", "OPTED_OUT"]);
  });
});

describe("gate 3: CORPORATE mode", () => {
  it.each([
    ["info@acme.com", "ROLE_ACCOUNT"],
    ["volunteer@acme.com", "ROLE_ACCOUNT"],
    ["hr.team@acme.com", "ROLE_ACCOUNT"],
    ["jane@gmail.com", "CONSUMER_DOMAIN"],
    ["jane@otherco.com", "DOMAIN_MISMATCH"],
  ])("%s -> %s", (email, reason) => {
    expect(gate3Domain(lead({ email }), corporate)).toBe(reason);
  });
  it("allows matching domain and subdomains", () => {
    expect(gate3Domain(lead({ email: "jane@acme.com" }), corporate)).toBeNull();
    expect(gate3Domain(lead({ email: "jane@mail.acme.com" }), corporate)).toBeNull();
  });
  it("does not treat 'helena@' as the role 'help@'", () => {
    expect(gate3Domain(lead({ email: "helena@acme.com" }), corporate)).toBeNull();
  });
});

describe("gate 3: CANDIDATE mode", () => {
  it("allows personal email", () => {
    expect(gate3Domain(lead({ email: "jane@gmail.com" }), candidate)).toBeNull();
  });
  it("blocks current employer domain", () => {
    expect(gate3Domain(lead({ email: "jane@acme.com" }), candidate)).toBe("CURRENT_EMPLOYER_DOMAIN");
  });
});

describe("verifyBatch", () => {
  it("routes each lead to the right place", async () => {
    const out = await verifyBatch([
      lead({ email: "good@acme.com" }),
      lead({ email: "info@acme.com" }),
      lead({ email: "x@gmail.com" }),
      lead({ email: undefined }),
    ], corporate, ledger, allPass);
    expect(out.passed).toHaveLength(1);
    expect(out.quarantined).toHaveLength(3);
  });
  it("stops at gate 4 and gate 5 when they fail", async () => {
    const gates: AsyncGates = {
      entityCheck: async (l) => (l.location.includes("OK") ? "ENTITY_MISMATCH" : null),
      mailboxCheck: async (l) => (l.email?.startsWith("dead") ? "MAILBOX_INVALID" : null),
    };
    const out = await verifyBatch([
      lead({ email: "ok@acme.com", location: "Tulsa, OK" }),
      lead({ email: "dead@acme.com" }),
    ], corporate, ledger, gates);
    expect(out.quarantined.map((q) => q.result.failed_gate).sort()).toEqual([4, 5]);
  });
});