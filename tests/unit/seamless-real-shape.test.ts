/**
 * Seamless.AI with the response shapes captured from the live API on 3 Nov 2026.
 * All names, emails and IDs here are made up.
 */
import { describe, it, expect, vi } from "vitest";
import { firstRequestId, pickEmail, pollRows, seamlessMatch } from "../../src/core/sources/seamless-finder.js";
import { makeLead } from "../helpers.js";

const SUBMIT = { success: true, requestIds: ["req-abc123"] };
const pending = (status = "researching") => ({ success: true, data: [{ requestId: "req-abc123", status }] });
const done = (contact: Record<string, unknown>) => ({
  success: true,
  data: [{ requestId: "req-abc123", searchResultId: "x", status: "done", contact }],
});
const CONTACT = {
  firstName: "Jane", lastName: "Doe",
  email: "jane_doe@example-corp.com",
  personalEmail: "jane.personal@mail.example",
  email1: "jane_doe@example-corp.com", email1EmailAI: "accept all", email1TotalAI: "91%",
  email2: "jane.doe@example-corp.com", email2EmailAI: "accept all",
  isDneAll: false, isDneSome: false,
};

/** Fake fetch: first call is the submit, the rest walk through the poll replies. */
function fakeSeamless(...polls: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = calls.length === 1 ? SUBMIT : polls[Math.min(i++, polls.length - 1)];
    return new Response(JSON.stringify(body), { status: calls.length === 1 ? 202 : 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const lead = makeLead({ email: undefined, first_name: "Jane", last_name: "Doe", company_domain: "example-corp.com" });

describe("Seamless response shapes (real)", () => {
  it("reads requestIds (plural) from the submit reply", () => {
    expect(firstRequestId(SUBMIT)).toBe("req-abc123");
  });
  it("still reads the older guessed shapes", () => {
    expect(firstRequestId({ requestId: "a" })).toBe("a");
    expect(firstRequestId([{ requestId: "b" }])).toBe("b");
    expect(firstRequestId({ data: [{ requestId: "c" }] })).toBe("c");
    expect(firstRequestId({ success: true, requestIds: [] })).toBeUndefined();
  });
  it("unwraps poll rows from data", () => {
    expect(pollRows(done(CONTACT))[0]!.status).toBe("done");
    expect(pollRows([{ status: "done" }])[0]!.status).toBe("done");
  });
  it("picks the work email, never the personal one", () => {
    expect(pickEmail({ ...CONTACT, email: null, email1: null, email2: null })).toBeUndefined();
    expect(pickEmail(CONTACT)).toBe("jane_doe@example-corp.com");
  });
});

describe("seamlessMatch end to end (fake API)", () => {
  it("submits, waits through 'researching', and returns the email when done", async () => {
    const { fetchFn, calls } = fakeSeamless(pending("queued"), pending("researching"), done(CONTACT));
    const email = await seamlessMatch(lead, "key", fetchFn, { pollMs: 0, maxWaitMs: 5_000 });
    expect(email).toBe("jane_doe@example-corp.com");
    expect(calls).toHaveLength(4);
    expect(calls[1]!.url).toContain("poll?requestIds=req-abc123");
  });

  it("sends the key in the Token header and the person in the body", async () => {
    const { fetchFn, calls } = fakeSeamless(done(CONTACT));
    await seamlessMatch(makeLead({ ...lead, linkedin_url: "https://www.linkedin.com/in/jane-doe" }), "secret", fetchFn, { pollMs: 0 });
    const init = calls[0]!.init!;
    expect((init.headers as Record<string, string>).Token).toBe("secret");
    expect(calls[0]!.url).not.toContain("secret");
    expect(JSON.parse(String(init.body))).toEqual({
      contacts: [{ contactName: "Jane Doe", domain: "example-corp.com", liProfileUrl: "https://www.linkedin.com/in/jane-doe" }],
    });
  });

  it("returns nothing for a Do Not Email contact", async () => {
    const { fetchFn } = fakeSeamless(done({ ...CONTACT, isDneAll: true }));
    expect(await seamlessMatch(lead, "key", fetchFn, { pollMs: 0 })).toBeUndefined();
  });

  it("returns nothing when Seamless did not find the person", async () => {
    const { fetchFn } = fakeSeamless({ success: true, data: [{ requestId: "req-abc123", status: "not found" }] });
    expect(await seamlessMatch(lead, "key", fetchFn, { pollMs: 0 })).toBeUndefined();
  });

  it("skips emails Seamless marks invalid", async () => {
    const { fetchFn } = fakeSeamless(done({ ...CONTACT, email: "bad@example-corp.com", email1: "bad@example-corp.com", email1EmailAI: "invalid" }));
    expect(await seamlessMatch(lead, "key", fetchFn, { pollMs: 0 })).toBe("jane.doe@example-corp.com");
  });

  it("gives up after the wait limit without throwing", async () => {
    const { fetchFn } = fakeSeamless(pending());
    expect(await seamlessMatch(lead, "key", fetchFn, { pollMs: 0, maxWaitMs: 20 })).toBeUndefined();
  });

  it("returns nothing on an auth error", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    expect(await seamlessMatch(lead, "bad", fetchFn, { pollMs: 0 })).toBeUndefined();
  });
});
