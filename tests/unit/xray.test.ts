import { describe, it, expect, vi } from "vitest";
import { CampaignConfig } from "../../src/config/schema.js";
import { buildQueries, sourceFromSearch } from "../../src/core/sources/xray.js";
import { noEmailFinder, type EmailFinder } from "../../src/core/sources/email-finder.js";
import { sourceLeads } from "../../src/core/sourcing.js";
import { FixtureSearchProvider } from "../../src/lib/search/fixture.js";
import { GeminiSearchProvider, buildXrayQuery } from "../../src/lib/search/gemini.js";
import { getSearch } from "../../src/lib/search/index.js";
import { fakeLLM } from "../helpers.js";

const cfg = CampaignConfig.parse({
  campaign_name: "x", mode: "CORPORATE", sourcing_provider: "gemini_xray",
  target_geography: ["Ohio"], decision_maker_titles: ["VP of Human Resources", "CFO", "Director of Benefits"],
  industry_keywords: ["Healthcare"],
});
const fixture = new FixtureSearchProvider("tests/fixtures/search_people.json");

describe("gemini_xray sourcing (fixture search)", () => {
  it("builds one query per title x location", () => {
    const two = CampaignConfig.parse({ ...cfg, target_geography: ["Ohio", "Indiana"] });
    expect(buildQueries(two)).toHaveLength(6);
  });

  it("keeps real profiles, drops company pages and duplicate profiles", async () => {
    const r = await sourceFromSearch(cfg, 50, fixture, noEmailFinder);
    expect(r.leads).toHaveLength(5);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["DUPLICATE_PROFILE", "INVALID_LINKEDIN_URL"]);
  });

  it("normalizes LinkedIn URLs and splits names", async () => {
    const r = await sourceFromSearch(cfg, 50, fixture, noEmailFinder);
    const priya = r.leads.find((l) => l.first_name === "Priya")!;
    expect(priya.linkedin_url).toBe("https://www.linkedin.com/in/priya-nair-sample");
    const helen = r.leads.find((l) => l.last_name === "Brooks")!;
    expect(helen.first_name).toBe("Helen");
  });

  it("stops at the limit", async () => {
    expect((await sourceFromSearch(cfg, 2, fixture, noEmailFinder)).leads).toHaveLength(2);
  });

  it("asks the email finder for every lead", async () => {
    const finder: EmailFinder = { name: "t", find: vi.fn(async () => "found@acme.com") };
    const r = await sourceFromSearch(cfg, 50, fixture, finder);
    expect(finder.find).toHaveBeenCalledTimes(r.leads.length);
    expect(r.leads.every((l) => l.email === "found@acme.com")).toBe(true);
  });

  it("leaves email empty when search had none (Gate 1 will catch it)", async () => {
    const r = await sourceFromSearch(cfg, 50, fixture, noEmailFinder);
    expect(r.leads.find((l) => l.first_name === "Chris")!.email).toBeUndefined();
  });
});

describe("GeminiSearchProvider", () => {
  it("builds an X-Ray query", () => {
    expect(buildXrayQuery({ title: "CFO", location: "Ohio", keywords: ["Healthcare", "TPA"] }))
      .toBe('site:linkedin.com/in/ "CFO" "Ohio" ("Healthcare" OR "TPA")');
  });

  it("refuses an LLM without web search (Ollama)", () => {
    expect(() => new GeminiSearchProvider(fakeLLM({}, false).llm)).toThrow(/web search/);
  });

  it("sends the X-Ray query with grounding and returns people", async () => {
    const { llm, prompts } = fakeLLM({ people: [{ full_name: "A B", title: "CFO", company_name: "Acme", location: "Dayton, OH", linkedin_url: "https://www.linkedin.com/in/ab" }] }, true);
    const p = new GeminiSearchProvider(llm);
    const out = await p.findPeople({ title: "CFO", location: "Ohio", keywords: [] }, 5);
    expect(out).toHaveLength(1);
    expect(prompts[0]).toContain('site:linkedin.com/in/ "CFO" "Ohio"');
  });
});

describe("getSearch", () => {
  it("defaults to the offline fixture", () => expect(getSearch({}).name).toBe("fixture"));
  it("needs a Gemini key for live search", () => expect(() => getSearch({ SEARCH_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/));
  it("builds live Gemini search when a key is set", () => expect(getSearch({ SEARCH_PROVIDER: "gemini", GEMINI_API_KEY: "k" }).name).toBe("gemini"));
});

describe("sourceLeads routing", () => {
  it("--csv wins over the campaign's provider", async () => {
    const r = await sourceLeads(cfg, { limit: 50, csvPath: "tests/fixtures/dirty_leads.csv" });
    expect(r.provider).toBe("csv_import");
  });

  it("gemini_xray campaign uses the search provider", async () => {
    const r = await sourceLeads(cfg, { limit: 50 }, { search: fixture, emailFinder: noEmailFinder });
    expect(r.provider).toBe("gemini_xray/fixture");
  });

  it("csv_import campaign without a path explains what to do", async () => {
    const c = CampaignConfig.parse({ ...cfg, sourcing_provider: "csv_import" });
    await expect(sourceLeads(c, { limit: 5 })).rejects.toThrow(/--csv/);
  });

  it("apify is not built yet", async () => {
    const c = CampaignConfig.parse({ ...cfg, sourcing_provider: "apify_or_apollo" });
    await expect(sourceLeads(c, { limit: 5 })).rejects.toThrow(/Phase 8/);
  });
});

describe("fixture search location matching", async () => {
  const { locationMatches } = await import("../../src/lib/search/fixture.js");
  it.each([
    ["Dayton, OH", "Ohio", true],
    ["Dayton, OH", "Indiana", false],
    ["Columbus, OH", "OH", true],
    ["Austin, TX", "Texas", true],
    ["Remote", "Remote", true],
    ["Cincinnati, OH", "Cincinnati", true],
  ])("%s in %s -> %s", (hit, q, expected) => {
    expect(locationMatches(hit, q)).toBe(expected);
  });

  it("returns nobody for a state with no sample people", async () => {
    expect(await fixture.findPeople({ title: "CFO", location: "Indiana", keywords: [] }, 10)).toHaveLength(0);
  });
});
