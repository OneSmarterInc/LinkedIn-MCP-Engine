// One live Seamless.AI lookup, so you can see the real response before running a batch.
// Usage: npx tsx scripts/check-seamless.ts "Jane Miller" caresource.com [https://www.linkedin.com/in/jane-miller]
// Costs 1 Seamless credit.
import "dotenv/config";
import { seamlessMatch } from "../src/core/sources/seamless-finder.js";
import type { LeadRecord } from "../src/config/schema.js";

const [fullName, domain, linkedin] = process.argv.slice(2);
if (!fullName || !domain) {
  console.error('Usage: npx tsx scripts/check-seamless.ts "First Last" company-domain.com [linkedin-url]');
  process.exit(1);
}
const key = process.env.SEAMLESS_API_KEY?.trim();
if (!key) { console.error("SEAMLESS_API_KEY is empty in .env"); process.exit(1); }

const [first, ...rest] = fullName.trim().split(/\s+/);
const lead: LeadRecord = {
  lead_id: "check", first_name: first!, last_name: rest.join(" ") || "", title: "", company_name: domain,
  company_domain: domain, location: "", source: "gemini_xray", ...(linkedin ? { linkedin_url: linkedin } : {}),
};

// Log every raw reply so the JSON shape is visible once. Delete this wrapper when you no longer need it.
const loggingFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.clone().text();
  console.log(`\n${init?.method ?? "GET"} ${String(url).replace(/requestIds=.*/, "requestIds=...")} -> ${res.status}\n${text.slice(0, 1500)}`);
  return res;
};

const t = Date.now();
const email = await seamlessMatch(lead, key, loggingFetch, { pollMs: 3000, maxWaitMs: 60_000 });
console.log(`\nResult after ${((Date.now() - t) / 1000).toFixed(1)}s: ${email ?? "no email found"}`);
