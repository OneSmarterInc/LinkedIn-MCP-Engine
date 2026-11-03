import { describe, it, expect, vi } from "vitest";
import { CampaignConfig } from "../../src/config/schema.js";
import { gate3Domain } from "../../src/core/verifier.js";
import { makeMailboxCheck, type MailboxVerifier } from "../../src/core/gates/mailbox.js";
import { apolloEmailFinder, seamlessEmailFinder } from "../../src/core/sources/email-finder.js";
import { viewRun } from "../../src/mcp/run-view.js";
import type { McpRunState } from "../../src/mcp/run-store.js";
import { makeLead } from "../helpers.js";

// All people, companies and emails here are made up.

const corporate = CampaignConfig.parse({
  campaign_name: "test-corp", mode: "CORPORATE", sourcing_provider: "csv_import",
  target_geography: ["Ohio"], decision_maker_titles: ["CFO"],
});

describe("Fix 1: Gate 3 lets lookup emails on another company domain through to Gate 4", () => {
  const onAlias = (email_source: "seamless" | "apollo" | "search" | "csv" | "pattern") =>
    makeLead({ email: "jane.miller@acmecorp.com", company_domain: "acme.com", email_source });

  it.each(["seamless", "apollo"] as const)("%s email on acmecorp.com for acme.com -> passes Gate 3", (src) => {
    expect(gate3Domain(onAlias(src), corporate)).toBeNull();
  });
  it.each(["search", "csv", "pattern"] as const)("%s email on acmecorp.com for acme.com -> DOMAIN_MISMATCH", (src) => {
    expect(gate3Domain(onAlias(src), corporate)).toBe("DOMAIN_MISMATCH");
  });
  it("still blocks consumer inboxes from a lookup service", () => {
    expect(gate3Domain(makeLead({ email: "jane@gmail.com", email_source: "seamless" }), corporate)).toBe("CONSUMER_DOMAIN");
  });
  it("still blocks role accounts from a lookup service", () => {
    expect(gate3Domain(makeLead({ email: "info@acmecorp.com", email_source: "apollo" }), corporate)).toBe("ROLE_ACCOUNT");
  });
});

