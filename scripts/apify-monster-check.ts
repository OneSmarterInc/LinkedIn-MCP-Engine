/**
 * Live check of the Apify Monster reader; one actor run (a few cents at most), no Seamless or Sheet.
 *   npm run apify:check -- "software engineer" "Ohio"
 */
import "dotenv/config";
process.env.LOG_LEVEL ??= "warn"; // keep the check output readable (set before the logger loads)
const { searchApifyMonster, DEFAULT_MONSTER_ACTOR } = await import("../src/core/jobs/apify-monster.js");

const [term = "software engineer", location = process.env.JOBSPY_LOCATION?.trim() || "United States"] = process.argv.slice(2);
const hoursOld = Number(process.env.JOBSPY_HOURS_OLD) || 72;
const actor = process.env.APIFY_MONSTER_ACTOR?.trim() || DEFAULT_MONSTER_ACTOR;
const started = Date.now();
const r = await searchApifyMonster(term, 10, { token: process.env.APIFY_TOKEN?.trim() ?? "", actor, location, hoursOld, timeoutMs: 180_000 })
  .catch((err: Error) => { console.log(`Setup problem: ${err.message}`); process.exit(2); });
console.log(`Apify ${actor}: "${term}" near "${location || "United States"}", last ${hoursOld} h: ${r.rows.length} post(s) in ${Math.round((Date.now() - started) / 1000)} s${r.error ? `  |  problem: ${r.error}` : ""}`);
for (const j of r.rows) console.log(`- ${j.date_posted || "????-??-??"}  ${j.title}  @ ${j.company}  (${j.location || "?"})  website: ${j.company_url_direct ?? "none"}\n    ${j.job_url}`);
const withSite = r.rows.filter((j) => j.company_url_direct).length;
console.log(`Company website on ${withSite} of ${r.rows.length} post(s) (the Seamless lookup works best with it).`);
process.exit(r.error && !r.rows.length ? 1 : 0);
