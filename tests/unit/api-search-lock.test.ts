import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the parts startSearch touches before it hands work to the background.
let finishRun: (() => void) | undefined;
vi.mock("../../src/lib/llm/gemini.js", () => ({ GeminiProvider: class { supportsGrounding = true; } }));
vi.mock("../../src/config/load.js", () => ({ loadCampaign: async (name: string) => { if (name === "nope") throw new Error("No campaign named nope"); return { campaign_name: "Jobs", sourcing_provider: "csv_import" }; } }));
vi.mock("../../src/core/jobs/job-search.js", async (orig) => ({
  ...(await orig<typeof import("../../src/core/jobs/job-search.js")>()),
  startJobSearch: async (run: (p: () => void, id: string) => Promise<unknown>) => {
    const done = run(() => {}, `jobs-${Math.random()}`).catch(() => {});
    return { record: { search_id: "jobs-test" }, done };
  },
  searchJobs: () => new Promise((resolve) => { finishRun = () => resolve({ jobs: [], total: 0 }); }),
}));
// Campaign runs: keep the run record in memory and let the test decide when sourcing ends.
let finishSource: (() => void) | undefined;
const runStore = new Map<string, Record<string, unknown>>();
vi.mock("../../src/mcp/run-store.js", async (orig) => ({
  ...(await orig<typeof import("../../src/mcp/run-store.js")>()),
  saveRunState: async (st: { run_id: string }) => { runStore.set(st.run_id, st); },
  loadRunState: async (id: string) => runStore.get(id),
}));
vi.mock("../../src/core/sourcing.js", () => ({
  sourceLeads: () => new Promise((resolve) => { finishSource = () => resolve({ provider: "csv", leads: [], skipped: [] }); }),
}));
// Opt-out sync: the test decides what the Sheet says, and records what reached the ledger.
let sheetOptOuts: string[] | Error = [];
const suppressed: string[] = [];
vi.mock("../../src/core/optout-sync.js", () => ({
  syncOptOuts: async (_gw: unknown, ledger: { suppress: (e: string, r: string) => void }) => {
    if (sheetOptOuts instanceof Error) throw sheetOptOuts;
    for (const e of sheetOptOuts) { ledger.suppress(e, "OPTED_OUT"); suppressed.push(e); }
    return { rowsScanned: sheetOptOuts.length, added: sheetOptOuts.length, alreadyKnown: 0, addedEmails: sheetOptOuts };
  },
}));
vi.mock("../../src/lib/llm/index.js", () => ({ getLLM: () => ({ name: "fake" }), geminiOptions: () => ({}) }));
vi.mock("../../src/core/gates/index.js", () => ({ buildAsyncGates: () => ({}) }));
vi.mock("../../src/core/verifier.js", () => ({ verifyBatch: async () => ({ passed: [], quarantined: [] }) }));
vi.mock("../../src/core/enricher.js", () => ({ draftAll: async () => [] }));
vi.mock("../../src/core/exporter.js", async (orig) => ({ ...(await orig<typeof import("../../src/core/exporter.js")>()), exportToSheet: async () => ({ exported: 0 }), recordExported: () => {} }));
vi.mock("../../src/core/jobs/job-outreach.js", async (orig) => ({
  ...(await orig<typeof import("../../src/core/jobs/job-outreach.js")>()),
  attachOutreach: async (out: unknown) => out,
}));

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { startSearch, startRun } = await import("../../src/api/services/engine.js");
const { acquireLock, LockHeldError } = await import("../../src/core/locks.js");
const LOCK_DIR = await mkdtemp(join(tmpdir(), "locks-"));
const env = { GEMINI_API_KEY: "k", GOOGLE_SHEET_ID: "s", LOCK_DIR } as NodeJS.ProcessEnv;
const deps = { gw: () => ({}) as never, ledger: { suppress: () => {}, isSuppressed: () => false } as never, env };

