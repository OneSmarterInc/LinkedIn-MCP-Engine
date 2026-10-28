import { describe, it, expect } from "vitest";
import { loadCampaign } from "../../src/config/load.js";

describe("campaign configs", () => {
  for (const f of ["b2b_healthcare", "hiring_orgs", "talent_sourcing"]) {
    it(`${f}.json is valid`, async () => {
      const c = await loadCampaign(`campaigns/${f}.json`);
      expect(c.campaign_name.length).toBeGreaterThan(0);
    });
  }

  it("talent_sourcing is CANDIDATE mode and blocks current employer", async () => {
    const c = await loadCampaign("campaigns/talent_sourcing.json");
    expect(c.mode).toBe("CANDIDATE");
    expect(c.block_current_employer_domain).toBe(true);
  });

  it("defaults auto_send_booking_replies to false", async () => {
    const c = await loadCampaign("campaigns/b2b_healthcare.json");
    expect(c.auto_send_booking_replies).toBe(false);
  });
});