import { describe, it, expect, vi } from "vitest";
import { apolloEmailFinder, getEmailFinder, noEmailFinder } from "../../src/core/sources/email-finder.js";
import { apolloMatch, guessEmail } from "../../src/core/sources/apollo-finder.js";
import { makeMailboxCheck, type MailboxVerifier } from "../../src/core/gates/mailbox.js";
import { readLeadFile } from "../../src/core/sources/csv.js";
import { makeLead } from "../helpers.js";

const apolloReturns = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const noEmailLead = (o = {}) => makeLead({ email: undefined, first_name: "Jane", last_name: "Miller", company_domain: "acme.com", ...o });

describe("getEmailFinder", () => {
  it("defaults to none", () => expect(getEmailFinder({}).name).toBe("none"));
  it("builds apollo and apollo_pattern", () => {
    expect(getEmailFinder({ EMAIL_FINDER: "apollo", APOLLO_API_KEY: "k" }).name).toBe("apollo");
    expect(getEmailFinder({ EMAIL_FINDER: "Apollo_Pattern", APOLLO_API_KEY: "k" }).name).toBe("apollo+pattern");
  });
  it("needs an Apollo key", () => expect(() => getEmailFinder({ EMAIL_FINDER: "apollo" })).toThrow(/APOLLO_API_KEY/));
  it("rejects a typo instead of silently using none", () => expect(() => getEmailFinder({ EMAIL_FINDER: "apolo" })).toThrow(/Unknown/));
});

describe("noEmailFinder", () => {
  it("keeps an existing email", async () => {
    expect(await noEmailFinder.find(makeLead({ email: "a@acme.com" }))).toEqual({ email: "a@acme.com", email_source: "search" });
  });
  it("adds nothing when there is none", async () => {
    expect(await noEmailFinder.find(noEmailLead())).toEqual({});
  });
});

describe("apolloMatch", () => {
  it("returns Apollo's email", async () => {
    expect(await apolloMatch(noEmailLead(), "k", apolloReturns({ person: { email: "Jane.Miller@acme.com" } }))).toBe("jane.miller@acme.com");
  });
  it("ignores Apollo's locked-email placeholder", async () => {
    expect(await apolloMatch(noEmailLead(), "k", apolloReturns({ person: { email: "email_not_unlocked@domain.com" } }))).toBeUndefined();
  });
  it("returns nothing on 403 (and does not throw)", async () => {
    expect(await apolloMatch(noEmailLead(), "k", apolloReturns({}, 403))).toBeUndefined();
  });
  it("never invents a domain from the company name", async () => {
    const f = apolloReturns({ person: null });
    await apolloMatch(noEmailLead({ company_domain: undefined, company_name: "The Kroger Co." }), "k", f);
    const body = JSON.parse((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
    expect(body.domain).toBeUndefined();
    expect(body.organization_name).toBe("The Kroger Co.");
  });
  it("sends the key in a header, not the URL", async () => {
    const f = apolloReturns({ person: null });
    await apolloMatch(noEmailLead(), "secret", f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).not.toContain("secret");
    expect(init.headers["x-api-key"]).toBe("secret");
  });
});

describe("guessEmail", () => {
  it.each([
    [{ first_name: "Jane", last_name: "Miller" }, "jane.miller@acme.com"],
    [{ first_name: "José", last_name: "García" }, "jose.garcia@acme.com"],
    [{ first_name: "Mary Ann", last_name: "van der Berg" }, "maryann.berg@acme.com"],
    [{ first_name: "Pat", last_name: "O'Neil" }, "pat.oneil@acme.com"],
  ])("%o -> %s", (names, expected) => {
    expect(guessEmail(noEmailLead(names))).toBe(expected);
  });
  it("does not guess without a real company domain", () => {
    expect(guessEmail(noEmailLead({ company_domain: undefined }))).toBeUndefined();
  });
});

describe("apolloEmailFinder", () => {
  it("labels Apollo results as apollo", async () => {
    const f = apolloEmailFinder({ apiKey: "k", guessPattern: true, fetchFn: apolloReturns({ person: { email: "jane@acme.com" } }) });
    expect(await f.find(noEmailLead())).toEqual({ email: "jane@acme.com", email_source: "apollo" });
  });
  it("labels guesses as pattern when Apollo has nothing", async () => {
    const f = apolloEmailFinder({ apiKey: "k", guessPattern: true, fetchFn: apolloReturns({}, 403) });
    expect(await f.find(noEmailLead())).toEqual({ email: "jane.miller@acme.com", email_source: "pattern" });
  });
  it("does not guess in plain apollo mode", async () => {
    const f = apolloEmailFinder({ apiKey: "k", guessPattern: false, fetchFn: apolloReturns({}, 403) });
    expect(await f.find(noEmailLead())).toEqual({});
  });
  it("does not call Apollo when the lead already has a CSV email", async () => {
    const fetchFn = apolloReturns({});
    const f = apolloEmailFinder({ apiKey: "k", guessPattern: true, fetchFn });
    await f.find(makeLead({ email: "x@acme.com", email_source: "csv" }));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("Gate 5 and guessed emails", () => {
  const goodMx = async () => [{ exchange: "mx.acme.com", priority: 10 }];
  const devSkip: MailboxVerifier = { name: "dev_skip", verify: async () => null };
  const zeroBounce = (result: null | "MAILBOX_INVALID"): MailboxVerifier => ({ name: "zerobounce", verify: async () => result });

  it("rejects a guess when the mailbox check is skipped", async () => {
    const check = makeMailboxCheck({ verifier: devSkip, resolveMx: goodMx });
    expect(await check(makeLead({ email: "jane.miller@acme.com", email_source: "pattern" }))).toBe("UNVERIFIED_GUESS");
  });
  it("passes a guess that ZeroBounce confirms", async () => {
    const check = makeMailboxCheck({ verifier: zeroBounce(null), resolveMx: goodMx });
    expect(await check(makeLead({ email: "jane.miller@acme.com", email_source: "pattern" }))).toBeNull();
  });
  it("rejects a guess that ZeroBounce says is invalid", async () => {
    const check = makeMailboxCheck({ verifier: zeroBounce("MAILBOX_INVALID"), resolveMx: goodMx });
    expect(await check(makeLead({ email: "jane.miller@acme.com", email_source: "pattern" }))).toBe("MAILBOX_INVALID");
  });
  it("still lets non-guessed emails through dev_skip during development", async () => {
    const check = makeMailboxCheck({ verifier: devSkip, resolveMx: goodMx });
    expect(await check(makeLead({ email: "jane@acme.com", email_source: "apollo" }))).toBeNull();
  });
});

describe("csv_import labels emails", () => {
  it("marks CSV emails as csv", async () => {
    const r = await readLeadFile("tests/fixtures/dirty_leads.csv");
    expect(r.leads.filter((l) => l.email).every((l) => l.email_source === "csv")).toBe(true);
  });
});