/** Ends the running search once it has reached the search step (it first reads earlier searches from disk). */
async function endRun() {
  for (let i = 0; i < 200 && !finishRun; i++) await new Promise((r) => setTimeout(r, 5));
  const f = finishRun; finishRun = undefined; f?.();
  await new Promise((r) => setTimeout(r, 200));
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

describe("file lock (shared by the API, the MCP server and the CLI)", () => {
  it("one winner; the loser gets a 409 with who holds it; release frees it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const release = await acquireLock("campaign-run", { dir, label: "api" });
    const held = await acquireLock("campaign-run", { dir, label: "claude-desktop" }).catch((e) => e);
    expect(held).toBeInstanceOf(LockHeldError);
    expect((held as Error & { statusCode: number }).statusCode).toBe(409);
    expect((held as Error).message).toMatch(/campaign run is already running .*by api/);
    await release();
    await release(); // twice is harmless
    const again = await acquireLock("campaign-run", { dir });
    await again();
  });

  it("takes over a lock left behind by a crashed process (dead pid or older than 30 minutes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const { hostname } = await import("node:os");
    await writeFile(join(dir, "job-search.lock"), JSON.stringify({ pid: 999999, host: hostname(), started_at: new Date().toISOString() }));
    const release = await acquireLock("job-search", { dir });            // dead pid
    expect(JSON.parse(await readFile(join(dir, "job-search.lock"), "utf8")).pid).toBe(process.pid);
    await release();
    await writeFile(join(dir, "job-search.lock"), JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date(Date.now() - 31 * 60_000).toISOString() }));
    const release2 = await acquireLock("job-search", { dir });           // alive pid, but stale
    await release2();
    await writeFile(join(dir, "job-search.lock"), JSON.stringify({ pid: process.pid, host: hostname(), started_at: new Date().toISOString() }));
    await expect(acquireLock("job-search", { dir })).rejects.toBeInstanceOf(LockHeldError); // alive and fresh: held
  });

  it("a search lock and a run lock do not block each other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const a = await acquireLock("job-search", { dir });
    const b = await acquireLock("campaign-run", { dir });
    await a(); await b();
  });
});

describe("startRun: one campaign run at a time", () => {
  async function endSource() {
    for (let i = 0; i < 200 && !finishSource; i++) await new Promise((r) => setTimeout(r, 5));
    const f = finishSource; finishSource = undefined; f?.();
    await new Promise((r) => setTimeout(r, 30));
  }

  it("refuses a second run with 409 while the first runs, then allows one; a search may run alongside", async () => {
    const first = await startRun(deps, "Jobs", 5, false);
    expect(first.run_id).toMatch(/^mcp-/);
    await expect(startRun(deps, "Jobs", 5, false)).rejects.toMatchObject({ statusCode: 409 });
    await expect(startSearch(deps)).resolves.toMatchObject({ search_id: "jobs-test" }); // different lock
    await endRun();
    await endSource();
    expect((runStore.get(first.run_id) as { status: string }).status).toBe("DRAFTED");
    const second = await startRun(deps, "Jobs", 5, false);
    expect(second.run_id).not.toBe(first.run_id);
    await endSource();
  });

  it("releases the lock when the start itself fails", async () => {
    await expect(startRun(deps, "nope", 5, false)).rejects.toThrow();
    const ok = await startRun(deps, "Jobs", 5, false);
    expect(ok.run_id).toMatch(/^mcp-/);
    await endSource();
  });
});

describe("startRun: opt-outs from the Sheet reach the ledger before the gates", () => {
  async function settle() {
    for (let i = 0; i < 200 && !finishSource; i++) await new Promise((r) => setTimeout(r, 5));
    const f = finishSource; finishSource = undefined; f?.();
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 10)); const states = [...runStore.values()] as { status: string }[]; if (states.length && states.every((st) => st.status !== "SOURCING" && st.status !== "SOURCED")) break; }
  }

  it("copies Opted Out / Bounced addresses into the ledger during a console run", async () => {
    sheetOptOuts = ["stop@acme.com", "bounced@acme.com"]; suppressed.length = 0;
    const { run_id } = await startRun(deps, "Jobs", 5, false);
    await settle();
    expect(suppressed).toEqual(["stop@acme.com", "bounced@acme.com"]);
    expect((runStore.get(run_id) as { status: string }).status).toBe("DRAFTED");
  });

  it("stops the run with a clear message when the Sheet cannot be read", async () => {
    sheetOptOuts = new Error("Sheet unreachable");
    const { run_id } = await startRun(deps, "Jobs", 5, false);
    await settle();
    const st = runStore.get(run_id) as { status: string; error: string };
    expect(st.status).toBe("FAILED");
    expect(st.error).toMatch(/Could not read opt-outs from the Google Sheet, so the run was stopped: Sheet unreachable/);
    sheetOptOuts = [];
    // and the run lock is free again
    const next = await startRun(deps, "Jobs", 5, false);
    expect(next.run_id).not.toBe(run_id);
    await settle();
  });
});
