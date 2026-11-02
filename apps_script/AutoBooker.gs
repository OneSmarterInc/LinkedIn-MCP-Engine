/**
 * AutoBooker.gs — Phase 5 sender for the LinkedIn MCP Engine.
 *
 * Reads the "Pipeline" tab the TypeScript exporter writes (columns A–J),
 * sends Approved drafts, reads replies, offers open times, books meetings,
 * and honors opt-outs. It owns columns K onward; the exporter never looks there.
 *
 * Status column (G) keeps the exporter's 8 values, because the exporter re-applies
 * a strict dropdown on every run. Finer state lives in SendState (column N).
 *
 * Setup: run setup() once, fill the Config tab, set DryRun to FALSE when ready.
 */

// ---------------------------------------------------------------------------
// Layout. A–J come from the exporter. K–O are ours.
// ---------------------------------------------------------------------------

var TAB = { pipeline: "Pipeline", config: "Config", log: "SendLog" };

var COL = {
  company: 1, domain: 2, name: 3, title: 4, email: 5, research: 6,
  status: 7, subject: 8, body: 9, threadId: 10,
  messageId: 11, sentAt: 12, lastReplyAt: 13, sendState: 14, notes: 15,
};
var OUR_HEADERS = ["MessageID", "SentAt", "LastReplyAt", "SendState", "Notes"];
var LAST_COL = COL.notes;

var STATUS = {
  ready: "Ready for Review", needsRewrite: "Needs Rewrite", approved: "Approved",
  rejected: "Rejected", sent: "Sent", replied: "Replied",
  meetingBooked: "Meeting Booked", optedOut: "Opted Out",
};

var STATE = {
  sending: "SENDING", sent: "SENT", timesOffered: "TIMES_OFFERED",
  needsHuman: "NEEDS_HUMAN", booked: "BOOKED", optedOut: "OPTED_OUT", sendFailed: "SEND_FAILED",
};

var CONFIG_KEYS = [
  ["DryRun", "TRUE", "TRUE logs every action instead of doing it. Set FALSE to go live."],
  ["TimeZone", "America/New_York", "Zone for working hours and offered times. Must match appsscript.json."],
  ["DailySendCap", "20", "Max first-touch emails per calendar day."],
  ["MeetingMinutes", "15", "Length of the booked call."],
  ["WorkStartHour", "9", "First slot offered (24h, in TimeZone)."],
  ["WorkEndHour", "17", "Last slot must end by this hour."],
  ["SenderName", "", "Signature line 1."],
  ["SenderTitle", "", "Signature line 2."],
  ["SenderCompany", "One Smarter", "Signature line 2."],
  ["Street", "", "Postal address line (required by CAN-SPAM)."],
  ["CityStateZip", "Dayton, OH 45402", "Postal address line (required by CAN-SPAM)."],
  ["Phone", "", "Optional."],
  ["OptOutLine", "If you would rather not hear from me again, reply with the word unsubscribe and I will remove you.", "Required by CAN-SPAM. Keep the word unsubscribe in it."],
  ["MeetingTitle", "Intro call: {company} and {sender_company}", "Calendar event title. {company}, {name}, {sender_company} are filled in."],
];

var US_STATE_TZ = {
  OH: "America/New_York", IN: "America/Indiana/Indianapolis", MI: "America/Detroit", KY: "America/New_York",
  PA: "America/New_York", NY: "America/New_York", IL: "America/Chicago", WI: "America/Chicago",
  MN: "America/Chicago", MO: "America/Chicago", TX: "America/Chicago", TN: "America/Chicago",
  GA: "America/New_York", FL: "America/New_York", NC: "America/New_York", VA: "America/New_York",
  CO: "America/Denver", AZ: "America/Phoenix", CA: "America/Los_Angeles", WA: "America/Los_Angeles",
  OR: "America/Los_Angeles", NV: "America/Los_Angeles", UT: "America/Denver",
};

// ---------------------------------------------------------------------------
// Entry points. Run setup() once, then let the triggers work.
// ---------------------------------------------------------------------------

