import { describe, it, expect, beforeEach } from "vitest";
import { CampaignConfig } from "../../src/config/schema.js";
import { openLedger, type Ledger } from "../../src/core/db.js";
import { JOB_TABS, PIPELINE_HEADERS, QUARANTINED_HEADERS, TAB, summaryRows } from "../../src/core/exporter.js";
import { checkDraft, roleKeywords } from "../../src/core/enricher.js";
import { attachOutreach, checkJobsCampaign, jobToLead, runJobOutreach } from "../../src/core/jobs/job-outreach.js";
import type { JobSearchOutput, JobView } from "../../src/core/jobs/job-search.js";
import { syncOptOuts } from "../../src/core/optout-sync.js";
import type { AsyncGates } from "../../src/core/verifier.js";
import { fakeSheets } from "../fake-sheets.js";
import { fakeLLM } from "../helpers.js";

// All companies, people and emails here are made up.

const cfg = CampaignConfig.parse({
  campaign_name: "Jobs", mode: "CORPORATE", sourcing_provider: "gemini_xray",
  target_geography: ["Ohio"], decision_maker_titles: ["Recruiter"],
  offer: "a 15-minute call about developers we can place for the role you posted",
  sender_company: "One Smarter",
});

function job(o: Partial<JobView> = {}): JobView {
  return {
    job_title: "RPG Developer", company: "Acme", company_domain: "acme.com", location: "Dayton, OH",
    posted_date_unconfirmed: "2026-11-01", description: "Maintain IBM i programs.",
    url: "https://www.linkedin.com/jobs/view/111", email: "jane.miller@acme.com", email_source: "seamless_recruiter",
    contact_name: "Jane Miller", contact_title: "Talent Acquisition Lead", ...o,
  };
}

function output(jobs: JobView[]): JobSearchOutput {
  return {
    searched_at: "2026-11-03T10:00:00.000Z", searches: 1, window: { from: "2026-10-27", to: "2026-11-03" },
    total: jobs.length, with_email: jobs.filter((j) => j.email).length, seamless_lookups_used: 1, jobs, skipped: [],
  };
}

const passAll: AsyncGates = { entityCheck: async () => null, mailboxCheck: async () => null };
const goodDraft = {
  research_summary: [],
  email_subject: "Your RPG Developer opening",
  email_body: "I saw Acme is hiring an RPG Developer. We place IBM i developers who work US hours. " +
    "You can start with one developer on a 90-day trial. Could we talk for 15 minutes this week?",
};

let ledger: Ledger;
beforeEach(() => { ledger = openLedger(":memory:"); });

describe("jobToLead", () => {
  it("makes a lead that carries the role, link and date, with a Seamless email", () => {
    const lead = jobToLead(job());
    expect(lead).toMatchObject({
      first_name: "Jane", last_name: "Miller", title: "Talent Acquisition Lead", company_name: "Acme",
      company_domain: "acme.com", email: "jane.miller@acme.com", email_source: "seamless", source: "job_search",
      hiring_for: { role: "RPG Developer", url: "https://www.linkedin.com/jobs/view/111", posted_date: "2026-11-01" },
    });
    expect(lead.lead_id).toBe(jobToLead(job()).lead_id); // stable across runs
  });
  it("a job with no contact becomes a lead with no email (it lands in Jobs_Quarantine)", () => {
    const lead = jobToLead(job({ email: null, email_source: "not_found", contact_name: undefined, contact_title: undefined }));
    expect(lead.email).toBeUndefined();
    expect(lead.first_name).toBe("");
  });
});

describe("checkJobsCampaign", () => {
  it("accepts a CORPORATE campaign with an offer and a real sender", () => expect(() => checkJobsCampaign(cfg)).not.toThrow());
  it("rejects CANDIDATE mode", () => expect(() => checkJobsCampaign({ ...cfg, mode: "CANDIDATE" })).toThrow(/CORPORATE/));
  it("rejects a missing offer", () => expect(() => checkJobsCampaign({ ...cfg, offer: undefined })).toThrow(/offer/));
  it("rejects the placeholder sender", () => expect(() => checkJobsCampaign({ ...cfg, sender_company: "Your Company Name" })).toThrow(/sender/));
});

