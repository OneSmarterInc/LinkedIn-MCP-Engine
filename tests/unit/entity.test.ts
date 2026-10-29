import { describe, it, expect } from "vitest";
import { emailMatchesName, institutionalMismatch, makeEntityCheck } from "../../src/core/gates/entity.js";
import { candidateCfg, corporateCfg, fakeLLM, makeLead } from "../helpers.js";

const match = { same_organization: true, location_consistent: true, confidence: 0.9, reason: "match" };

describe("gate 4: entity check (CORPORATE)", () => {
  it("passes a confident match", async () => {
    const { llm } = fakeLLM(match);
    expect(await makeEntityCheck(llm, corporateCfg)(makeLead())).toBeNull();
  });

  it("rejects a different organization", async () => {
    const { llm } = fakeLLM({ ...match, same_organization: false });
    expect(await makeEntityCheck(llm, corporateCfg)(makeLead())).toBe("ENTITY_MISMATCH");
  });

  it("rejects an out-of-state name collision", async () => {
    const { llm } = fakeLLM({ ...match, location_consistent: false, reason: "Oklahoma health system" });
    expect(await makeEntityCheck(llm, corporateCfg)(makeLead({ email: "jane.miller@ouhealth.com" })))
      .toBe("ENTITY_MISMATCH");
  });

  it("rejects low confidence", async () => {
    const { llm } = fakeLLM({ ...match, confidence: 0.4 });
    expect(await makeEntityCheck(llm, corporateCfg)(makeLead())).toBe("ENTITY_MISMATCH");
  });

  it("respects a custom confidence threshold", async () => {
    const { llm } = fakeLLM({ ...match, confidence: 0.6 });
    expect(await makeEntityCheck(llm, corporateCfg, { minConfidence: 0.5 })(makeLead())).toBeNull();
  });

  it("fails closed when the model errors", async () => {
    const { llm } = fakeLLM(() => { throw new Error("timeout"); });
    expect(await makeEntityCheck(llm, corporateCfg)(makeLead())).toBe("GATE_ERROR");
  });

  it("sends company, location and email domain to the model", async () => {
    const { llm, prompts } = fakeLLM(match);
    await makeEntityCheck(llm, corporateCfg)(makeLead());
    expect(prompts[0]).toContain("Acme Manufacturing");
    expect(prompts[0]).toContain("Dayton, OH");
    expect(prompts[0]).toContain("acme.com");
  });
});

describe("gate 4: entity check (CANDIDATE, personal inbox)", () => {
  it("passes when the gmail address carries the person's name, without calling the model", async () => {
    const { llm, prompts } = fakeLLM(match);
    const r = await makeEntityCheck(llm, candidateCfg)(makeLead({ email: "janemiller88@gmail.com" }));
    expect(r).toBeNull();
    expect(prompts).toHaveLength(0);
  });

  it("rejects a gmail address that belongs to someone else", async () => {
    const { llm } = fakeLLM(match);
    expect(await makeEntityCheck(llm, candidateCfg)(makeLead({ email: "bobsmith@gmail.com" })))
      .toBe("ENTITY_MISMATCH");
  });
});

describe("emailMatchesName", () => {
  it.each([
    ["jane.miller", true],
    ["jmiller", true],
    ["miller.j", true],
    ["janedoe", true],
    ["xyz123", false],
  ])("%s -> %s", (local, expected) => {
    expect(emailMatchesName(local, "Jane", "Miller")).toBe(expected);
  });
});

describe("gate 4: code rules before the model", () => {
  it("rejects a .edu email for a hospital, even when the model says yes", async () => {
    const { llm, prompts } = fakeLLM(match);
    const r = await makeEntityCheck(llm, corporateCfg)(makeLead({
      company_name: "Kettering Health", company_domain: "kettering.edu", email: "kevin.price@kettering.edu",
    }));
    expect(r).toBe("ENTITY_MISMATCH");
    expect(prompts).toHaveLength(0);
  });

  it.each([
    ["Kettering Health", "kettering.edu", true],
    ["Wright State University", "wright.edu", false],
    ["Sinclair Community College", "sinclair.edu", false],
    ["Acme Manufacturing", "ox.ac.uk", true],
    ["Reynolds and Reynolds", "ohio.gov", true],
    ["Montgomery County", "mcohio.gov", false],
    ["Acme Manufacturing", "acme.com", false],
  ])("%s @ %s -> mismatch %s", (company, domain, expected) => {
    expect(institutionalMismatch(company, domain) !== null).toBe(expected);
  });
});
