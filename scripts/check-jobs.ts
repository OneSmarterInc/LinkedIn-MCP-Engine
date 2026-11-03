// One live job search, outside Claude Desktop, so you can see the result and any error.
// Usage:
//   npx tsx scripts/check-jobs.ts                 Gemini only (no Seamless credits)
//   npx tsx scripts/check-jobs.ts --seamless 1    plus at most 1 Seamless lookup (1-2 credits)
//   npx tsx scripts/check-jobs.ts --raw           print what Gemini's search answers, as plain text (no JSON)
import "dotenv/config";
import { execSync } from "node:child_process";
import { buildJobPrompts, JOB_SEARCH_DEFAULTS, jobWindow, saveJobSearch, searchJobs } from "../src/core/jobs/job-search.js";
import { GeminiProvider } from "../src/lib/llm/gemini.js";
import { geminiOptions } from "../src/lib/llm/index.js";
import { logger } from "../src/lib/logger.js";

// This script prints its own plain-text progress, so the engine's JSON log lines are turned down to warnings.
// Pass LOG_LEVEL=info to see them again (for debugging).
logger.level = process.env.LOG_LEVEL ?? "warn";

// Windows PowerShell shows UTF-8 text like the en dash as "ΓÇô" unless the console is in UTF-8 mode.
// Switching the code page here fixes the display for this session; the saved JSON was always correct.
if (process.platform === "win32") {
  try { execSync("chcp 65001 >nul", { stdio: "ignore", shell: "cmd.exe" }); } catch { /* display only; never fatal */ }
}

/** Our own lines stay readable on any console: curly quotes and dashes become plain ASCII. */
const ascii = (t: string) => t.replace(/[\u2013\u2014]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');

const i = process.argv.indexOf("--seamless");
const lookups = i > -1 ? Number(process.argv[i + 1] ?? 1) : 0;

const key = process.env.GEMINI_API_KEY?.trim();
if (!key) { console.error("GEMINI_API_KEY is empty in .env"); process.exit(1); }
const llm = new GeminiProvider(geminiOptions(process.env, key));
if (!llm.supportsGrounding) { console.error("Set GEMINI_GROUNDING=true (needs billing)."); process.exit(1); }
const seamlessKey = process.env.SEAMLESS_API_KEY?.trim();
if (lookups > 0 && !seamlessKey) { console.error("SEAMLESS_API_KEY is empty in .env"); process.exit(1); }

if (process.argv.includes("--raw")) {
  const prompts = buildJobPrompts(jobWindow(new Date(), JOB_SEARCH_DEFAULTS.daysBack), 5);
  for (const [n, p] of prompts.entries()) {
    console.log(`\n===== Search ${n + 1} =====`);
    try {
      console.log(await llm.generateText(p, { grounded: true }));
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
    }
  }
  process.exit(0);
}

const t = Date.now();
const out = await searchJobs({
  llm,
  onProgress: (p: { message: string }) => console.log(ascii(`[${((Date.now() - t) / 1000).toFixed(0)}s] ${p.message}`)),
  settings: { maxSeamlessLookups: lookups },
  ...(lookups > 0 && seamlessKey ? { seamless: { apiKey: seamlessKey } } : {}),
});
const path = await saveJobSearch(out);
console.log(`Window ${out.window.from} to ${out.window.to}: ${out.total} jobs, ${out.with_email} with email, ` +
  `${out.seamless_lookups_used} Seamless lookups, ${out.skipped.length} skipped, ${((Date.now() - t) / 1000).toFixed(1)}s`);
for (const j of out.jobs) {
  console.log(ascii(`- ${j.posted_date_unconfirmed ?? "no date"} (unconfirmed) | ${j.job_title} | ${j.company} | ${j.location} | email: ${j.email ? "yes" : "no"} (${j.email_source})`));
}
console.log(`Saved to ${path}`);