describe("drafts for job leads", () => {
  it("roleKeywords drops filler words", () => expect(roleKeywords("Senior RPG Developer (IBM i)")).toEqual(["rpg", "developer", "ibm"]));
  it("a draft that does not name the role needs a rewrite", () => {
    const lead = jobToLead(job());
    const d = { ...goodDraft, email_body: "I saw Acme is growing. We place people who work US hours. You can start on a 90-day trial. Could we talk for 15 minutes?" };
    expect(checkDraft(d, lead, cfg).join(" ")).toMatch(/does not name the role/);
    expect(checkDraft(goodDraft, lead, cfg)).toEqual([]);
  });
});

describe("runJobOutreach", () => {
  it("writes drafts to Jobs_Pipeline as Ready for Review and failures to Jobs_Quarantine, never to Pipeline", async () => {
    const { gw, tabs } = fakeSheets();
    const { llm } = fakeLLM(goodDraft);
    const steps: string[] = [];
    const out = output([
      job(),
      job({ url: "https://www.linkedin.com/jobs/view/222", company: "Beta", company_domain: "beta.com", email: null,
        email_source: "not_found", contact_name: undefined, contact_title: undefined }),
    ]);
    const r = await runJobOutreach(out, { cfg, ledger, gates: passAll, llm, gw, runId: "jobs-test", onStep: (_s, m) => steps.push(m) });

    expect(r).toMatchObject({ contacts: 2, passed: 1, quarantined: 1, drafts_ready: 1, pipeline_added: 1, quarantined_added: 1, ledger_recorded: 1 });
    expect(r.quarantined_by_reason).toEqual({ MISSING_EMAIL: 1 });

    const pipe = tabs.get(JOB_TABS.pipeline)!.rows;
    expect(pipe[0]).toEqual([...PIPELINE_HEADERS]);
    const row = pipe[1]!;
    const at = (h: string) => row[PIPELINE_HEADERS.indexOf(h as (typeof PIPELINE_HEADERS)[number])];
    expect(at("Email")).toBe("jane.miller@acme.com");
    expect(at("Status")).toBe("Ready for Review");
    expect(at("Research")).toContain("HIRING: RPG Developer");
    expect(at("Research")).toContain("https://www.linkedin.com/jobs/view/111");
    expect(at("DraftBody")).toMatch(/^Hi Jane,/);

    const quar = tabs.get(JOB_TABS.quarantined)!.rows;
    expect(quar[0]).toEqual([...QUARANTINED_HEADERS]);
    expect(quar[1]![QUARANTINED_HEADERS.indexOf("FailureReason")]).toBe("MISSING_EMAIL");
    expect(quar[1]![QUARANTINED_HEADERS.indexOf("RunID")]).toBe("jobs-test");

    expect(tabs.has(JOB_TABS.summary)).toBe(true);
    expect(tabs.has(TAB.pipeline)).toBe(false); // the lead Pipeline is untouched
    expect(ledger.isContacted("jane.miller@acme.com")).toBe(true);
    expect(steps.some((m) => m.startsWith("Checking 2 contacts"))).toBe(true);
    expect(steps.at(-1)).toMatch(/1 draft in Jobs_Pipeline/);
  });

  it("a second run does not write to the same person again (Gate 2: ALREADY_CONTACTED)", async () => {
    const { gw } = fakeSheets();
    const { llm } = fakeLLM(goodDraft);
    await runJobOutreach(output([job()]), { cfg, ledger, gates: passAll, llm, gw, runId: "r1" });
    const again = await runJobOutreach(output([job({ url: "https://www.linkedin.com/jobs/view/333" })]), { cfg, ledger, gates: passAll, llm, gw, runId: "r2" });
    expect(again.quarantined_by_reason).toEqual({ ALREADY_CONTACTED: 1 });
    expect(again.pipeline_added).toBe(0);
  });

  it("lists jobs held back only because a check crashed, so a later search can find them again", async () => {
    const { gw } = fakeSheets();
    const { llm } = fakeLLM(goodDraft);
    const crash: AsyncGates = { entityCheck: async () => "GATE_ERROR", mailboxCheck: async () => null };
    const r = await runJobOutreach(output([job()]), { cfg, ledger, gates: crash, llm, gw, runId: "r1" });
    expect(r.quarantined_by_reason).toEqual({ GATE_ERROR: 1 });
    expect(r.retry_urls).toEqual(["https://www.linkedin.com/jobs/view/111"]);
  });

  it("someone who opted out in Jobs_Pipeline is blocked at Gate 2", async () => {
    const optedOut = PIPELINE_HEADERS.map(() => "");
    optedOut[PIPELINE_HEADERS.indexOf("Email")] = "jane.miller@acme.com";
    optedOut[PIPELINE_HEADERS.indexOf("Status")] = "Opted Out";
    const { gw } = fakeSheets({ [TAB.pipeline]: [[...PIPELINE_HEADERS]], [JOB_TABS.pipeline]: [[...PIPELINE_HEADERS], optedOut] });
    const { llm } = fakeLLM(goodDraft);
    const r = await runJobOutreach(output([job()]), { cfg, ledger, gates: passAll, llm, gw, runId: "r1" });
    expect(r.opt_outs_synced).toBe(1);
    expect(r.quarantined_by_reason).toEqual({ OPTED_OUT: 1 });
  });

  it("the summary tab counts the Jobs tabs, not Pipeline", () => {
    const rows = summaryRows(JOB_TABS);
    expect(rows[1]![1]).toContain("Jobs_Pipeline!");
    expect(rows.some((r) => String(r[1]).includes("Jobs_Quarantine!"))).toBe(true);
    expect(rows.some((r) => String(r[1]).includes("Pipeline!") && !String(r[1]).includes("Jobs_"))).toBe(false);
  });
});

