import { describe, it, expect } from "vitest";
import { staffingCheck } from "../../src/core/jobs/staffing.js";
import { searchJobs, type JobHit } from "../../src/core/jobs/job-search.js";
import type { LLMProvider } from "../../src/lib/llm/provider.js";

// All companies here are made up, except the large public firms on the built-in list.

const check = staffingCheck({ SKIP_COMPANIES: "Rapid Eagle, Kasmo" });

describe("staffing and consulting firms are skipped", () => {
  it.each([
    ["Infosys", undefined, undefined],
    ["Capgemini", "capgemini.com", undefined],
    ["Acme Staffing Group", undefined, undefined],
    ["Blue River Consulting", undefined, undefined],
    ["Northwind", "northwindconsulting.com", undefined],
    ["Rapid Eagle Inc", undefined, undefined],
    ["Kasmo global", undefined, undefined],
    ["Bright Path", undefined, "We are hiring for our client, a Fortune 500 bank. C2C is fine."],
  ])("%s", (name, domain, text) => {
    expect(check.reason({ name, ...(domain ? { domain } : {}), ...(text ? { text } : {}) })).toBeDefined();
  });

  it.each([
    ["General Motors", "gm.com", "Build vehicle software for our own plants."],
    ["Medoja Bio Private Limited", undefined, undefined],
    ["Heyday Foods", undefined, undefined],
    ["Kettering Health", "ketteringhealth.org", "Join our nursing team."],
  ])("keeps a real employer: %s", (name, domain, text) => {
    expect(check.reason({ name, ...(domain ? { domain } : {}), ...(text ? { text } : {}) })).toBeUndefined();
  });

  it("spots staffing-only contact titles", () => {
    expect(check.contact("Senior Bench Sales Recruiter")).toBe(true);
    expect(check.contact("US IT Recruiter")).toBe(true);
    expect(check.contact("Talent Acquisition Manager")).toBe(false);
  });

  it("job search skips them before Seamless and keeps looking", async () => {
    const hit = (o: Partial<JobHit>): JobHit => ({
      job_title: "SAP Analyst", company_name: "Acme", company_domain: "acme.com", location: "Dayton, OH",
      posted_date: "2026-11-02", description: "Run SAP for our plants.", url: "https://www.linkedin.com/jobs/view/1", ...o,
    });
    let calls = 0;
    const llm = {
      name: "fake", supportsGrounding: true,
      async generateJSON(_p: string, schema: { parse(x: unknown): unknown }) {
        calls += 1;
        return schema.parse(calls === 1 ? { jobs: [
          hit({ company_name: "Capgemini", url: "https://www.linkedin.com/jobs/view/2" }),
          hit({ company_name: "Ohio Steel", company_domain: "ohiosteel.com", url: "https://www.linkedin.com/jobs/view/3", about: "Hiring for our client. C2C." }),
          hit({}),
        ] } : { jobs: [] });
      },
      async generateText() { return ""; },
    } as unknown as LLMProvider;
    const steps: string[] = [];
    const out = await searchJobs({ llm, now: new Date("2026-11-03T10:00:00Z"), settings: { maxSearches: 2 }, onProgress: (p) => steps.push(p.message) });
    expect(out.jobs.map((j) => j.company)).toEqual(["Acme"]);
    expect(out.skipped.filter((s) => s.reason === "STAFFING_OR_CONSULTING_FIRM")).toHaveLength(2);
    expect(steps.some((m) => /Skipped Capgemini/.test(m))).toBe(true);
    expect(steps.some((m) => /2 staffing or consulting firms/.test(m))).toBe(true);
  });
});