function setup() {
  ensureConfigTab();
  ensureOurColumns();
  ensureLogTab();
  installTriggers();
  log_("setup", "", "Config, columns, log tab, and triggers are in place. Fill the Config tab, then set DryRun to FALSE.");
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === "sendApproved" || fn === "processReplies") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sendApproved").timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger("processReplies").timeBased().everyMinutes(10).create();
}

/** Sends every row whose Status is Approved and that has never been sent. One run at a time. */
function sendApproved() {
  withLock_(function () {
    var cfg = readConfig_();
    var sheet = pipeline_();
    var rows = readRows_(sheet);
    var sentToday = countSentToday_(rows, cfg.TimeZone);
    var cap = Number(cfg.DailySendCap) || 20;
    var sentNow = 0;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.status !== STATUS.approved) continue;
      if (r.sendState || r.messageId) continue; // already sent or mid-send; never twice
      if (!r.email) continue;

      if (sentToday + sentNow >= cap) {
        log_("cap", r.email, "Daily cap of " + cap + " reached. Row " + r.rowNo + " waits for tomorrow.");
        break;
      }

      var body = r.body.trim() + "\n\n" + signature_(cfg);

      if (cfg.dryRun) {
        setCell_(sheet, r.rowNo, COL.notes, stamp_("[DRY RUN] would send: " + r.subject));
        log_("dry-send", r.email, r.subject);
        sentNow++;
        continue;
      }

      // Mark first, send second. If the script dies between the two, the row is never resent.
      setCell_(sheet, r.rowNo, COL.sendState, STATE.sending);
      SpreadsheetApp.flush();

      try {
        var draft = GmailApp.createDraft(r.email, r.subject, body, mailOpts_(cfg));
        var msg = draft.send();
        var now = new Date();
        setCells_(sheet, r.rowNo, {
          status: STATUS.sent,
          threadId: msg.getThread().getId(),
          messageId: msg.getId(),
          sentAt: now,
          sendState: STATE.sent,
        });
        log_("sent", r.email, r.subject);
        sentNow++;
      } catch (e) {
        setCells_(sheet, r.rowNo, { sendState: STATE.sendFailed, notes: stamp_("send failed: " + e.message) });
        log_("send-failed", r.email, String(e.message));
      }
      SpreadsheetApp.flush();
    }
  });
}

/** Looks at every thread we started, classifies the newest reply from the lead, and acts on it. */
function processReplies() {
  withLock_(function () {
    var cfg = readConfig_();
    var sheet = pipeline_();
    var rows = readRows_(sheet);

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.threadId) continue;
      if (r.status !== STATUS.sent && r.status !== STATUS.replied) continue;
      if (r.sendState === STATE.needsHuman) continue; // a person owns this row now

      var thread;
      try { thread = GmailApp.getThreadById(r.threadId); } catch (e) { continue; }
      if (!thread) continue;

      var reply = newestReplyFromLead_(thread, r.email, r.lastReplyAt);
      if (!reply) continue;

      var fresh = stripQuotedText_(reply.getPlainBody());
      var verdict = classifyReply_(fresh, r, cfg);
      var replyAt = reply.getDate();

      log_("reply", r.email, verdict.kind + " | " + fresh.slice(0, 120).replace(/\s+/g, " "));

      if (cfg.dryRun) {
        setCells_(sheet, r.rowNo, {
          lastReplyAt: replyAt,
          notes: stamp_("[DRY RUN] reply classified " + verdict.kind + (verdict.when ? " for " + verdict.when.toISOString() : "")),
        });
        continue;
      }

      switch (verdict.kind) {
        case "OPT_OUT":
          setCells_(sheet, r.rowNo, { status: STATUS.optedOut, lastReplyAt: replyAt, sendState: STATE.optedOut, notes: stamp_("opted out") });
          break;

        case "TIMES_REQUESTED":
          offerTimes_(thread, r, cfg, "Happy to. ");
          setCells_(sheet, r.rowNo, { status: STATUS.replied, lastReplyAt: replyAt, sendState: STATE.timesOffered, notes: stamp_("offered 3 times") });
          break;

        case "TIME_PROPOSED":
          var outcome = tryBook_(thread, r, cfg, verdict.when);
          if (outcome.booked) {
            setCells_(sheet, r.rowNo, { status: STATUS.meetingBooked, lastReplyAt: replyAt, sendState: STATE.booked, notes: stamp_("booked " + outcome.label) });
          } else {
            offerTimes_(thread, r, cfg, outcome.reason + " ");
            setCells_(sheet, r.rowNo, { status: STATUS.replied, lastReplyAt: replyAt, sendState: STATE.timesOffered, notes: stamp_(outcome.reason) });
          }
          break;

        default: // NEEDS_HUMAN
          setCells_(sheet, r.rowNo, { status: STATUS.replied, lastReplyAt: replyAt, sendState: STATE.needsHuman, notes: stamp_("reply needs a person: " + fresh.slice(0, 200)) });
      }
      SpreadsheetApp.flush();
    }
  });
}