describe("attachOutreach", () => {
  it("keeps the jobs and records the error when outreach fails", async () => {
    const { gw } = fakeSheets();
    gw.addTabs = async () => { throw new Error("Sheets quota"); };
    const { llm } = fakeLLM(goodDraft);
    const res = await attachOutreach(output([job()]), { cfg, ledger, gates: passAll, llm, gw, runId: "r1" });
    expect(res.outreach).toBeUndefined();
    expect(res.outreach_error).toBe("Sheets quota");
    expect(res.jobs).toHaveLength(1);
  });

  it("a retry clears the old error", async () => {
    const { gw } = fakeSheets();
    const { llm } = fakeLLM(goodDraft);
    const res = await attachOutreach({ ...output([job()]), outreach_error: "old" }, { cfg, ledger, gates: passAll, llm, gw, runId: "r1" });
    expect(res.outreach_error).toBeUndefined();
    expect(res.outreach?.pipeline_added).toBe(1);
  });
});

describe("opt-out sync with Jobs_Pipeline", () => {
  it("reads Jobs_Pipeline only when the tab exists", async () => {
    const row = (email: string, status: string) => {
      const r = PIPELINE_HEADERS.map(() => ""); r[PIPELINE_HEADERS.indexOf("Email")] = email; r[PIPELINE_HEADERS.indexOf("Status")] = status; return r;
    };
    const only = fakeSheets({ [TAB.pipeline]: [[...PIPELINE_HEADERS], row("a@acme.com", "Opted Out")] });
    expect((await syncOptOuts(only.gw, ledger)).added).toBe(1);
    const both = fakeSheets({
      [TAB.pipeline]: [[...PIPELINE_HEADERS]],
      [JOB_TABS.pipeline]: [[...PIPELINE_HEADERS], row("b@beta.com", "Bounced")],
    });
    expect((await syncOptOuts(both.gw, ledger)).addedEmails).toEqual(["b@beta.com"]);
    expect(ledger.isSuppressed("b@beta.com")).toBe(true);
  });
});

