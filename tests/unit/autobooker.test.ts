import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/**
 * Runs apps_script/AutoBooker.gs against a fake Google (fake Sheet, Gmail, Calendar, Gemini),
 * so the sender's safety rules are tested without sending anything real.
 */

const HEADERS = ["Company", "Domain", "Name", "Title", "Email", "Research", "Status", "Subject", "DraftBody", "ThreadID"];
const STATUS_COL = 6;
const THREAD_COL = 9;

interface FakeMsg { getFrom(): string; getSubject(): string; getPlainBody(): string; getId(): string }
interface FakeThread { getId(): string; getMessages(): FakeMsg[]; reply(t: string): void; replies: string[]; msgs: FakeMsg[] }

interface Api {
  CONFIG: Record<string, unknown>;
  processApprovedEmails(): void;
  checkRepliesAndBook(): void;
  stripQuoted_(text: string): string;
  isOptOut_(text: string): boolean;
}

function row(o: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    Company: "Acme", Domain: "acme.com", Name: "Jane Miller", Title: "CFO", Email: "jane@acme.com",
    Research: "", Status: "Approved", Subject: "A note for Acme", DraftBody: "Hi Jane,\n\nOne. Two. Three. Four?", ThreadID: "",
  };
  return HEADERS.map((h) => o[h] ?? base[h]!);
}