// ---------------------------------------------------------------------------
// Reply reading
// ---------------------------------------------------------------------------

/** The newest message in the thread sent by the lead after the last one we handled. */
function newestReplyFromLead_(thread, leadEmail, lastHandled) {
  var msgs = thread.getMessages();
  var want = leadEmail.toLowerCase();
  var floor = lastHandled instanceof Date ? lastHandled.getTime() : 0;
  var best = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (m.getFrom().toLowerCase().indexOf(want) === -1) continue;
    if (m.getDate().getTime() <= floor) break;
    best = m; break;
  }
  return best;
}

/**
 * Keeps only what the person typed. Cuts at the first sign of quoted or forwarded text.
 * This is the fix for "every reply is an opt-out": our own signature contains the word
 * unsubscribe, and it comes back quoted under every reply.
 */
function stripQuotedText_(text) {
  var lines = String(text || "").replace(/\r/g, "").split("\n");
  var kept = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var t = l.trim();
    if (/^>/.test(t)) break;                                   // Gmail quote
    if (/^On .{5,120}wrote:\s*$/.test(t)) break;                // Gmail header
    if (/^-{3,}\s*Original Message\s*-{3,}$/i.test(t)) break;  // Outlook
    if (/^_{10,}$/.test(t)) break;                              // Outlook divider
    if (/^From:\s.+/.test(t) && i + 1 < lines.length && /^(Sent|Date|To):/.test(lines[i + 1].trim())) break;
    if (/^-{2}\s*$/.test(t)) break;                             // signature delimiter "-- "
    if (/^(Sent from my|Get Outlook for)/i.test(t)) break;
    kept.push(l);
  }
  return kept.join("\n").trim();
}

