import { describe, it, expect, vi } from "vitest";
import { seamlessEmailFinder, getEmailFinder } from "../../src/core/sources/email-finder.js";
import { firstRequestId, pickEmail, pollRows, seamlessMatch } from "../../src/core/sources/seamless-finder.js";
import { makeLead } from "../helpers.js";

const noEmailLead = (o = {}) =>
  makeLead({ email: undefined, first_name: "Jane", last_name: "Miller", company_domain: "acme.com", linkedin_url: "https://www.linkedin.com/in/jane-miller", ...o });

/** A fake fetch that answers each call in order: submit, then one poll per remaining entry. */
function seamlessReplies(steps: Array<{ body: unknown; status?: number }>) {
  let i = 0;
  return vi.fn(async () => {
    const s = steps[Math.min(i++, steps.length - 1)]!;
    return new Response(JSON.stringify(s.body), { status: s.status ?? 200 });
  }) as unknown as typeof fetch;
}

const fast = { pollMs: 0, maxWaitMs: 2_000 };
const submitted = { success: true, requestIds: ["req-1"] };
const done = (contact: unknown) => ({ success: true, data: [{ requestId: "req-1", status: "done", contact }] });

describe("getEmailFinder with seamless", () => {
  it("builds seamless and seamless_pattern", () => {
    expect(getEmailFinder({ EMAIL_FINDER: "seamless", SEAMLESS_API_KEY: "k" }).name).toBe("seamless");
    expect(getEmailFinder({ EMAIL_FINDER: "Seamless_Pattern", SEAMLESS_API_KEY: "k" }).name).toBe("seamless+pattern");
  });
  it("needs a Seamless key", () => expect(() => getEmailFinder({ EMAIL_FINDER: "seamless" })).toThrow(/SEAMLESS_API_KEY/));
  it("still rejects typos", () => expect(() => getEmailFinder({ EMAIL_FINDER: "seemless" })).toThrow(/Unknown/));
});

describe("firstRequestId", () => {
  it("reads a list", () => expect(firstRequestId([{ requestId: "a" }])).toBe("a"));
  it("reads a single object", () => expect(firstRequestId({ requestId: "b" })).toBe("b"));
  it("reads a wrapped list", () => expect(firstRequestId({ data: [{ requestId: "c" }] })).toBe("c"));
  it("reads the live shape: { success, requestIds: [...] }", () =>
    expect(firstRequestId({ success: true, requestIds: ["awKWWvryWyXxPpICuIUA6"] })).toBe("awKWWvryWyXxPpICuIUA6"));
  it("reads a bare list of id strings", () => expect(firstRequestId(["x1", "x2"])).toBe("x1"));
  it("returns nothing for junk", () => expect(firstRequestId({ ok: true })).toBeUndefined());
});

describe("pollRows", () => {
  it("unwraps the live shape { success, data: [...] }", () => {
    expect(pollRows({ success: true, data: [{ requestId: "a", status: "done" }] })).toEqual([{ requestId: "a", status: "done" }]);
  });
  it("accepts a bare list and a single row", () => {
    expect(pollRows([{ requestId: "a" }])).toEqual([{ requestId: "a" }]);
    expect(pollRows({ requestId: "a", status: "queued" })).toEqual([{ requestId: "a", status: "queued" }]);
  });
  it("returns nothing for junk", () => expect(pollRows(null)).toEqual([]));
});

describe("pickEmail", () => {
  it("prefers the main email", () => expect(pickEmail({ email: "Jane@Acme.com", email1: "j@acme.com" })).toBe("jane@acme.com"));
  it("skips an email Seamless marked invalid", () => {
    expect(pickEmail({ email: "old@acme.com", email1: "old@acme.com", email1EmailAI: "invalid", email2: "jane@acme.com", email2EmailAI: "valid" })).toBe("jane@acme.com");
  });
  it("keeps a risky email (Gate 5 decides)", () => expect(pickEmail({ email1: "jane@acme.com", email1EmailAI: "risky" })).toBe("jane@acme.com"));
  it("returns nothing without an @", () => expect(pickEmail({ email: "n/a" })).toBeUndefined());
});