function futureSlot(hourUtc = 15, kind: "weekday" | "saturday" = "weekday"): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCHours(hourUtc, 0, 0, 0);
  while (kind === "weekday" ? [0, 6].includes(d.getUTCDay()) : d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function setup(rows: string[][]) {
  const data: string[][] = [HEADERS, ...rows];
  const notes = new Map<string, string>();
  const sent: { to: string; subject: string; body: string; opts: { name?: string } }[] = [];
  const threads = new Map<string, FakeThread>();
  const events: unknown[][] = [];
  const props = new Map<string, string>([["GEMINI_API_KEY", "test-key"]]);
  const fetches: unknown[][] = [];
  const state = { busy: false, gemini: { code: 200, body: "" as string }, sendThrows: false, n: 0 };

  const addMsg = (t: FakeThread, from: string, subject: string, body: string) => {
    state.n += 1;
    const id = `M${state.n}`;
    t.msgs.push({ getFrom: () => from, getSubject: () => subject, getPlainBody: () => body, getId: () => id });
  };
  const addThread = (id: string): FakeThread => {
    const t: FakeThread = { getId: () => id, getMessages: () => t.msgs, reply: (x) => void t.replies.push(x), replies: [], msgs: [] };
    addMsg(t, "Me <me@one.com>", "A note for Acme", "our email");
    threads.set(id, t);
    return t;
  };
  const gemini = (o: unknown) => {
    state.gemini = { code: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] }) };
  };

  const sheet = {
    getDataRange: () => ({ getValues: () => data.map((r) => [...r]) }),
    getRange: (r: number, c: number) => ({
      setValue: (v: string) => { data[r - 1]![c - 1] = v; },
      setNote: (n: string) => { notes.set(`${r}:${c}`, n); },
    }),
  };

  const pad = (n: number) => String(n).padStart(2, "0");
  const globals = {
    Logger: { log: () => undefined },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => void props.set(k, v) }) },
    Session: { getScriptTimeZone: () => "UTC", getEffectiveUser: () => ({ getEmail: () => "me@one.com" }) },
    Utilities: {
      sleep: () => undefined,
      formatDate: (d: Date, _tz: string, f: string) => {
        const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()]!;
        const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
        if (f === "yyyy-MM-dd") return date;
        if (f === "H") return String(d.getUTCHours());
        if (f === "m") return String(d.getUTCMinutes());
        if (f === "u") return String(d.getUTCDay() === 0 ? 7 : d.getUTCDay());
        if (f === "XXX") return "Z";
        return `${day}, ${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      },
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => (n === "Pipeline" ? sheet : null) }), flush: () => undefined },
    GmailApp: {
      createDraft: (to: string, subject: string, body: string, opts: { name?: string }) => ({
        send: () => {
          if (state.sendThrows) throw new Error("Gmail is down");
          sent.push({ to, subject, body, opts });
          const t = addThread(`T${sent.length}`);
          return { getThread: () => t };
        },
      }),
      getThreadById: (id: string) => threads.get(id) ?? null,
    },
    CalendarApp: {
      getDefaultCalendar: () => ({
        getEvents: () => (state.busy ? [{}] : []),
        createEvent: (...args: unknown[]) => void events.push(args),
      }),
    },
    UrlFetchApp: {
      fetch: (...args: unknown[]) => {
        fetches.push(args);
        return { getResponseCode: () => state.gemini.code, getContentText: () => state.gemini.body };
      },
    },
  };

  const ctx = vm.createContext({ ...globals });
  vm.runInContext(
    readFileSync(join(process.cwd(), "apps_script/AutoBooker.gs"), "utf8") +
      "\n;globalThis.__api = { CONFIG, processApprovedEmails, checkRepliesAndBook, stripQuoted_, isOptOut_, buildEmailBody_, setupTriggers };",
    ctx,
  );
  const api = (ctx as unknown as { __api: Api }).__api;
  const configure = () => Object.assign(api.CONFIG, {
    SENDER_NAME: "Alex Rivera", SENDER_TITLE: "Founder", COMPANY_NAME: "One Smarter Inc.",
    POSTAL_ADDRESS: "1 Main Street, Dayton, OH 45402", SEND_GAP_MS: 0,
  });

  return {
    api, configure, data, notes, sent, threads, events, props, fetches, state, addThread, addMsg, gemini,
    status: (i: number) => data[i]![STATUS_COL]!,
    note: (i: number) => notes.get(`${i + 1}:${STATUS_COL + 1}`),
  };
}

const STOP_FOOTER = 'If you would rather not hear from me again, just reply "STOP" and I will not contact you again.';
const quoted = `\n\nOn Mon, Nov 2, 2026 at 9:00 AM Me <me@one.com> wrote:\n> Hi Jane,\n> One. Two.\n> ${STOP_FOOTER}\n`;

describe("sending", () => {
  it("refuses to send while the name and postal address are still placeholders", () => {
    const e = setup([row()]);
    expect(() => e.api.processApprovedEmails()).toThrow(/CONFIG\./);
    expect(e.sent).toHaveLength(0);
    expect(e.status(1)).toBe("Approved");
  });

  it("sends only Approved rows, with signature, postal address and opt-out line", () => {
    const e = setup([row(), row({ Email: "bob@acme.com", Status: "Ready for Review" })]);
    e.configure();
    e.api.processApprovedEmails();
    expect(e.sent).toHaveLength(1);
    const m = e.sent[0]!;
    expect(m.to).toBe("jane@acme.com");
    expect(m.body).toContain("Alex Rivera");
    expect(m.body).toContain("1 Main Street, Dayton, OH 45402");
    expect(m.body).toContain('reply "STOP"');
    expect(m.body).not.toContain("Automated Outreach Engine");
    expect(m.opts.name).toBe("Alex Rivera");
    expect(e.status(1)).toBe("Sent");
    expect(e.data[1]![THREAD_COL]).toBe("T1");
    expect(e.status(2)).toBe("Ready for Review");
  });

  it("never emails the same person twice, even if two rows are Approved", () => {
    const e = setup([row(), row({ Name: "Jane M." })]);
    e.configure();
    e.api.processApprovedEmails();
    expect(e.sent).toHaveLength(1);
    expect(e.status(2)).toBe("Rejected");
  });

  it("skips people already Sent, Opted Out or stuck in Sending", () => {
    const e = setup([
      row({ Email: "a@x.com", Status: "Sent" }), row({ Email: "a@x.com" }),
      row({ Email: "b@x.com", Status: "Opted Out" }), row({ Email: "b@x.com" }),
      row({ Email: "c@x.com", Status: "Sending" }), row({ Email: "c@x.com" }),
    ]);
    e.configure();
    e.api.processApprovedEmails();
    expect(e.sent).toHaveLength(0);
    expect([2, 4, 6].map((i) => e.status(i))).toEqual(["Rejected", "Rejected", "Rejected"]);
  });

  it("flags bad addresses and empty drafts instead of sending", () => {
    const e = setup([row({ Email: "not-an-email" }), row({ Email: "ok@x.com", DraftBody: "" })]);
    e.configure();
    e.api.processApprovedEmails();
    expect(e.sent).toHaveLength(0);
    expect([e.status(1), e.status(2)]).toEqual(["Send Error", "Send Error"]);
  });

  it("stops at the daily limit, and the limit survives into the next run", () => {
    const rows = ["a", "b", "c", "d"].map((n) => row({ Email: `${n}@x.com` }));
    const e = setup(rows);
    e.configure();
    e.api.CONFIG.MAX_SENDS_PER_DAY = 2;
    e.api.processApprovedEmails();
    e.api.processApprovedEmails();
    expect(e.sent).toHaveLength(2);
    expect([1, 2, 3, 4].map((i) => e.status(i))).toEqual(["Sent", "Sent", "Approved", "Approved"]);
  });

  it("respects the per-run limit", () => {
    const e = setup(["a", "b", "c"].map((n) => row({ Email: `${n}@x.com` })));
    e.configure();
    e.api.CONFIG.MAX_SENDS_PER_RUN = 1;
    e.api.processApprovedEmails();
    expect(e.sent).toHaveLength(1);
  });

  it("marks Send Error (and no thread id) when Gmail fails", () => {
    const e = setup([row()]);
    e.configure();
    e.state.sendThrows = true;
    e.api.processApprovedEmails();
    expect(e.status(1)).toBe("Send Error");
    expect(e.data[1]![THREAD_COL]).toBe("");
  });
});

describe("reading replies", () => {
  const sentRow = (o: Partial<Record<string, string>> = {}) => row({ Status: "Sent", ThreadID: "T1", ...o });
  const reply = (e: ReturnType<typeof setup>, body: string, from = "Jane <jane@acme.com>", subject = "Re: A note for Acme") =>
    e.addMsg(e.threads.get("T1")!, from, subject, body);

  it("does NOT treat a reply that quotes our STOP footer as an opt-out", () => {
    const e = setup([sentRow()]);
    e.configure();
    e.addThread("T1");
    e.gemini({ isInterested: true, wantsNoContact: false, dateTimeISO: futureSlot() });
    reply(e, "Thursday at 3pm works for me." + quoted);
    e.api.checkRepliesAndBook();
    expect(e.status(1)).toBe("Replied");
    expect(e.fetches).toHaveLength(1);
  });

  it.each(["STOP", "stop.", "Please stop emailing me.", "Unsubscribe", "Remove me from your list", "Don't contact me again"])(
    "marks %s as Opted Out",
    (text) => {
      const e = setup([sentRow()]);
      e.addThread("T1");
      reply(e, text + quoted);
      e.api.checkRepliesAndBook();
      expect(e.status(1)).toBe("Opted Out");
      expect(e.fetches).toHaveLength(0);
    },
  );

  it("does not treat 'stop by' as an opt-out", () => {
    const e = setup([sentRow()]);
    e.addThread("T1");
    e.gemini({ isInterested: false, wantsNoContact: false, dateTimeISO: null });
    reply(e, "Feel free to stop by our office next week.");
    e.api.checkRepliesAndBook();
    expect(e.status(1)).toBe("Replied");
  });

  it("still honours an opt-out after the row already says Replied or Meeting Booked", () => {
    const e = setup([sentRow({ Status: "Replied" }), sentRow({ Status: "Meeting Booked", Email: "b@x.com", ThreadID: "T2" })]);
    e.addThread("T1");
    e.addThread("T2");
    reply(e, "STOP");
    e.addMsg(e.threads.get("T2")!, "Bob <b@x.com>", "Re: hi", "unsubscribe me please");
    e.api.checkRepliesAndBook();
    expect([e.status(1), e.status(2)]).toEqual(["Opted Out", "Opted Out"]);
  });

  it("marks bounces as Bounced, and ignores out-of-office auto-replies", () => {
    const e = setup([sentRow(), sentRow({ Email: "b@x.com", ThreadID: "T2" })]);
    e.addThread("T1");
    e.addThread("T2");
    reply(e, "Address not found", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)");
    e.addMsg(e.threads.get("T2")!, "Bob <b@x.com>", "Automatic reply: A note", "I am away until Monday");
    e.api.checkRepliesAndBook();
    expect([e.status(1), e.status(2)]).toEqual(["Bounced", "Sent"]);
  });

  it("reads each reply only once", () => {
    const e = setup([sentRow()]);
    e.addThread("T1");
    e.gemini({ isInterested: false, wantsNoContact: false, dateTimeISO: null });
    reply(e, "Not now, thanks.");
    e.api.checkRepliesAndBook();
    e.api.checkRepliesAndBook();
    expect(e.fetches).toHaveLength(1);
  });

  it("leaves it for a human when there is no Gemini key", () => {
    const e = setup([sentRow()]);
    e.props.delete("GEMINI_API_KEY");
    e.addThread("T1");
    reply(e, "Sure, let's talk Tuesday 10am.");
    e.api.checkRepliesAndBook();
    expect(e.status(1)).toBe("Replied");
    expect(e.fetches).toHaveLength(0);
    expect(e.events).toHaveLength(0);
  });

  it("leaves it for a human when Gemini fails", () => {
    const e = setup([sentRow()]);
    e.addThread("T1");
    e.state.gemini = { code: 500, body: "" };
    reply(e, "Sure, let's talk Tuesday 10am.");
    e.api.checkRepliesAndBook();
    expect(e.status(1)).toBe("Replied");
    expect(e.note(1)).toContain("Read it in Gmail");
    expect(e.events).toHaveLength(0);
  });
});

describe("booking", () => {
  const start = () => {
    const e = setup([row({ Status: "Sent", ThreadID: "T1" })]);
    e.configure();
    e.addThread("T1");
    return e;
  };
  const interested = (e: ReturnType<typeof setup>, iso: string | null) => {
    e.gemini({ isInterested: true, wantsNoContact: false, dateTimeISO: iso });
    e.addMsg(e.threads.get("T1")!, "Jane <jane@acme.com>", "Re: A note", "Yes, happy to talk.");
  };

  it("by default only flags the proposed time: no event, no email", () => {
    const e = start();
    interested(e, futureSlot());
    e.api.checkRepliesAndBook();
    expect(e.status(1)).toBe("Replied");
    expect(e.note(1)).toContain("AUTO_BOOK");
    expect(e.events).toHaveLength(0);
    expect(e.threads.get("T1")!.replies).toHaveLength(0);
  });

  it("with AUTO_BOOK on, creates the event and really invites the prospect", () => {
    const e = start();
    e.api.CONFIG.AUTO_BOOK = true;
    interested(e, futureSlot());
    e.api.checkRepliesAndBook();
    expect(e.status(1)).toBe("Meeting Booked");
    expect(e.events).toHaveLength(1);
    const [title, , , opts] = e.events[0] as [string, Date, Date, { guests: string; sendInvites: boolean }];
    expect(title).toContain("Jane Miller");
    expect(opts.guests).toBe("jane@acme.com");
    expect(opts.sendInvites).toBe(true);
    expect(e.threads.get("T1")!.replies).toHaveLength(0);
  });

  it("only sends the confirmation email when AUTO_REPLY is also on", () => {
    const e = start();
    e.api.CONFIG.AUTO_BOOK = true;
    e.api.CONFIG.AUTO_REPLY = true;
    interested(e, futureSlot());
    e.api.checkRepliesAndBook();
    expect(e.threads.get("T1")!.replies).toHaveLength(1);
  });

  it.each([
    ["in the past", "2020-01-06T15:00:00Z", /past/],
    ["on a weekend", futureSlot(15, "saturday"), /weekend/],
    ["outside business hours", futureSlot(23), /business hours/],
  ])("will not book a time that is %s", (_n, iso, why) => {
    const e = start();
    e.api.CONFIG.AUTO_BOOK = true;
    interested(e, iso);
    e.api.checkRepliesAndBook();
    expect(e.events).toHaveLength(0);
    expect(e.status(1)).toBe("Replied");
    expect(e.note(1)).toMatch(why);
  });

  it("will not double-book a busy calendar", () => {
    const e = start();
    e.api.CONFIG.AUTO_BOOK = true;
    e.state.busy = true;
    interested(e, futureSlot());
    e.api.checkRepliesAndBook();
    expect(e.events).toHaveLength(0);
    expect(e.note(1)).toContain("busy");
  });

  it("flags interest with no specific time instead of guessing one", () => {
    const e = start();
    e.api.CONFIG.AUTO_BOOK = true;
    interested(e, null);
    e.api.checkRepliesAndBook();
    expect(e.events).toHaveLength(0);
    expect(e.note(1)).toContain("no specific time");
  });
});

describe("helpers", () => {
  const { api } = setup([]);
  it("strips the quoted copy of our email", () => {
    expect(api.stripQuoted_("Sounds good.\n\nOn Mon, Nov 2, 2026 at 9:00 AM A <a@b.com> wrote:\n> old\n")).toBe("Sounds good.");
    expect(api.stripQuoted_("Yes\n\n-----Original Message-----\nFrom: x")).toBe("Yes");
    expect(api.stripQuoted_("> only quoted\nreal line")).toBe("real line");
  });
  it("detects opt-outs conservatively", () => {
    expect(api.isOptOut_("no more emails please")).toBe(true);
    expect(api.isOptOut_("Thursday works")).toBe(false);
  });
  it("creates exactly one 10-minute trigger per job, with no duplicates on re-run", () => {
    const created: string[] = [];
    const deleted: string[] = [];
    const existing = [{ getHandlerFunction: () => "processApprovedEmails" }];
    const ctx = vm.createContext({
      ScriptApp: {
        getProjectTriggers: () => existing,
        deleteTrigger: (t: { getHandlerFunction(): string }) => void deleted.push(t.getHandlerFunction()),
        newTrigger: (fn: string) => ({ timeBased: () => ({ everyMinutes: (n: number) => ({ create: () => void created.push(`${fn}:${n}`) }) }) }),
      },
    });
    vm.runInContext(readFileSync(join(process.cwd(), "apps_script/AutoBooker.gs"), "utf8") + "\n;setupTriggers();", ctx);
    expect(created).toEqual(["processApprovedEmails:10", "checkRepliesAndBook:10"]);
    expect(deleted).toEqual(["processApprovedEmails"]);
  });
});