var OPT_OUT_RE = /\b(unsubscribe|opt[\s-]?out|remove me|take me off|stop (emailing|contacting|messaging|sending)|do not (email|contact) me( again)?|don'?t (email|contact) me( again)?|not interested|no thank(s| you))\b/i;
var TIMES_RE = /\b(what times?|which times?|when (are|would|will) you|when works|your availability|times? (that )?works?|send (me )?(some|a few|your) (times|slots|options)|open slots?|available (times|slots)|availability)\b/i;

/** Order matters. Default is NEEDS_HUMAN, never OPT_OUT: a wrong opt-out is permanent. */
function classifyReply_(fresh, row, cfg) {
  if (!fresh) return { kind: "NEEDS_HUMAN" };
  if (OPT_OUT_RE.test(fresh)) return { kind: "OPT_OUT" };
  var when = parseProposedTime_(fresh, new Date(), leadZone_(row, cfg));
  if (when) return { kind: "TIME_PROPOSED", when: when };
  if (TIMES_RE.test(fresh)) return { kind: "TIMES_REQUESTED" };
  return { kind: "NEEDS_HUMAN" };
}

// ---------------------------------------------------------------------------
// Time parsing. Returns a Date only when BOTH a day and a clock time are present.
// ---------------------------------------------------------------------------

var DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
var DAY_ALIASES = [[], [], ["tues\\b"], ["weds\\b"], ["thurs\\b", "thur\\b"], [], []];
var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseProposedTime_(text, now, tz) {
  var s = text.toLowerCase().replace(/\s+/g, " ");
  var day = findDay_(s, now, tz);
  var clock = findClock_(s);
  if (!day || !clock) return null;
  var d = dateInZone_(day.y, day.m, day.d, clock.h, clock.mi, tz);
  if (d.getTime() <= now.getTime()) return null; // a past time is not a proposal
  if (d.getTime() - now.getTime() > 60 * 86400000) return null;
  return d;
}

function findDay_(s, now, tz) {
  var today = partsInZone_(now, tz);
  if (/\btomorrow\b/.test(s)) return addDays_(today, 1);
  if (/\btoday\b/.test(s)) return today;

  // "nov 5", "november 5th", "5 nov"
  var m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(st|nd|rd|th)?\b/) ||
          s.match(/\b(\d{1,2})(st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (m) {
    var mon = MONTHS.indexOf(isNaN(m[1]) ? m[1] : m[3]) + 1;
    var dd = Number(isNaN(m[1]) ? m[2] : m[1]);
    var y = today.y;
    if (mon < today.m || (mon === today.m && dd < today.d)) y += 1;
    return { y: y, m: mon, d: dd };
  }

  // "11/5" or "11/05/2026"
  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    var yy = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : today.y;
    return { y: yy, m: Number(m[1]), d: Number(m[2]) };
  }

  // weekday name: the next one strictly after today ("next tuesday" and "tuesday" both mean the coming one).
  // Full name, a common short form, or 3 letters with a period ("Tue."), so "we sat down" is not Saturday.
  for (var i = 0; i < DAYS.length; i++) {
    var forms = [DAYS[i] + "\\b", DAYS[i].slice(0, 3) + "\\."].concat(DAY_ALIASES[i]);
    var re = new RegExp("\\b(" + forms.join("|") + ")");
    if (re.test(s)) {
      var todayDow = dateInZone_(today.y, today.m, today.d, 12, 0, tz).getDay();
      var ahead = (i - todayDow + 7) % 7;
      if (ahead === 0) ahead = 7;
      return addDays_(today, ahead);
    }
  }
  return null;
}

function findClock_(s) {
  if (/\bnoon\b/.test(s)) return { h: 12, mi: 0 };
  var m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  if (m) {
    var h = Number(m[1]) % 12;
    if (/^p/.test(m[3])) h += 12;
    return { h: h, mi: Number(m[2] || 0) };
  }
  m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/); // 14:30
  if (m) return { h: Number(m[1]), mi: Number(m[2]) };
  return null;
}

// ---------------------------------------------------------------------------
// Time zone helpers. Never build a Date from free text. Build it from parts in a named zone.
// ---------------------------------------------------------------------------

function partsInZone_(date, tz) {
  var f = Utilities.formatDate(date, tz, "yyyy-M-d-H-m").split("-").map(Number);
  return { y: f[0], m: f[1], d: f[2], h: f[3], mi: f[4] };
}

/** The instant that reads as y-m-d h:mi on a wall clock in tz. Same iteration the TS server uses. */
function dateInZone_(y, m, d, h, mi, tz) {
  var target = Date.UTC(y, m - 1, d, h, mi);
  var guess = target;
  for (var i = 0; i < 3; i++) {
    var p = partsInZone_(new Date(guess), tz);
    var shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    guess += target - shown;
  }
  return new Date(guess);
}

