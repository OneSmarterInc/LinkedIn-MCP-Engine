// One live job search, outside Claude Desktop, so you can see the result and any error.
// Usage:
//   npx tsx scripts/check-jobs.ts                 Gemini only (no Seamless credits)
//   npx tsx scripts/check-jobs.ts --seamless 1    plus at most 1 Seamless lookup (1-2 credits)
//   npx tsx scripts/check-jobs.ts --raw           print what Gemini's search answers, as plain text (no JSON)
import "dotenv/config";
import { buildJobPrompts, JOB_SEARCH_DEFAULTS, jobWindow, saveJobSearch, searchJobs } from "../src/core/jobs/job-search.js";
import { GeminiProvider } from "../src/lib/llm/gemini.js";
import { geminiOptions } from "../src/lib/llm/index.js";

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
  onProgress: (p) => console.log(`[${((Date.now() - t) / 1000).toFixed(0)}s] ${p.message}`),
  settings: { maxSeamlessLookups: lookups },
  ...(lookups > 0 && seamlessKey ? { seamless: { apiKey: seamlessKey } } : {}),
});
const path = await saveJobSearch(out);
console.log(`Window ${out.window.from} to ${out.window.to}: ${out.total} jobs, ${out.with_email} with email, ` +
  `${out.seamless_lookups_used} Seamless lookups, ${out.skipped.length} skipped, ${((Date.now() - t) / 1000).toFixed(1)}s`);
for (const j of out.jobs) {
  console.log(`- ${j.posted_date_unconfirmed ?? "no date"} (unconfirmed) | ${j.job_title} | ${j.company} | ${j.location} | email: ${j.email ? "yes" : "no"} (${j.email_source})`);
}
console.log(`Saved to ${path}`);
