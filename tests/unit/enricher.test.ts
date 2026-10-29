import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { CampaignConfig } from "../../src/config/schema.js";
import { checkDraft, companyKeyword, countSentences, shortCompanyName, draftAll, draftOne, type DraftOutput } from "../../src/core/enricher.js";
import type { LLMProvider } from "../../src/lib/llm/provider.js";
import { makeLead } from "../helpers.js";

const cfg = CampaignConfig.parse({
  campaign_name: "t", mode: "CORPORATE", sourcing_provider: "csv_import",
  target_geography: ["Ohio"], decision_maker_titles: ["CFO"],
  sender_company: "One Smarter", offer: "a 15-minute call about claims review",
});
const lead = makeLead({ first_name: "Jane", company_name: "Acme Manufacturing" });

const GOOD: DraftOutput = {
  research_summary: [],
  email_subject: "Claims review at Acme",
  email_body:
    "Benefits leaders at manufacturers like Acme Manufacturing often find payment errors only after the money is gone. " +
    "Our team spends most of its time looking at how claims files are checked before release. " +
    "I would value hearing how your team handles that step today. " +
    "Would you be open to a 15-minute call next week?",
};

/** Fake LLM that returns each answer in turn and records prompts and options. */
function seqLLM(answers: (DraftOutput | Error)[], grounding = false) {
  const calls: { prompt: string; opts: Record<string, unknown> }[] = [];
  let i = 0;
  const llm: LLMProvider = {
    name: "fake",
    supportsGrounding: grounding,
    async generateJSON<S extends z.ZodType>(prompt: string, schema: S, opts = {}): Promise<z.infer<S>> {
      calls.push({ prompt, opts: opts as Record<string, unknown> });
      const a = answers[Math.min(i++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      return schema.parse(a);
    },
    async generateText() { return ""; },
  };
  return { llm, calls };
}

describe("draft checks", () => {
  it("accepts a good draft", () => expect(checkDraft(GOOD, lead, cfg)).toEqual([]));

  it("counts sentences, ignoring abbreviations", () => {
    expect(countSentences("One. Two? Three! Four.")).toBe(4);
    expect(countSentences("We met Dr. Lee at Acme Inc. last week. Done.")).toBe(2);
  });

  it.each<[string, Partial<DraftOutput>, RegExp]>([
    ["long subject", { email_subject: "A subject line that is far too long here" }, /max 7/],
    ["3 sentences", { email_body: "Acme Manufacturing is busy. We help. Want a call?" }, /exactly 4/],
    ["no closing question", { email_body: GOOD.email_body.replace(/\?$/, ".") }, /question/],
    ["banned phrase", { email_body: "I hope this email finds you well at Acme Manufacturing. A. B. Call?" }, /banned phrase/],
    ["bullets", { email_body: "Acme Manufacturing:\n- one.\n- two.\n- three. Call?" }, /bullet/],
    ["link", { email_body: "Acme Manufacturing. See https://x.com now. Three. Call?" }, /link/],
    ["greeting", { email_body: "Hi Jane, Acme Manufacturing. Two. Three. Call?" }, /greeting/],
    ["placeholder", { email_body: "Acme Manufacturing. [Your Name] here. Three. Call?" }, /banned phrase "\["/],
    ["missing company", { email_body: "One thing. Two things. Three things. Call?" }, /does not name the company: write "Acme Manufacturing"/],
  ])("flags %s", (_n, change, re) => {
    expect(checkDraft({ ...GOOD, ...change }, lead, cfg).join(" | ")).toMatch(re);
  });

  it("does not require the employer name in candidate emails", () => {
    const cand = CampaignConfig.parse({ ...cfg, mode: "CANDIDATE" });
    expect(checkDraft({ ...GOOD, email_body: "One. Two. Three. Call?" }, lead, cand)).toEqual([]);
  });

  it.each([
    ["The Kroger Co.", "Kroger"],
    ["Reynolds and Reynolds", "Reynolds and Reynolds"],
    ["Acme Holdings, Inc.", "Acme Holdings"],
    ["Sample Benefits LLC", "Sample Benefits"],
    ["Premier Health", "Premier Health"],
  ])("short name of %s is %s", (full, short) => {
    expect(shortCompanyName(full)).toBe(short);
  });

  it("tells the model the exact company name to use", async () => {
    const { llm, calls } = seqLLM([GOOD]);
    await draftOne(makeLead({ company_name: "The Kroger Co." }), cfg, llm);
    expect(calls[0]!.prompt).toContain('You MUST name the company as "Kroger"');
  });

  it("gets the company keyword", () => {
    expect(companyKeyword("The Kroger Co.")).toBe("kroger");
    expect(companyKeyword("Dayton Children's Hospital")).toBe("dayton");
  });
});

describe("draftOne", () => {
  it("adds the greeting with the cleaned first name", async () => {
    const { llm } = seqLLM([GOOD]);
    const d = await draftOne(lead, cfg, llm);
    expect(d.draft_status).toBe("READY");
    expect(d.email_body.startsWith("Hi Jane,\n\n")).toBe(true);
  });

  it("rewrites with feedback, then passes", async () => {
    const bad = { ...GOOD, email_subject: "This subject line is much too long to use" };
    const { llm, calls } = seqLLM([bad, GOOD]);
    const d = await draftOne(lead, cfg, llm);
    expect(d.draft_status).toBe("READY");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("max 7");
  });

  it("marks NEEDS_REWRITE after the last attempt, keeping the issues", async () => {
    const bad = { ...GOOD, email_body: "Too short at Acme Manufacturing. Call?" };
    const { llm, calls } = seqLLM([bad]);
    const d = await draftOne(lead, cfg, llm, { maxAttempts: 2 });
    expect(d.draft_status).toBe("NEEDS_REWRITE");
    expect(d.draft_issues.join(" ")).toMatch(/exactly 4/);
    expect(calls).toHaveLength(2);
  });

  it("marks DRAFT_ERROR when the model fails, and keeps going", async () => {
    const { llm } = seqLLM([new Error("quota")]);
    const d = await draftOne(lead, cfg, llm);
    expect(d.draft_status).toBe("DRAFT_ERROR");
    expect(d.draft_issues).toEqual(["quota"]);
  });

  it("tells the model it has no web access when grounding is off", async () => {
    const { llm, calls } = seqLLM([GOOD], false);
    await draftOne(lead, cfg, llm);
    expect(calls[0]!.opts.system).toMatch(/NO web access/);
    expect(calls[0]!.opts.grounded).toBe(false);
  });

  it("asks for search facts when grounding is on", async () => {
    const { llm, calls } = seqLLM([GOOD], true);
    await draftOne(lead, cfg, llm);
    expect(calls[0]!.opts.system).toMatch(/Use Google Search/);
    expect(calls[0]!.opts.grounded).toBe(true);
  });

  it("limits the offer to the campaign's offer line", async () => {
    const { llm, calls } = seqLLM([GOOD]);
    await draftOne(lead, cfg, llm);
    expect(calls[0]!.opts.system).toContain("The ONLY thing you may offer is: a 15-minute call about claims review");
  });
});

describe("draftAll", () => {
  it("refuses a campaign without an offer", async () => {
    const noOffer = CampaignConfig.parse({ ...cfg, offer: undefined });
    await expect(draftAll([lead], noOffer, seqLLM([GOOD]).llm)).rejects.toThrow(/offer/);
  });

  it("drafts every lead, a few at a time", async () => {
    const { llm, calls } = seqLLM([GOOD]);
    const leads = Array.from({ length: 7 }, (_, i) => makeLead({ lead_id: `x${i}`, company_name: "Acme Manufacturing" }));
    const out = await draftAll(leads, cfg, llm, { concurrency: 2 });
    expect(out).toHaveLength(7);
    expect(calls).toHaveLength(7);
    expect(out.map((d) => d.lead_id)).toEqual(leads.map((l) => l.lead_id));
  });
});

void vi;