describe("seamlessMatch", () => {
  it("submits, polls through researching, and returns the email", async () => {
    const f = seamlessReplies([
      { body: submitted },
      { body: [{ requestId: "req-1", status: "queued" }] },
      { body: [{ requestId: "req-1", status: "researching" }] },
      { body: done({ email: "Jane.Miller@acme.com", email1EmailAI: "valid" }) },
    ]);
    expect(await seamlessMatch(noEmailLead(), "k", f, fast)).toBe("jane.miller@acme.com");
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("returns the email from the exact live Seamless payload", async () => {
    const live = {
      success: true,
      data: [{
        requestId: "req-1", searchResultId: "03abf809", status: "done",
        contact: { contactId: "6073289942", firstName: "Benjamin", lastName: "Kister", email: "ben.kister@ohiohealth.com", personalEmail: "", company: "OhioHealth" },
      }],
    };
    const f = seamlessReplies([{ body: { success: true, requestIds: ["req-1"] } }, { body: live }]);
    expect(await seamlessMatch(noEmailLead(), "k", f, fast)).toBe("ben.kister@ohiohealth.com");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("sends the key in the Token header, never in the URL", async () => {
    const f = seamlessReplies([{ body: submitted }, { body: done({ email: "jane@acme.com" }) }]);
    await seamlessMatch(noEmailLead(), "secret", f, fast);
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const [url, init] of calls) {
      expect(String(url)).not.toContain("secret");
      expect((init as RequestInit).headers).toMatchObject({ Token: "secret" });
    }
  });

  it("sends full name, domain, and LinkedIn URL; never invents a domain", async () => {
    const f = seamlessReplies([{ body: submitted }, { body: done({ email: "jane@acme.com" }) }]);
    await seamlessMatch(noEmailLead(), "k", f, fast);
    const body = JSON.parse(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.contacts[0]).toEqual({ contactName: "Jane Miller", domain: "acme.com", liProfileUrl: "https://www.linkedin.com/in/jane-miller" });

    const g = seamlessReplies([{ body: submitted }, { body: done({ email: "jane@acme.com" }) }]);
    await seamlessMatch(noEmailLead({ company_domain: undefined, company_name: "The Kroger Co." }), "k", g, fast);
    const body2 = JSON.parse(((g as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as string);
    expect(body2.contacts[0].domain).toBeUndefined();
    expect(body2.contacts[0].companyName).toBe("The Kroger Co.");
  });

  it("returns nothing when Seamless says not found", async () => {
    const f = seamlessReplies([{ body: submitted }, { body: [{ requestId: "req-1", status: "not found" }] }]);
    expect(await seamlessMatch(noEmailLead(), "k", f, fast)).toBeUndefined();
  });

  it("returns nothing on a 401 submit (and does not throw)", async () => {
    const f = seamlessReplies([{ body: { error: "bad key" }, status: 401 }]);
    expect(await seamlessMatch(noEmailLead(), "k", f, fast)).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns nothing when the submit has no requestId", async () => {
    const f = seamlessReplies([{ body: { ok: true } }]);
    expect(await seamlessMatch(noEmailLead(), "k", f, fast)).toBeUndefined();
  });

  it("gives up after maxWaitMs while still researching", async () => {
    const f = seamlessReplies([{ body: submitted }, { body: [{ requestId: "req-1", status: "researching" }] }]);
    expect(await seamlessMatch(noEmailLead(), "k", f, { pollMs: 0, maxWaitMs: 50 })).toBeUndefined();
  });
});

describe("seamlessEmailFinder", () => {
  it("labels results as seamless", async () => {
    const fetchFn = seamlessReplies([{ body: submitted }, { body: done({ email: "jane@acme.com" }) }]);
    const f = seamlessEmailFinder({ apiKey: "k", guessPattern: true, fetchFn, poll: fast });
    expect(await f.find(noEmailLead())).toEqual({ email: "jane@acme.com", email_source: "seamless" });
  });
  it("falls back to a pattern guess when Seamless has nothing", async () => {
    const fetchFn = seamlessReplies([{ body: submitted }, { body: [{ requestId: "req-1", status: "not found" }] }]);
    const f = seamlessEmailFinder({ apiKey: "k", guessPattern: true, fetchFn, poll: fast });
    expect(await f.find(noEmailLead())).toEqual({ email: "jane.miller@acme.com", email_source: "pattern" });
  });
  it("does not guess in plain seamless mode", async () => {
    const fetchFn = seamlessReplies([{ body: submitted }, { body: [{ requestId: "req-1", status: "not found" }] }]);
    const f = seamlessEmailFinder({ apiKey: "k", guessPattern: false, fetchFn, poll: fast });
    expect(await f.find(noEmailLead())).toEqual({});
  });
  it("does not call Seamless when the lead already has a CSV email", async () => {
    const fetchFn = seamlessReplies([{ body: submitted }]);
    const f = seamlessEmailFinder({ apiKey: "k", guessPattern: true, fetchFn, poll: fast });
    await f.find(makeLead({ email: "x@acme.com", email_source: "csv" }));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
