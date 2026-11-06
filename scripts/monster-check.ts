/**
 * Live check of the Monster reader, no Seamless or Sheet involved.
 *   npm run monster:check -- "software engineer" "Ohio"
 *   MONSTER_HEADLESS=false npm run monster:check -- "registered nurse" "Columbus, OH"   (shows the browser)
 * Prints what Monster returned, or the plain reason it did not.
 */
import "dotenv/config";
process.env.LOG_LEVEL ??= "warn"; // keep the check output readable (set before the logger loads)
const { searchMonster } = await import("../src/core/jobs/monster.js");

const [term = "software engineer", location = process.env.JOBSPY_LOCATION?.trim() || "United States"] = process.argv.slice(2);
const hoursOld = Number(process.env.JOBSPY_HOURS_OLD) || 72;
const started = Date.now();
console.log(`Monster: "${term}" near "${location}", last ${hoursOld} h, up to ${Number(process.env.MONSTER_PAGES) || 3} pages…`);
const headless = process.env.MONSTER_HEADLESS?.trim() !== "false";
if (!headless) console.log("A browser window will open. If Monster shows a slider or a check, pass it by hand; the reader waits up to two minutes and remembers the pass in out/monster-profile.");
const r = await searchMonster(term, 25, {
  location, hoursOld, timeoutMs: 120_000,
  maxPages: Number(process.env.MONSTER_PAGES) || 3,
  headless,
  ...(process.env.MONSTER_PROFILE_DIR?.trim() ? { profileDir: process.env.MONSTER_PROFILE_DIR.trim() } : {}),
  ...(process.env.MONSTER_BROWSER?.trim() === "chromium" ? { channel: "chromium" as const } : {}),
}).catch((err: Error) => { console.log(`Setup problem: ${err.message}`); process.exit(2); });
console.log(`${r.rows.length} post(s) in ${Math.round((Date.now() - started) / 1000)} s${r.error ? `  |  problem: ${r.error}` : ""}`);
for (const j of r.rows) console.log(`- ${j.date_posted || "????-??-??"}  ${j.title}  @ ${j.company}  (${j.location || "?"})\n    ${j.job_url}`);
if (!r.rows.length && !r.error) console.log("No posts within the time window. Try a broader term or a bigger JOBSPY_HOURS_OLD.");
process.exit(r.error && !r.rows.length ? 1 : 0);
