/**
 * Tests for apps_script/AutoBooker.gs.
 * The script runs inside a Node vm with fakes for the Google services it uses
 * (SpreadsheetApp, GmailApp, CalendarApp, LockService, Utilities, Session, ScriptApp).
 * The clock is frozen at Monday 2 Nov 2026, 09:00 Eastern.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { PIPELINE_HEADERS } from "../../src/core/exporter.js";
import { DO_NOT_CONTACT_STATUSES } from "../../src/core/optout-sync.js";

const NOW = Date.UTC(2026, 10, 2, 14, 0); // Mon 2 Nov 2026 09:00 America/New_York
const SCRIPT = readFileSync(join(process.cwd(), "apps_script/AutoBooker.gs"), "utf8");

// ---------------------------------------------------------------- Utilities.formatDate
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(d: Date, tz: string, pattern: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "long",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const y = +p.year!, M = +p.month!, D = +p.day!, H = +p.hour!, m = +p.minute!;
  const h12 = H % 12 === 0 ? 12 : H % 12;
  const pad = (n: number) => String(n).padStart(2, "0");
  return pattern.replace(/'[^']*'|yyyy|EEEE|MMM|MM|M|dd|d|HH|H|hh|h|mm|m|a/g, (t) => {
    switch (t) {
      case "yyyy": return String(y);
      case "EEEE": return p.weekday!;
      case "MMM": return MONTHS[M - 1]!;
      case "MM": return pad(M);
      case "M": return String(M);
      case "dd": return pad(D);
      case "d": return String(D);
      case "HH": return pad(H);
      case "H": return String(H);
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "mm": return pad(m);
      case "m": return String(m);
      case "a": return H < 12 ? "AM" : "PM";
      default: return t.slice(1, -1); // quoted literal
    }
  });
}

// ---------------------------------------------------------------- fake Sheets
class FakeSheet {
  cells: unknown[][] = [];
  appended: unknown[][] = [];
  constructor(public name: string) {}
  get(r: number, c: number) { return this.cells[r]?.[c] ?? ""; }
  set(r: number, c: number, v: unknown) { (this.cells[r] ??= [])[c] = v; }
  getLastRow() { let n = 0; this.cells.forEach((row, i) => { if (row && row.some((v) => v !== "" && v !== undefined)) n = i; }); return n; }
  getMaxColumns() { return 26; }
  getName() { return this.name; }
  getMaxRows() { return 1000; }
  insertColumnsAfter() {}
  setColumnWidth() {} setColumnWidths() {} setFrozenRows() {}
  getRange(r: number, c: number, nr = 1, nc = 1) {
    const self = this;
    const range = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => self.get(r + i, c + j))),
      setValue: (v: unknown) => { self.set(r, c, v); return range; },
      setValues: (vals: unknown[][]) => { vals.forEach((row, i) => row.forEach((v, j) => self.set(r + i, c + j, v))); return range; },
      setFontWeight: () => range, setBackground: () => range, setNumberFormat: () => range,
    };
    return range;
  }
  getDataRange() {
    const last = this.getLastRow();
    let cols = 0; this.cells.forEach((row) => { if (row) cols = Math.max(cols, row.length - 1); });
    return this.getRange(1, 1, last, cols);
  }
  appendRow(row: unknown[]) { this.appended.push(row); this.set(this.getLastRow() + 1, 1, row[0]); row.forEach((v, j) => this.set(this.getLastRow(), j + 1, v)); }
}

type Row = Partial<Record<"company" | "name" | "email" | "status" | "subject" | "body" | "threadId" | "messageId" | "sentAt" | "lastReplyAt" | "sendState" | "notes", unknown>>;
const COLS = { company: 1, domain: 2, name: 3, title: 4, email: 5, research: 6, status: 7, subject: 8, body: 9, threadId: 10, messageId: 11, sentAt: 12, lastReplyAt: 13, sendState: 14, notes: 15 } as const;

const LIVE_CONFIG: Record<string, string> = {
  DryRun: "FALSE", SenderName: "Vikram Sethi", SenderTitle: "Founder", Street: "1 Main St", CityStateZip: "Dayton, OH 45402",
};

// ---------------------------------------------------------------- fake Gmail / Calendar
interface FakeMsg { from: string; date: Date; body: string }
class FakeThread {
  replies: string[] = [];
  constructor(public id: string, public msgs: FakeMsg[]) {}
  getId() { return this.id; }
  getMessages() { return this.msgs.map((m) => ({ getFrom: () => m.from, getDate: () => m.date, getPlainBody: () => m.body })); }
  reply(text: string) { this.replies.push(text); }
}

function setup(opts: { rows?: Row[]; jobRows?: Row[]; config?: Record<string, string>; busy?: { s: Date; e: Date }[]; threads?: FakeThread[]; lockFree?: boolean; sendThrows?: boolean } = {}) {
  const sheets = new Map<string, FakeSheet>();
  const pipeline = new FakeSheet("Pipeline");
  sheets.set("Pipeline", pipeline);
  PIPELINE_HEADERS.forEach((h, i) => pipeline.set(1, i + 1, h));
  (opts.rows ?? []).forEach((row, i) => {
    for (const [k, v] of Object.entries(row)) pipeline.set(i + 2, COLS[k as keyof typeof COLS], v);
  });
  // Jobs_Pipeline exists only when the test gives it rows, like a Sheet before the first search_jobs run.
  const jobs = new FakeSheet("Jobs_Pipeline");
  if (opts.jobRows) {
    sheets.set("Jobs_Pipeline", jobs);
    PIPELINE_HEADERS.forEach((h, i) => jobs.set(1, i + 1, h));
    opts.jobRows.forEach((row, i) => {
      for (const [k, v] of Object.entries(row)) jobs.set(i + 2, COLS[k as keyof typeof COLS], v);
    });
  }

  const config = new FakeSheet("Config");
  sheets.set("Config", config);
  config.set(1, 1, "Key"); config.set(1, 2, "Value");
  Object.entries(opts.config ?? {}).forEach(([k, v], i) => { config.set(i + 2, 1, k); config.set(i + 2, 2, v); });

  const sent: { to: string; subject: string; body: string }[] = [];
  const events: { title: string; start: Date; end: Date; opts: Record<string, unknown> }[] = [];
  const threads = new Map((opts.threads ?? []).map((t) => [t.id, t]));
  let n = 0;

  const RealDate = Date;
  function FakeDate(this: unknown, ...a: unknown[]) {
    return a.length ? new (RealDate as unknown as new (...x: unknown[]) => Date)(...a) : new RealDate(NOW);
  }
  FakeDate.prototype = RealDate.prototype;
  Object.assign(FakeDate, { now: () => NOW, UTC: RealDate.UTC, parse: RealDate.parse });

  const globals = {
    Date: FakeDate,
    console: { log: () => {} },
    SpreadsheetApp: {
      flush: () => {},
      getActiveSpreadsheet: () => ({
        getSheetByName: (name: string) => sheets.get(name) ?? null,
        insertSheet: (name: string) => { const s = new FakeSheet(name); sheets.set(name, s); return s; },
      }),
    },
    GmailApp: {
      createDraft: (to: string, subject: string, body: string) => ({
        send: () => {
          if (opts.sendThrows) throw new Error("Gmail quota");
          n += 1;
          sent.push({ to, subject, body });
          const t = new FakeThread(`thread-${n}`, []);
          threads.set(t.id, t);
          return { getId: () => `msg-${n}`, getThread: () => t };
        },
      }),
      getThreadById: (id: string) => threads.get(id) ?? null,
    },
    CalendarApp: {
      getDefaultCalendar: () => ({
        getEvents: (s: Date, e: Date) => (opts.busy ?? [])
          .filter((b) => s.getTime() < b.e.getTime() && e.getTime() > b.s.getTime())
          .map((b) => ({ getStartTime: () => b.s, getEndTime: () => b.e })),
        createEvent: (title: string, start: Date, end: Date, o: Record<string, unknown>) => { events.push({ title, start, end, opts: o }); },
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => opts.lockFree !== false, releaseLock: () => {} }) },
    Utilities: { formatDate },
    Session: { getScriptTimeZone: () => "America/New_York" },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }) },
  };

  const ctx = vm.createContext(globals) as Record<string, (...a: unknown[]) => unknown>;
  vm.runInContext(SCRIPT, ctx);
  const cell = (row: number, col: keyof typeof COLS) => pipeline.get(row, COLS[col]);
  const jobCell = (row: number, col: keyof typeof COLS) => jobs.get(row, COLS[col]);
  return { ctx, pipeline, jobs, cell, jobCell, sent, events, threads, sheets };
}

const et = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h + 5, mi)); // Eastern Standard Time (after 1 Nov 2026)

// =====================================================================================
describe("reply reading (pure functions)", () => {
  const { ctx } = setup();
  const strip = (t: string) => ctx.stripQuotedText_!(t) as string;
  const classify = (t: string) => (ctx.classifyReply_!(t, { notes: "" }, { TimeZone: "America/New_York" }) as { kind: string }).kind;

  const quoted = "Sure, Tuesday at 2pm works.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Vikram <v@onesmarter.com> wrote:\n> reply with the word unsubscribe and I will remove you.";

  it("cuts Gmail quoted text", () => expect(strip(quoted)).toBe("Sure, Tuesday at 2pm works."));
  it("cuts Outlook quoted text", () => expect(strip("No thanks.\n________________________________\nFrom: Vikram\nSent: Monday")).toBe("No thanks."));
  it("cuts lines quoted with > even without an 'On ... wrote:' header", () =>
    expect(strip("Thursday works.\n> If you would rather not hear from me again, reply with the word unsubscribe")).toBe("Thursday works."));
  it("cuts phone signatures", () => expect(strip("Yes please.\nSent from my iPhone")).toBe("Yes please."));

  it("a friendly reply that quotes our opt-out line is NOT an opt-out", () => expect(classify(strip(quoted))).toBe("TIME_PROPOSED"));
  it.each(["Please remove me from your list.", "unsubscribe", "Stop emailing me", "Do not contact me again"])(
    "opt-out: %s", (t) => expect(classify(t)).toBe("OPT_OUT"));
  it.each(["Not interested, thanks.", "No thanks, we are all set."])(
    "a decline goes to a person, not to opt-outs: %s", (t) => expect(classify(t)).toBe("NEEDS_HUMAN"));
  it.each(["What times do you have open this week?", "Send me a few options", "What's your availability?"])(
    "times requested: %s", (t) => expect(classify(t)).toBe("TIMES_REQUESTED"));
  it.each(["Can you tell me more about pricing?", "Thursday could work.", "", "We sat down and discussed it."])(
    "needs a person: %j", (t) => expect(classify(t)).toBe("NEEDS_HUMAN"));

  // A time inside a refusal, a choice between days, or an autoresponder must never book a meeting.
  it.each([
    "Tuesday at 2pm doesn't work for me, can you do Thursday?",
    "Tuesday 2pm is not going to work, I am travelling.",
    "I can't do Tuesday at 2pm.",
    "Tuesday at 2pm or Wednesday at 10am, whichever suits you.",
    "I am out of the office and will be back Monday at 9am.",
    "Automatic reply: on leave until Tuesday, returning 9am.",
  ])("does not book on: %s", (t) => expect(classify(t)).toBe("NEEDS_HUMAN"));
  it.each(["Tuesday at 2pm?", "Does Tuesday at 2pm work for you?", "Sure, Tuesday at 2pm works."])(
    "still books a plain proposal: %s", (t) => expect(classify(t)).toBe("TIME_PROPOSED"));
});

describe("time parsing", () => {
  const { ctx } = setup();
  const now = new Date(NOW);
  const parse = (t: string, tz = "America/New_York") => {
    const d = ctx.parseProposedTime_!(t, now, tz) as Date | null;
    return d ? d.toISOString() : null;
  };

  it("Tuesday at 2pm Eastern (after the DST change)", () => expect(parse("tuesday at 2pm")).toBe("2026-11-03T19:00:00.000Z"));
  it("Nov 5 at 10:30 am Central", () => expect(parse("Nov 5 at 10:30 am", "America/Chicago")).toBe("2026-11-05T16:30:00.000Z"));
  it("tomorrow at noon", () => expect(parse("tomorrow at noon")).toBe("2026-11-03T17:00:00.000Z"));
  it("11/6 at 14:30", () => expect(parse("11/6 at 14:30")).toBe("2026-11-06T19:30:00.000Z"));
  it("Thurs. 3 pm", () => expect(parse("thurs 3 pm")).toBe("2026-11-05T20:00:00.000Z"));
  it("'monday' on a Monday means next week", () => expect(parse("monday at 10am")).toBe("2026-11-09T15:00:00.000Z"));
  it("rejects a time already past", () => expect(parse("today at 8am")).toBeNull());
  it("rejects a time more than 60 days out", () => expect(parse("feb 20 at 10am")).toBeNull());
  it("needs both a day and a time", () => { expect(parse("tuesday")).toBeNull(); expect(parse("at 2pm")).toBeNull(); });
});

// =====================================================================================
describe("sendApproved", () => {
  const approved = (email: string, extra: Row = {}): Row => ({
    company: "Acme", name: "Jane Miller", email, status: "Approved", subject: "Claims review", body: "Hi Jane,\n\nFour sentences.", ...extra,
  });

  it("sends only Approved rows, once, and records the thread", () => {
    const t = setup({
      config: LIVE_CONFIG,
      rows: [approved("a@acme.com"), { ...approved("b@acme.com"), status: "Ready for Review" }, { ...approved("c@acme.com"), status: "Needs Rewrite" }],
    });
    t.ctx.sendApproved!();
    expect(t.sent.map((s) => s.to)).toEqual(["a@acme.com"]);
    expect(t.cell(2, "status")).toBe("Sent");
    expect(t.cell(2, "threadId")).toBe("thread-1");
    expect(t.cell(2, "messageId")).toBe("msg-1");
    expect(t.cell(2, "sendState")).toBe("SENT");
    expect(t.cell(2, "sentAt")).toBeInstanceOf(Date);
  });

  it("never sends the same row twice, even if the trigger runs again", () => {
    const t = setup({ config: LIVE_CONFIG, rows: [approved("a@acme.com")] });
    t.ctx.sendApproved!();
    t.pipeline.set(2, COLS.status, "Approved"); // someone flips it back by hand
    t.ctx.sendApproved!();
    expect(t.sent).toHaveLength(1);
  });

  it("skips a row left mid-send (SENDING) by a crashed run", () => {
    const t = setup({ config: LIVE_CONFIG, rows: [approved("a@acme.com", { sendState: "SENDING" })] });
    t.ctx.sendApproved!();
    expect(t.sent).toHaveLength(0);
  });

  it("adds the signature with postal address and the opt-out line", () => {
    const t = setup({ config: LIVE_CONFIG, rows: [approved("a@acme.com")] });
    t.ctx.sendApproved!();
    const body = t.sent[0]!.body;
    expect(body).toContain("Vikram Sethi");
    expect(body).toContain("1 Main St");
    expect(body).toContain("Dayton, OH 45402");
    expect(body).toMatch(/unsubscribe/);
  });

  it("stops at the daily cap, counting what was already sent today", () => {
    const t = setup({
      config: { ...LIVE_CONFIG, DailySendCap: "2" },
      rows: [
        { ...approved("old@acme.com"), status: "Sent", sentAt: new Date(NOW - 3600_000), messageId: "m0", sendState: "SENT" },
        approved("a@acme.com"), approved("b@acme.com"),
      ],
    });
    t.ctx.sendApproved!();
    expect(t.sent.map((s) => s.to)).toEqual(["a@acme.com"]);
    expect(t.cell(4, "status")).toBe("Approved");
  });

  it("a daily cap of 0 pauses sending; an empty cap means 20", () => {
    const t = setup({ config: { ...LIVE_CONFIG, DailySendCap: "0" }, rows: [approved("a@acme.com")] });
    t.ctx.sendApproved!();
    expect(t.sent).toHaveLength(0);
    expect(t.cell(2, "status")).toBe("Approved");
    expect(t.ctx.parseCap_!("")).toBe(20);
    expect(t.ctx.parseCap_!("abc")).toBe(20);
    expect(t.ctx.parseCap_!("5")).toBe(5);
  });

  it("writes to the row that holds the email even after a row above it was deleted mid-run", () => {
    const t = setup({ config: LIVE_CONFIG, rows: [approved("gone@acme.com"), approved("a@acme.com"), approved("b@acme.com")] });
    // Someone deletes row 2 (gone@acme.com) while the run is between reading and writing.
    t.pipeline.cells.splice(2, 1);
    t.ctx.sendApproved!();
    expect(t.sent.map((s) => s.to)).toEqual(["a@acme.com", "b@acme.com"]);
    expect(t.cell(2, "email")).toBe("a@acme.com"); expect(t.cell(2, "status")).toBe("Sent");
    expect(t.cell(3, "email")).toBe("b@acme.com"); expect(t.cell(3, "status")).toBe("Sent");
    expect(t.cell(4, "status")).toBe("");
  });

  it("dry run sends nothing and leaves a note", () => {
    const t = setup({ rows: [approved("a@acme.com")] }); // DryRun defaults to TRUE
    t.ctx.sendApproved!();
    expect(t.sent).toHaveLength(0);
    expect(String(t.cell(2, "notes"))).toContain("[DRY RUN]");
    expect(t.cell(2, "status")).toBe("Approved");
  });

  it("refuses to go live without a full signature", () => {
    const t = setup({ config: { DryRun: "FALSE", SenderName: "Vikram" }, rows: [approved("a@acme.com")] });
    expect(() => t.ctx.sendApproved!()).toThrow(/Street|CityStateZip/);
    expect(t.sent).toHaveLength(0);
  });

  it("marks a failed send and does not retry it automatically", () => {
    const t = setup({ config: LIVE_CONFIG, rows: [approved("a@acme.com")], sendThrows: true });
    t.ctx.sendApproved!();
    expect(t.cell(2, "sendState")).toBe("SEND_FAILED");
    expect(t.cell(2, "status")).toBe("Approved");
  });

  it("does nothing when another run holds the lock", () => {
    const t = setup({ config: LIVE_CONFIG, rows: [approved("a@acme.com")], lockFree: false });
    t.ctx.sendApproved!();
    expect(t.sent).toHaveLength(0);
  });
});

// =====================================================================================
describe("processReplies", () => {
  const ours = { from: "Vikram Sethi <v@onesmarter.com>", date: new Date(NOW - 86_400_000), body: "Hi Jane, ..." };
  const fromLead = (body: string, minutesAgo = 30) => ({ from: "Jane Miller <jane@acme.com>", date: new Date(NOW - minutesAgo * 60_000), body });
  const sentRow = (threadId: string, extra: Row = {}): Row => ({
    company: "Acme", name: "Jane Miller", email: "jane@acme.com", status: "Sent", threadId, messageId: "m1", sendState: "SENT", ...extra,
  });
  const run = (reply: string, opts: { config?: Record<string, string>; busy?: { s: Date; e: Date }[]; row?: Row } = {}) => {
    const thread = new FakeThread("t1", [ours, fromLead(reply)]);
    const t = setup({ config: opts.config ?? LIVE_CONFIG, rows: [sentRow("t1", opts.row)], threads: [thread], busy: opts.busy });
    t.ctx.processReplies!();
    return { ...t, thread };
  };

  it("books a proposed time: invite goes to the lead, confirmation is sent", () => {
    const t = run("Tuesday at 2pm works.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Vikram wrote:\n> reply with the word unsubscribe");
    expect(t.events).toHaveLength(1);
    const e = t.events[0]!;
    expect(e.start.toISOString()).toBe("2026-11-03T19:00:00.000Z");
    expect(e.end.getTime() - e.start.getTime()).toBe(15 * 60_000);
    expect(e.opts).toMatchObject({ guests: "jane@acme.com", sendInvites: true });
    expect(t.thread.replies[0]).toContain("Booked for Tuesday, Nov 3 at 2:00 PM Eastern");
    expect(t.cell(2, "status")).toBe("Meeting Booked");
    expect(t.cell(2, "sendState")).toBe("BOOKED");
  });

  it("an opt-out is recorded with the exact status the ledger sync looks for", () => {
    const t = run("Please remove me from your list.");
    expect(t.cell(2, "status")).toBe("Opted Out");
    expect(DO_NOT_CONTACT_STATUSES[String(t.cell(2, "status")).toLowerCase()]).toBe("OPTED_OUT");
    expect(t.thread.replies).toHaveLength(0);
    expect(t.events).toHaveLength(0);
  });

  it("\"not interested\" goes to a person and is not an opt-out", () => {
    const t = run("Thanks, but we are not interested at this time.");
    expect(t.cell(2, "status")).toBe("Replied");
    expect(t.cell(2, "sendState")).toBe("NEEDS_HUMAN");
    expect(String(t.cell(2, "notes"))).toContain("said not interested");
    expect(t.thread.replies).toHaveLength(0);
  });

  it("still treats unsubscribe as an opt-out", () => {
    expect(run("Please unsubscribe me.").cell(2, "status")).toBe("Opted Out");
  });

  it("marks the row Bounced when a delivery failure comes back in the thread, even in dry run", () => {
    const bounce = { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", date: new Date(NOW - 10 * 60_000), body: "Address not found. Your message wasn't delivered to jane@acme.com because the address couldn't be found." };
    for (const config of [LIVE_CONFIG, { ...LIVE_CONFIG, DryRun: "TRUE" }]) {
      const thread = new FakeThread("t1", [ours, bounce]);
      const t = setup({ config, rows: [sentRow("t1")], threads: [thread] });
      t.ctx.processReplies!();
      expect(t.cell(2, "status")).toBe("Bounced");
      expect(t.cell(2, "sendState")).toBe("BOUNCED");
      expect(DO_NOT_CONTACT_STATUSES[String(t.cell(2, "status")).toLowerCase()]).toBe("BOUNCED");
      expect(thread.replies).toHaveLength(0);
    }
  });

  it("a mailer-daemon message that is not a failure is not a bounce", () => {
    const notice = { from: "mailer-daemon@googlemail.com", date: new Date(NOW - 10 * 60_000), body: "Delay: we are still trying to deliver your message." };
    const thread = new FakeThread("t1", [ours, notice]);
    const t = setup({ config: LIVE_CONFIG, rows: [sentRow("t1")], threads: [thread] });
    t.ctx.processReplies!();
    expect(t.cell(2, "status")).toBe("Sent");
  });

  it("offers 3 free slots on different working days when asked for times", () => {
    const t = run("What times do you have this week?");
    expect(t.cell(2, "status")).toBe("Replied");
    expect(t.cell(2, "sendState")).toBe("TIMES_OFFERED");
    const reply = t.thread.replies[0]!;
    expect(reply).toContain("Eastern");
    const days = reply.match(/(Monday|Tuesday|Wednesday|Thursday|Friday), Nov \d+/g) ?? [];
    expect(new Set(days).size).toBe(3);
    expect(reply).not.toMatch(/Saturday|Sunday/);
  });

  it("offers other times when the proposed one is busy", () => {
    const t = run("Tuesday at 2pm?", { busy: [{ s: et(2026, 11, 3, 13, 30), e: et(2026, 11, 3, 14, 30) }] });
    expect(t.events).toHaveLength(0);
    expect(t.thread.replies[0]).toContain("I already have something at that time.");
    expect(t.cell(2, "sendState")).toBe("TIMES_OFFERED");
  });

  it("does not offer a slot that clashes with the calendar", () => {
    const busyAll10s = [3, 4, 5, 6].map((d) => ({ s: et(2026, 11, d, 10), e: et(2026, 11, d, 11) }));
    const t = run("What times work for you?", { busy: busyAll10s });
    expect(t.thread.replies[0]).not.toMatch(/at 10:00 AM/);
  });

  it("refuses a time outside working hours", () => {
    const t = run("Tuesday at 7pm works");
    expect(t.events).toHaveLength(0);
    expect(t.thread.replies[0]).toContain("outside my working hours");
  });

  it("refuses a weekend time", () => {
    const t = run("Saturday at 10am is good");
    expect(t.events).toHaveLength(0);
    expect(t.thread.replies[0]).toContain("not in the office that day");
  });

  it("hands anything unclear to a person without replying", () => {
    const t = run("Can you tell me more about pricing?");
    expect(t.cell(2, "status")).toBe("Replied");
    expect(t.cell(2, "sendState")).toBe("NEEDS_HUMAN");
    expect(t.thread.replies).toHaveLength(0);
  });

  it("does not handle the same reply twice", () => {
    const t = run("What times do you have?");
    t.ctx.processReplies!();
    expect(t.thread.replies).toHaveLength(1);
  });

  it("leaves NEEDS_HUMAN rows alone", () => {
    const t = run("What times do you have?", { row: { sendState: "NEEDS_HUMAN", status: "Replied" } });
    expect(t.thread.replies).toHaveLength(0);
  });

  it("ignores messages that are not from the lead", () => {
    const thread = new FakeThread("t1", [ours, { from: "someone@else.com", date: new Date(NOW - 60_000), body: "unsubscribe" }]);
    const t = setup({ config: LIVE_CONFIG, rows: [sentRow("t1")], threads: [thread] });
    t.ctx.processReplies!();
    expect(t.cell(2, "status")).toBe("Sent");
  });

  it("dry run classifies but does not reply, book, or change Status", () => {
    const t = run("Tuesday at 2pm works.", { config: {} });
    expect(t.events).toHaveLength(0);
    expect(t.thread.replies).toHaveLength(0);
    expect(t.cell(2, "status")).toBe("Sent");
    expect(String(t.cell(2, "notes"))).toContain("[DRY RUN] reply classified TIME_PROPOSED");
  });
});

describe("compatibility with the exporter", () => {
  it("uses Status values from the exporter's dropdown", () => {
    const { ctx } = setup();
    const statuses = vm.runInContext("STATUS", ctx as vm.Context) as Record<string, string>;
    expect(Object.values(statuses).sort()).toEqual(
      ["Approved", "Bounced", "Meeting Booked", "Needs Rewrite", "Opted Out", "Ready for Review", "Rejected", "Replied", "Sent"],
    );
  });

  it("reads columns A–J in the exporter's order", () => {
    const { ctx } = setup();
    const col = vm.runInContext("COL", ctx as vm.Context) as Record<string, number>;
    const order = ["company", "domain", "name", "title", "email", "research", "status", "subject", "body", "threadId"];
    order.forEach((k, i) => expect(col[k]).toBe(i + 1));
    expect(PIPELINE_HEADERS).toHaveLength(10);
  });
});

// =====================================================================================
describe("Jobs_Pipeline (search_jobs outreach)", () => {
  const approved = (email: string, company = "Acme"): Row => ({
    company, name: "Jane Miller", email, status: "Approved", subject: "Your RPG Developer opening", body: "Hi Jane,\n\nSaw you are hiring.",
  });

  it("sends Approved rows from both Pipeline and Jobs_Pipeline, and records each in its own tab", () => {
    const { ctx, sent, cell, jobCell } = setup({ config: LIVE_CONFIG, rows: [approved("a@acme.com")], jobRows: [approved("b@beta.com", "Beta")] });
    ctx.sendApproved!();
    expect(sent.map((m) => m.to)).toEqual(["a@acme.com", "b@beta.com"]);
    expect(cell(2, "status")).toBe("Sent");
    expect(jobCell(2, "status")).toBe("Sent");
    expect(jobCell(2, "threadId")).toBe("thread-2");
    expect(jobCell(2, "sendState")).toBe("SENT");
  });

  it("gives a Jobs_Pipeline made after setup() its K-O headers", () => {
    const { ctx, jobs } = setup({ config: LIVE_CONFIG, jobRows: [] });
    ctx.sendApproved!();
    expect([11, 12, 13, 14, 15].map((c) => jobs.get(1, c))).toEqual(["MessageID", "SentAt", "LastReplyAt", "SendState", "Notes"]);
  });

  it("one daily cap covers both tabs", () => {
    const { ctx, sent, jobCell } = setup({
      config: { ...LIVE_CONFIG, DailySendCap: "2" },
      rows: [approved("a@acme.com"), approved("b@acme.com")],
      jobRows: [approved("c@beta.com", "Beta")],
    });
    ctx.sendApproved!();
    expect(sent).toHaveLength(2);
    expect(jobCell(2, "status")).toBe("Approved"); // waits for tomorrow
  });

  it("does not send Ready for Review job rows: a human must approve", () => {
    const { ctx, sent } = setup({ config: LIVE_CONFIG, jobRows: [{ ...approved("b@beta.com"), status: "Ready for Review" }] });
    ctx.sendApproved!();
    expect(sent).toHaveLength(0);
  });

  it("works when there is no Jobs_Pipeline tab yet", () => {
    const { ctx, sent, sheets } = setup({ config: LIVE_CONFIG, rows: [approved("a@acme.com")] });
    expect(sheets.has("Jobs_Pipeline")).toBe(false);
    ctx.sendApproved!();
    expect(sent).toHaveLength(1);
  });

  it("reads replies in Jobs_Pipeline: an opt-out is recorded there", () => {
    const t = new FakeThread("jt-1", [
      { from: "Vikram <v@onesmarter.com>", date: new Date(NOW - 86_400_000), body: "Saw you are hiring." },
      { from: "Bea <b@beta.com>", date: new Date(NOW - 3_600_000), body: "Please remove me from your list." },
    ]);
    const { ctx, jobCell } = setup({
      config: LIVE_CONFIG, threads: [t],
      jobRows: [{ company: "Beta", name: "Bea Lee", email: "b@beta.com", status: "Sent", threadId: "jt-1", messageId: "m1", sendState: "SENT" }],
    });
    ctx.processReplies!();
    expect(jobCell(2, "status")).toBe("Opted Out");
  });
});
