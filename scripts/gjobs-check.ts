/**
 * Live check of the Google Jobs (SerpApi) reader; costs one SerpApi search per page, no Seamless or Sheet.
 *   npm run gjobs:check -- "software engineer" "Ohio, United States"
 */
import "dotenv/config";
process.env.LOG_LEVEL ??= "warn"; // keep the check output readable (set before the logger loads)
const { searchGoogleJobs } = await import("../src/core/jobs/google-jobs.js");

const [term = "software engineer", location = process.env.JOBSPY_LOCATION?.trim() || "United States"] = process.argv.slice(2);
const hoursOld = Number(process.env.JOBSPY_HOURS_OLD) || 72;
const started = Date.now();
const prefer = process.env.GOOGLE_JOBS_PREFER_LINK?.trim();
const r = await searchGoogleJobs(term, 30, { apiKey: process.env.SERPAPI_KEY?.trim() ?? "", location, hoursOld, timeoutMs: 30_000, maxPages: Number(process.env.GOOGLE_JOBS_PAGES) || 1, ...(prefer ? { preferLink: prefer } : {}) })
  .catch((err: Error) => { console.log(`Setup problem: ${err.message}`); process.exit(2); });
console.log(`Google Jobs via SerpApi: "${term}" near "${location}", last ${hoursOld} h: ${r.rows.length} post(s) in ${Math.round((Date.now() - started) / 1000)} s, ${r.searches} search(es) used${r.error ? `  |  problem: ${r.error}` : ""}`);
const bySource = new Map<string, number>();
const onBoard = new Map<string, number>();
for (const j of r.rows) {
  const src = j.site?.split(":")[1] ?? "?";
  bySource.set(src, (bySource.get(src) ?? 0) + 1);
  for (const b of j.boards ?? []) onBoard.set(b, (onBoard.get(b) ?? 0) + 1);
  const others = (j.boards ?? []).filter((b) => b !== src);
  console.log(`- ${j.date_posted || "????-??-??"}  ${j.title}  @ ${j.company}  (${j.location || "?"})  via ${src}${others.length ? `  (also on: ${others.join(", ")})` : ""}\n    ${j.job_url}`);
}
if (bySource.size) console.log("Primary source:", [...bySource.entries()].map(([k, v]) => `${k} ${v}`).join(" · "));
if (onBoard.size) console.log("Listed on (any position):", [...onBoard.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
const monster = r.rows.filter((j) => (j.boards ?? []).some((b) => /monster/i.test(b))).length;
console.log(`Monster: ${monster} of ${r.rows.length} post(s) are on Monster${prefer ? ` (links prefer "${prefer}")` : "  (set GOOGLE_JOBS_PREFER_LINK=monster to use the Monster link for those)"}`);
process.exit(r.error && !r.rows.length ? 1 : 0);
