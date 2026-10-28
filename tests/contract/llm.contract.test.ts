/**
 * Contract tests run the REAL provider set in .env (Ollama or Gemini).
 * Run with: npm run test:contract   (Ollama must be running, or GEMINI_API_KEY set)
 * Run these on Ollama during development and once on Gemini before go-live.
 */
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { getLLM } from "../../src/lib/llm/index.js";
import { EntityVerdict, makeEntityCheck } from "../../src/core/gates/entity.js";
import { corporateCfg, makeLead } from "../helpers.js";

const llm = getLLM();

describe(`LLM contract: ${llm.name}`, () => {
  it("returns JSON that matches the Gate 4 schema", async () => {
    const v = await llm.generateJSON(
      "Company: Kroger. Email domain: kroger.com. Location: Cincinnati, OH. Same organization and location?",
      EntityVerdict,
    );
    expect(EntityVerdict.safeParse(v).success).toBe(true);
  });

  it("passes an obvious match", async () => {
    const check = makeEntityCheck(llm, corporateCfg, { minConfidence: 0.5 });
    const r = await check(makeLead({
      first_name: "Pat", last_name: "Lee", title: "CFO", company_name: "The Kroger Co.",
      company_domain: "kroger.com", location: "Cincinnati, OH", email: "pat.lee@kroger.com",
    }));
    expect(r).toBeNull();
  });

  it("rejects an obvious out-of-state institution", async () => {
    const check = makeEntityCheck(llm, corporateCfg);
    const r = await check(makeLead({
      first_name: "Pat", last_name: "Lee", title: "CFO", company_name: "Dayton Precision Tool",
      company_domain: "daytonprecision.com", location: "Dayton, OH", email: "pat.lee@ou.edu",
    }));
    expect(r).toBe("ENTITY_MISMATCH");
  });
});
