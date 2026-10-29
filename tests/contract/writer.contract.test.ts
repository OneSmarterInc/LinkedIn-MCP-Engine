/**
 * Drafts one real email with the provider set in .env. Run with: npm run test:contract
 * Prints the draft so a person can judge the tone.
 */
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { loadCampaign } from "../../src/config/load.js";
import { draftOne } from "../../src/core/enricher.js";
import { getLLM } from "../../src/lib/llm/index.js";
import { makeLead } from "../helpers.js";

describe(`writer contract: ${getLLM().name}`, () => {
  it("drafts a READY email for a real-looking lead", async () => {
    const cfg = await loadCampaign("campaigns/b2b_healthcare.json");
    const d = await draftOne(makeLead({
      first_name: "Pat", last_name: "Lee", title: "Director of Benefits",
      company_name: "The Kroger Co.", company_domain: "kroger.com", location: "Cincinnati, OH",
      email: "pat.lee@kroger.com",
    }), cfg, getLLM());
    console.log(`\nSubject: ${d.email_subject}\n\n${d.email_body}\n\nStatus: ${d.draft_status} ${d.draft_issues.join("; ")}\n`);
    expect(d.draft_status).toBe("READY");
  });
});