function addDays_(p, n) {
  var d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** The lead's zone from the state in their location, else the script zone. */
function leadZone_(row, cfg) {
  // Location is not exported to the Pipeline tab. A human can add "tz:America/Chicago" or "state:IL" to Notes.
  var n = String(row.notes || "").match(/\btz:([A-Za-z_\/]+)/);
  if (n) return n[1];
  var st = String(row.notes || "").match(/\bstate:([A-Z]{2})\b/);
  if (st && US_STATE_TZ[st[1]]) return US_STATE_TZ[st[1]];
  return cfg.TimeZone;
}

function zoneLabel_(tz) {
  if (/New_York|Detroit|Indiana|Kentucky/.test(tz)) return "Eastern";
  if (/Chicago/.test(tz)) return "Central";
  if (/Denver|Phoenix/.test(tz)) return "Mountain";
  if (/Los_Angeles/.test(tz)) return "Pacific";
  return tz;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function tryBook_(thread, row, cfg, when) {
  var mins = Number(cfg.MeetingMinutes) || 15;
  var end = new Date(when.getTime() + mins * 60000);
  var tz = leadZone_(row, cfg);
  var local = partsInZone_(when, tz);
  var startH = Number(cfg.WorkStartHour) || 9, endH = Number(cfg.WorkEndHour) || 17;

  if (local.h < startH || local.h >= endH) return { booked: false, reason: "That time is outside my working hours." };
  var dow = dateInZone_(local.y, local.m, local.d, 12, 0, tz).getDay();
  if (dow === 0 || dow === 6) return { booked: false, reason: "I am not in the office that day." };

  var cal = CalendarApp.getDefaultCalendar();
  if (cal.getEvents(when, end).length > 0) return { booked: false, reason: "I already have something at that time." };

  var title = (cfg.MeetingTitle || "Intro call: {company} and {sender_company}")
    .replace("{company}", row.company).replace("{name}", row.name).replace("{sender_company}", cfg.SenderCompany || "");

  // sendInvites: true is what makes the invite reach the guest. Without it the event sits on our calendar only.
  cal.createEvent(title, when, end, {
    guests: row.email,
    sendInvites: true,
    description: "Booked from an email reply. Thread: " + thread.getId(),
  });

  var label = Utilities.formatDate(when, tz, "EEEE, MMM d 'at' h:mm a") + " " + zoneLabel_(tz);
  thread.reply(
    "Hi " + firstName_(row.name) + ",\n\nBooked for " + label + ". A calendar invite is on its way. Talk then.\n\n" + signature_(cfg),
    mailOpts_(cfg)
  );
  return { booked: true, label: label };
}

/** Three open slots on three different working days, next 7 days, in the lead's zone. */
function freeSlots_(cfg, tz, count) {
  var mins = Number(cfg.MeetingMinutes) || 15;
  var startH = Number(cfg.WorkStartHour) || 9, endH = Number(cfg.WorkEndHour) || 17;
  var now = new Date();
  var horizon = new Date(now.getTime() + 8 * 86400000);
  var busy = CalendarApp.getDefaultCalendar().getEvents(now, horizon).map(function (e) {
    return { s: e.getStartTime().getTime(), e: e.getEndTime().getTime() };
  });
  var today = partsInZone_(now, tz);
  var out = [];

  for (var dOff = 0; dOff <= 7 && out.length < count; dOff++) {
    var p = addDays_(today, dOff);
    var dow = dateInZone_(p.y, p.m, p.d, 12, 0, tz).getDay();
    if (dow === 0 || dow === 6) continue;
    // Vary the hour across days so the offer does not read as three 9 AMs.
    var preferred = [10, 14, 11, 15, 9, 13, 16].filter(function (h) { return h >= startH && h + mins / 60 <= endH; });
    for (var k = 0; k < preferred.length; k++) {
      var start = dateInZone_(p.y, p.m, p.d, preferred[(k + out.length) % preferred.length], 0, tz);
      var end = new Date(start.getTime() + mins * 60000);
      if (start.getTime() <= now.getTime() + 2 * 3600000) continue; // at least 2 hours out
      var clash = busy.some(function (b) { return start.getTime() < b.e && end.getTime() > b.s; });
      if (!clash) { out.push(start); break; } // one slot per day
    }
  }
  return out;
}

function offerTimes_(thread, row, cfg, lead) {
  var tz = leadZone_(row, cfg);
  var slots = freeSlots_(cfg, tz, 3);
  var text;
  if (slots.length === 0) {
    text = lead + "My calendar is full this week. Could you send two or three times that suit you next week?";
  } else {
    var parts = slots.map(function (s) { return Utilities.formatDate(s, tz, "EEEE, MMM d 'at' h:mm a"); });
    var list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " or " + parts[parts.length - 1];
    text = lead + "I have " + list + " " + zoneLabel_(tz) + ". Does one of those work? Reply with the one you want and I will send the invite.";
  }
  thread.reply("Hi " + firstName_(row.name) + ",\n\n" + text + "\n\n" + signature_(cfg), mailOpts_(cfg));
}

// ---------------------------------------------------------------------------
// Signature. Postal address and an opt-out line are required by CAN-SPAM.
// ---------------------------------------------------------------------------

function signature_(cfg) {
  var lines = ["Best,", cfg.SenderName];
  var role = [cfg.SenderTitle, cfg.SenderCompany].filter(Boolean).join(", ");
  if (role) lines.push(role);
  if (cfg.Street) lines.push(cfg.Street);
  if (cfg.CityStateZip) lines.push(cfg.CityStateZip);
  if (cfg.Phone) lines.push(cfg.Phone);
  lines.push("", cfg.OptOutLine);
  return lines.filter(function (l) { return l !== undefined && l !== null; }).join("\n");
}

// ---------------------------------------------------------------------------
// Sheet plumbing
// ---------------------------------------------------------------------------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function pipeline_() {
  var s = ss_().getSheetByName(TAB.pipeline);
  if (!s) throw new Error('No "' + TAB.pipeline + '" tab. Run the exporter first.');
  return s;
}

function ensureOurColumns() {
  var s = pipeline_();
  if (s.getMaxColumns() < LAST_COL) s.insertColumnsAfter(s.getMaxColumns(), LAST_COL - s.getMaxColumns());
  var range = s.getRange(1, COL.messageId, 1, OUR_HEADERS.length);
  var cur = range.getValues()[0].map(String);
  if (cur.every(function (c) { return c.trim() === ""; })) {
    range.setValues([OUR_HEADERS]).setFontWeight("bold").setBackground("#e6e6e6");
    s.setColumnWidth(COL.notes, 360);
  } else if (OUR_HEADERS.some(function (h, i) { return cur[i] !== h; })) {
    throw new Error("Columns K–O already hold other headers (" + cur.join(", ") + "). Expected " + OUR_HEADERS.join(", ") + ".");
  }
  s.getRange(2, COL.sentAt, Math.max(1, s.getMaxRows() - 1), 2).setNumberFormat("yyyy-mm-dd hh:mm");
}

function readRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var v = sheet.getRange(2, 1, last - 1, LAST_COL).getValues();
  return v.map(function (r, i) {
    return {
      rowNo: i + 2,
      company: String(r[COL.company - 1] || ""), domain: String(r[COL.domain - 1] || ""),
      name: String(r[COL.name - 1] || ""), title: String(r[COL.title - 1] || ""),
      email: String(r[COL.email - 1] || "").trim().toLowerCase(), research: String(r[COL.research - 1] || ""),
      status: String(r[COL.status - 1] || "").trim(), subject: String(r[COL.subject - 1] || ""),
      body: String(r[COL.body - 1] || ""), threadId: String(r[COL.threadId - 1] || "").trim(),
      messageId: String(r[COL.messageId - 1] || "").trim(), sentAt: r[COL.sentAt - 1],
      lastReplyAt: r[COL.lastReplyAt - 1], sendState: String(r[COL.sendState - 1] || "").trim(),
      notes: String(r[COL.notes - 1] || ""),
    };
  });
}