describe("Fix 2: emails written by the AI search are guesses", () => {
  const goodMx = async () => [{ exchange: "mx.acme.com", priority: 10 }];
  const devSkip: MailboxVerifier = { name: "dev_skip", verify: async () => null };
  const zeroBounce: MailboxVerifier = { name: "zerobounce", verify: async () => null };

  it("Gate 5 blocks a search email under dev_skip", async () => {
    const check = makeMailboxCheck({ verifier: devSkip, resolveMx: goodMx });
    expect(await check(makeLead({ email_source: "search" }))).toBe("UNVERIFIED_GUESS");
  });
  it("Gate 5 passes a search email that ZeroBounce confirms", async () => {
    const check = makeMailboxCheck({ verifier: zeroBounce, resolveMx: goodMx });
    expect(await check(makeLead({ email_source: "search" }))).toBeNull();
  });
  it("Gate 5 still passes Seamless and CSV emails under dev_skip", async () => {
    const check = makeMailboxCheck({ verifier: devSkip, resolveMx: goodMx });
    expect(await check(makeLead({ email_source: "seamless" }))).toBeNull();
    expect(await check(makeLead({ email_source: "csv" }))).toBeNull();
  });

  const apolloFetch = (email?: string) =>
    vi.fn(async () => new Response(JSON.stringify({ person: email ? { email } : null }), { status: 200 })) as unknown as typeof fetch;

  it("Apollo finder looks up again when the search wrote the email, and uses Apollo's answer", async () => {
    const fetchFn = apolloFetch("jane.miller@acme.com");
    const f = apolloEmailFinder({ apiKey: "k", guessPattern: false, fetchFn });
    expect(await f.find(makeLead({ email: "jmiller@acme.com", email_source: "search" })))
      .toEqual({ email: "jane.miller@acme.com", email_source: "apollo" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("Apollo finder keeps the search email, still labelled search, when Apollo has none", async () => {
    const f = apolloEmailFinder({ apiKey: "k", guessPattern: true, fetchFn: apolloFetch() });
    expect(await f.find(makeLead({ email: "jmiller@acme.com", email_source: "search" })))
      .toEqual({ email: "jmiller@acme.com", email_source: "search" });
  });
  it("an email with no label counts as a search email", async () => {
    const fetchFn = apolloFetch("jane.miller@acme.com");
    const f = apolloEmailFinder({ apiKey: "k", guessPattern: false, fetchFn });
    await f.find(makeLead({ email: "jmiller@acme.com", email_source: undefined }));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("Seamless finder looks up again when the search wrote the email", async () => {
    let i = 0;
    const replies = [
      { requestIds: ["req-1"] },
      { data: [{ requestId: "req-1", status: "done", contact: { email: "jane.miller@acme.com" } }] },
    ];
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(replies[Math.min(i++, 1)]), { status: 200 })) as unknown as typeof fetch;
    const f = seamlessEmailFinder({ apiKey: "k", guessPattern: false, fetchFn, poll: { pollMs: 0, maxWaitMs: 2_000 } });
    expect(await f.find(makeLead({ email: "jmiller@acme.com", email_source: "search" })))
      .toEqual({ email: "jane.miller@acme.com", email_source: "seamless" });
  });
});

describe("Fix 3: get_run view", () => {
  const cfg = corporate;
  const a = makeLead({ lead_id: "A", first_name: "Jane", last_name: "Miller", email_source: "seamless" });
  const b = makeLead({ lead_id: "B", first_name: "Raj", last_name: "Patel", email: "raj@otherco.com", email_source: "search" });
  const c = makeLead({ lead_id: "C", first_name: "Ana", last_name: "Lopez" });

  const base: McpRunState = {
    run_id: "mcp-00000000-0000-0000-0000-000000000001",
    status: "SOURCED",
    campaign_path: "x.json",
    config: cfg,
    source: { provider: "gemini_xray", leads: [a, b, c], skipped: [] },
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };

  it("shows NOT VERIFIED YET before verify_leads", () => {
    const v = viewRun(base);
    expect(v.counts).toEqual({ sourced: 3, with_email: 3, skipped: 0 });
    expect(v.leads.map((l) => l.result)).toEqual(["NOT VERIFIED YET", "NOT VERIFIED YET", "NOT VERIFIED YET"]);
    expect(v.leads[0]).toMatchObject({ name: "Jane Miller", email_source: "seamless", company: a.company_name });
  });

  it("shows PASSED, the failed gate and reason, and draft subjects", () => {
    const state: McpRunState = {
      ...base,
      status: "DRAFTED",
      verification: {
        passed: [a],
        quarantined: [{ lead: b, result: { lead_id: "B", passed: false, failed_gate: 3, failure_reason: "DOMAIN_MISMATCH", checked_at: "t" } }],
      },
      drafts: [{ ...a, research_summary: [], email_subject: "Quick question", email_body: "Hi Jane", draft_status: "READY", draft_issues: [] }],
    };
    const v = viewRun(state);
    expect(v.counts).toEqual({ sourced: 3, with_email: 3, skipped: 0, passed: 1, failed: 1, drafted: 1 });
    expect(v.leads.map((l) => l.result)).toEqual(["PASSED", "FAILED gate 3: DOMAIN_MISMATCH", "NOT VERIFIED YET"]);
    expect(v.leads[0]).toMatchObject({ draft_status: "READY", email_subject: "Quick question" });
    expect(v.leads[0]!.email_body).toBeUndefined();
    expect(viewRun(state, { includeBodies: true }).leads[0]!.email_body).toBe("Hi Jane");
  });

  it("shows SOURCING with elapsed time, and FAILED with the error", () => {
    const sourcing = viewRun(
      { ...base, status: "SOURCING", source: { provider: "pending", leads: [], skipped: [] } },
      { now: new Date("2026-11-01T00:00:45Z") },
    );
    expect(sourcing.message).toBe("Still sourcing, 45s so far. Check again in 20-30 seconds.");
    expect(sourcing.leads).toEqual([]);
    const failed = viewRun({ ...base, status: "FAILED", error: "Gemini quota" });
    expect(failed.error).toBe("Gemini quota");
    expect(failed.message).toBeUndefined();
  });
});
