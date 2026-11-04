import { describe, it, expect } from "vitest";
import { domainMatchesCompany, emailMatchesName, institutionalMismatch, makeEntityCheck, makeHybridEntityCheck, makeRuleEntityCheck, registrableDomain } from "../../src/core/gates/entity.js";
import { getEntityMode } from "../../src/core/gates/index.js";
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

describe("gate 4: rules mode (no model)", () => {
  it("registrable domain strips subdomains and keeps co.uk style suffixes", () => {
    expect(registrableDomain("www.mail.Acme.com")).toBe("acme.com");
    expect(registrableDomain("hr.acme.co.uk")).toBe("acme.co.uk");
  });

  it("matches on the company website domain, the company name, or an acronym", () => {
    expect(domainMatchesCompany("ohiohealth.com", "OhioHealth", undefined)).toBe("match");
    expect(domainMatchesCompany("mail.acme.com", "Acme Manufacturing", "www.acme.com")).toBe("match");
    expect(domainMatchesCompany("jpmchase.com", "JPMorgan Chase & Co.", "jpmorganchase.com")).toBe("match");
    expect(domainMatchesCompany("teb.com.tr", "Türk Ekonomi Bankası", undefined)).toBe("match");
  });

  it("calls a different known domain a mismatch, and an unknown one unknown", () => {
    expect(domainMatchesCompany("pthomecare.com", "New York Life", "newyorklife.com")).toBe("mismatch");
    expect(domainMatchesCompany("pthomecare.com", "New York Life", undefined)).toBe("unknown");
  });

  it("passes a matching domain without any model", async () => {
    expect(await makeRuleEntityCheck(corporateCfg)(makeLead({ email: "jane@acme.com", company_domain: "acme.com" }))).toBeNull();
  });

  it("holds back a guessed address at an unrelated domain", async () => {
    expect(await makeRuleEntityCheck(corporateCfg)(makeLead({ email: "jane@pthomecare.com", company_name: "New York Life", company_domain: "newyorklife.com", email_source: "pattern" }))).toBe("ENTITY_MISMATCH");
  });

  it("holds back a Seamless address at a different domain when the company's website is known", async () => {
    expect(await makeRuleEntityCheck(corporateCfg)(makeLead({ email: "jane@pthomecare.com", company_name: "New York Life", company_domain: "newyorklife.com", email_source: "seamless" }))).toBe("ENTITY_MISMATCH");
    expect(await makeRuleEntityCheck(corporateCfg)(makeLead({ email: "x@woolpert.com", company_name: "Infosys", company_domain: "infosys.com", email_source: "seamless" }))).toBe("ENTITY_MISMATCH");
  });

  it("trusts Seamless only when no company website is on record", async () => {
    expect(await makeRuleEntityCheck(corporateCfg)(makeLead({ email: "jane@pthomecare.com", company_name: "New York Life", company_domain: undefined, email_source: "seamless" }))).toBeNull();
    expect(await makeRuleEntityCheck(corporateCfg)(makeLead({ email: "jane@pthomecare.com", company_name: "New York Life", company_domain: undefined, email_source: "pattern" }))).toBe("ENTITY_MISMATCH");
  });

  it("still rejects a .edu address for a company, even from Seamless", async () => {
    expect(await makeRuleEntityCheck(corporateCfg)(makeLead({ email: "jane@osu.edu", company_name: "Acme Manufacturing", email_source: "seamless" }))).toBe("ENTITY_MISMATCH");
  });

  it("still requires the person's name on a candidate's gmail address", async () => {
    expect(await makeRuleEntityCheck(candidateCfg)(makeLead({ email: "someone.else@gmail.com" }))).toBe("ENTITY_MISMATCH");
    expect(await makeRuleEntityCheck(candidateCfg)(makeLead({ email: "jane.miller@gmail.com" }))).toBeNull();
  });
});

describe("gate 4: hybrid mode", () => {
  it("passes a matching domain without calling the model, and asks the model otherwise", async () => {
    const { llm, prompts } = fakeLLM({ same_organization: false, location_consistent: true, confidence: 0.9, reason: "other company" });
    const check = makeHybridEntityCheck(llm, corporateCfg);
    expect(await check(makeLead({ email: "jane@acme.com" }))).toBeNull();
    expect(prompts).toHaveLength(0);
    expect(await check(makeLead({ email: "jane@pthomecare.com", company_name: "New York Life", company_domain: "newyorklife.com" }))).toBe("ENTITY_MISMATCH");
    expect(prompts).toHaveLength(1);
  });
});

describe("gate 4: ENTITY_CHECK setting", () => {
  it("defaults to rules, accepts hybrid and gemini, rejects nonsense", async () => {
    expect(getEntityMode({})).toBe("rules");
    expect(getEntityMode({ ENTITY_CHECK: "hybrid" })).toBe("hybrid");
    expect(getEntityMode({ ENTITY_CHECK: "gemini" })).toBe("llm");
    expect(() => getEntityMode({ ENTITY_CHECK: "maybe" })).toThrow(/ENTITY_CHECK/);
  });
});