function setCell_(sheet, rowNo, col, value) { sheet.getRange(rowNo, col).setValue(value); }
function setCells_(sheet, rowNo, patch) {
  Object.keys(patch).forEach(function (k) {
    if (!COL[k]) throw new Error("Unknown column " + k);
    sheet.getRange(rowNo, COL[k]).setValue(patch[k]);
  });
}

function countSentToday_(rows, tz) {
  var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  return rows.filter(function (r) {
    return r.sentAt instanceof Date && Utilities.formatDate(r.sentAt, tz, "yyyy-MM-dd") === today;
  }).length;
}

function mailOpts_(cfg) { return cfg.SenderName ? { name: cfg.SenderName } : {}; }
function firstName_(full) { return String(full || "").trim().split(/\s+/)[0] || "there"; }
function stamp_(msg) { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm") + " " + msg; }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { log_("lock", "", "Another run is still going. Skipped."); return; }
  try { fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// Config tab and log tab
// ---------------------------------------------------------------------------

function ensureConfigTab() {
  var s = ss_().getSheetByName(TAB.config);
  if (!s) {
    s = ss_().insertSheet(TAB.config);
    s.getRange(1, 1, 1, 3).setValues([["Key", "Value", "What it does"]]).setFontWeight("bold");
    s.getRange(2, 1, CONFIG_KEYS.length, 3).setValues(CONFIG_KEYS);
    s.setColumnWidths(1, 1, 140); s.setColumnWidths(2, 1, 320); s.setColumnWidths(3, 1, 460);
    s.setFrozenRows(1);
  }
}

function readConfig_() {
  ensureConfigTab();
  var v = ss_().getSheetByName(TAB.config).getDataRange().getValues();
  var cfg = {};
  CONFIG_KEYS.forEach(function (k) { cfg[k[0]] = k[1]; });
  for (var i = 1; i < v.length; i++) if (v[i][0]) cfg[String(v[i][0]).trim()] = String(v[i][1] == null ? "" : v[i][1]).trim();
  cfg.dryRun = String(cfg.DryRun).toUpperCase() !== "FALSE";
  var missing = ["SenderName", "Street", "CityStateZip", "OptOutLine"].filter(function (k) { return !cfg[k]; });
  if (!cfg.dryRun && missing.length) throw new Error("Config is missing " + missing.join(", ") + ". Live sending needs a full signature.");
  return cfg;
}

function ensureLogTab() {
  var s = ss_().getSheetByName(TAB.log);
  if (!s) {
    s = ss_().insertSheet(TAB.log);
    s.getRange(1, 1, 1, 4).setValues([["When", "Event", "Email", "Detail"]]).setFontWeight("bold");
    s.setFrozenRows(1);
    s.setColumnWidths(4, 1, 520);
  }
}

function log_(event, email, detail) {
  try {
    ensureLogTab();
    ss_().getSheetByName(TAB.log).appendRow([new Date(), event, email, detail]);
  } catch (e) { /* logging must never stop the run */ }
  console.log(event + " " + email + " " + detail);
}

// ---------------------------------------------------------------------------
// Tests. Run these from the editor before setting DryRun to FALSE. Read the log.
// ---------------------------------------------------------------------------

function runTests() {
  var fails = 0;
  function check(name, got, want) {
    var ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fails++;
    console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
  }

  // The original bug: our signature quoted under a friendly reply must NOT read as opt-out.
  var quoted = "Sure, Tuesday at 2pm works.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Vikram <v@onesmarter.com> wrote:\n> ...reply with the word unsubscribe and I will remove you.";
  check("strip quoted gmail", stripQuotedText_(quoted), "Sure, Tuesday at 2pm works.");
  check("strip quoted outlook", stripQuotedText_("No thanks.\n________________________________\nFrom: Vikram\nSent: Monday"), "No thanks.");

  var cfg = { TimeZone: "America/New_York" };
  var row = { notes: "" };
  var monday = dateInZone_(2026, 11, 2, 9, 0, "America/New_York"); // a Monday

  check("opt-out plain", classifyReply_("Please remove me from your list.", row, cfg).kind, "OPT_OUT");
  check("not opt-out when quoted", classifyReply_(stripQuotedText_(quoted), row, cfg).kind, "TIME_PROPOSED");
  check("times requested", classifyReply_("What times do you have open this week?", row, cfg).kind, "TIMES_REQUESTED");
  check("default needs human", classifyReply_("Can you tell me more about pricing?", row, cfg).kind, "NEEDS_HUMAN");
  check("day without time -> human", classifyReply_("Thursday could work.", row, cfg).kind, "NEEDS_HUMAN");

  // Time zone: "Tuesday at 2pm" on Monday Nov 2 2026 is Tue Nov 3 14:00 Eastern = 19:00Z (EST, after DST ends Nov 1).
  var t = parseProposedTime_("tuesday at 2pm", monday, "America/New_York");
  check("tuesday 2pm eastern", t && t.toISOString(), "2026-11-03T19:00:00.000Z");
  var t2 = parseProposedTime_("Nov 5 at 10:30 am", monday, "America/Chicago");
  check("nov 5 10:30 central", t2 && t2.toISOString(), "2026-11-05T16:30:00.000Z");
  var t3 = parseProposedTime_("tomorrow at noon", monday, "America/New_York");
  check("tomorrow noon", t3 && t3.toISOString(), "2026-11-03T17:00:00.000Z");
  check("past time rejected", parseProposedTime_("today at 8am", monday, "America/New_York"), null);

  check("first name", firstName_("Jane Q. Public"), "Jane");
  console.log(fails === 0 ? "ALL TESTS PASSED" : fails + " TEST(S) FAILED");
}