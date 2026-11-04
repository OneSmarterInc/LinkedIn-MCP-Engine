import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the parts startSearch touches before it hands work to the background.
let finishRun: (() => void) | undefined;
vi.mock("../../src/lib/llm/gemini.js", () => ({ GeminiProvider: class { supportsGrounding = true; } }));
vi.mock("../../src/config/load.js", () => ({ loadCampaign: async () => ({ campaign_name: "Jobs" }) }));
vi.mock("../../src/core/jobs/job-search.js", async (orig) => ({
  ...(await orig<typeof import("../../src/core/jobs/job-search.js")>()),
  startJobSearch: async (run: (p: () => void, id: string) => Promise<unknown>) => {
    const done = run(() => {}, `jobs-${Math.random()}`).catch(() => {});
    return { record: { search_id: "jobs-test" }, done };
  },
  searchJobs: () => new Promise((resolve) => { finishRun = () => resolve({ jobs: [], total: 0 }); }),
}));
vi.mock("../../src/core/jobs/job-outreach.js", async (orig) => ({
  ...(await orig<typeof import("../../src/core/jobs/job-outreach.js")>()),
  attachOutreach: async (out: unknown) => out,
}));

const { startSearch } = await import("../../src/api/services/engine.js");
const env = { GEMINI_API_KEY: "k", GOOGLE_SHEET_ID: "s" } as NodeJS.ProcessEnv;
const deps = { gw: () => ({}) as never, ledger: {} as never, env };

/** Ends the running search once it has reached the search step (it first reads earlier searches from disk). */
async function endRun() {
  for (let i = 0; i < 200 && !finishRun; i++) await new Promise((r) => setTimeout(r, 5));
  const f = finishRun; finishRun = undefined; f?.();
  await new Promise((r) => setTimeout(r, 10));
}

describe("startSearch: one job search at a time", () => {
  beforeEach(() => { finishRun = undefined; });

  it("refuses a second search with 409 while the first runs, and allows one after it ends", async () => {
    await expect(startSearch(deps)).resolves.toMatchObject({ search_id: "jobs-test" });
    await expect(startSearch(deps)).rejects.toMatchObject({ statusCode: 409 });
    await endRun();
    await expect(startSearch(deps)).resolves.toMatchObject({ search_id: "jobs-test" });
    await endRun();
  });

  it("two clicks at the same moment start only one search", async () => {
    const results = await Promise.allSettled([startSearch(deps), startSearch(deps)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await endRun();
  });

  it("a setup error does not leave the lock on", async () => {
    await expect(startSearch({ ...deps, env: { GOOGLE_SHEET_ID: "s" } as NodeJS.ProcessEnv })).rejects.toMatchObject({ statusCode: 400 });
    await expect(startSearch(deps)).resolves.toMatchObject({ search_id: "jobs-test" });
    await endRun();
  });
});
