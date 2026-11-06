/**
 * Forgets the "no email" companies that searches on one day recorded, so the next search looks them up again.
 * Use after a bad day (for example Seamless "duplicate" answers that were read as "no email").
 *   npx tsx scripts/clear-no-email.ts 2026-11-06
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const day = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) { console.error("Give a date: npx tsx scripts/clear-no-email.ts YYYY-MM-DD"); process.exit(1); }
const dir = resolve(process.cwd(), "out", "job-searches");
let changed = 0;
for (const f of (await readdir(dir)).filter((x) => x.startsWith("jobs-") && x.endsWith(".json"))) {
  const path = resolve(dir, f);
  const r = JSON.parse(await readFile(path, "utf8"));
  if (!String(r.started_at ?? r.searched_at ?? "").startsWith(day)) continue;
  const out = r.result ?? (r.jobs ? r : undefined);
  const n = out?.no_email?.length ?? 0;
  const old = (out?.jobs ?? []).filter((j: { email_source?: string }) => j.email_source === "not_found").length
    + (r.jobs_so_far ?? []).filter((j: { email_source?: string }) => j.email_source === "not_found").length;
  if (!n && !old) continue;
  if (out) out.no_email = [];
  for (const j of [...(out?.jobs ?? []), ...(r.jobs_so_far ?? [])]) if (j.email_source === "not_found") j.email_source = "lookup_error";
  await writeFile(path, JSON.stringify(r, null, 2));
  console.log(`${f}: cleared ${n + old} no-email entries`);
  changed += 1;
}
console.log(changed ? `Done: ${changed} search file(s) changed.` : `No search on ${day} had no-email entries.`);
