/**
 * Checks that the backend can read your saved Seamless contacts (used when research says "duplicate").
 * Prints counts and company names only, no emails.   npx tsx scripts/seamless-saved-check.ts [company]
 */
import "dotenv/config";

import { clearSavedContactsCache, findSavedContact, loadSavedContacts, savedContactsPath } from "../src/core/sources/seamless-finder.js";

const key = process.env.SEAMLESS_API_KEY?.trim();
if (!key) { console.error("SEAMLESS_API_KEY is not set in .env"); process.exit(1); }

clearSavedContactsCache();
try {
  const rows = await loadSavedContacts(key, fetch, 90);
  const withEmail = rows.filter((r) => r.email || r.email1);
  console.log(`OK  path ${savedContactsPath()}: ${rows.length} saved contacts in the last 90 days, ${withEmail.length} with an email`);
  const companies = [...new Set(rows.map((r) => r.companyName ?? r.company).filter(Boolean))].slice(0, 10);
  console.log(`    companies (first 10): ${companies.join(", ")}`);
  const ask = process.argv[2];
  if (ask) {
    const c = await findSavedContact(key, fetch, { companyName: ask, titles: ["recruit", "talent", "hr", "human resources"] });
    console.log(c ? `    ${ask}: found (${c.title ?? "no title"})` : `    ${ask}: not found in saved contacts`);
  }
} catch (err) {
  console.error(`FAIL ${(err as Error).message}`);
  console.error("If this is HTTP 404, set SEAMLESS_SAVED_CONTACTS_PATH in .env to the saved-contacts path from the Seamless API docs.");
  process.exit(1);
}
