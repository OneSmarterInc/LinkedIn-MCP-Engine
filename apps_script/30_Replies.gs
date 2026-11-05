/** Replies. processReplies(): bounces, opt-outs, time requests, proposals, needs-a-person; reply reading and classification. Part of AutoBooker: files load in name order; shared constants live in 00_Config.gs. */

function processReplies() {
  withLock_(function () {
    var cfg = readConfig_();
    addColumnsQuietly_();
    var sheets = pipelines_();

    for (var si = 0; si < sheets.length; si++) {
    var sheet = sheets[si];
    var rows = readRows_(sheet);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.threadId) continue;
      if (r.status !== STATUS.sent && r.status !== STATUS.replied) continue;
      if (r.sendState === STATE.needsHuman) continue; // a person owns this row now

      var thread;
      try { thread = GmailApp.getThreadById(r.threadId); } catch (e) { continue; }
      if (!thread) continue;

      // A delivery failure comes back in the same thread. Mark the row Bounced so the engine never writes to
      // this address again (it syncs Bounced rows into the ledger before every run). Sends nothing, so dry run too.
      var bounce = bounceIn_(thread, r.lastReplyAt);
      if (bounce) {
        updateRow_(sheet, r, { status: STATUS.bounced, lastReplyAt: bounce.getDate(), sendState: STATE.bounced, notes: appendNote_(r.notes, "bounced: the address does not accept mail") });
        log_("bounced", r.email, "delivery failure in the thread");
        SpreadsheetApp.flush();
        continue;
      }

      var reply = newestReplyFromLead_(thread, r.email, r.lastReplyAt);
      if (!reply) continue;

      var fresh = stripQuotedText_(reply.getPlainBody());
      // Mail systems mark machine-sent mail in its headers. That signal beats any word list, so it is checked first.
      var verdict = isAutomatedMessage_(reply) ? { kind: "NEEDS_HUMAN", note: "automatic reply" } : classifyReply_(fresh, r, cfg);
      var replyAt = reply.getDate();

      if (cfg.dryRun) {
        // Dry run: look, note, but do not count the reply as handled (lastReplyAt stays), so a real "unsubscribe"
        // or a proposed time received during dry run is still acted on once sending is live. The one exception is
        // an opt-out, which is applied now: it sends nothing and must never be missed.
        var dryText = "[DRY RUN] reply classified " + verdict.kind + (verdict.when ? " for " + verdict.when.toISOString() : "");
        if (verdict.kind === "OPT_OUT") {
          updateRow_(sheet, r, { status: STATUS.optedOut, lastReplyAt: replyAt, sendState: STATE.optedOut, notes: appendNote_(r.notes, "opted out (seen in dry run)") });
          log_("reply", r.email, "OPT_OUT | " + fresh.slice(0, 120).replace(/\s+/g, " "));
        } else if (String(r.notes || "").indexOf(dryText) === -1) {
          updateRow_(sheet, r, { notes: appendNote_(r.notes, dryText) });
          log_("reply", r.email, verdict.kind + " (dry run, not handled) | " + fresh.slice(0, 120).replace(/\s+/g, " "));
        }
        continue;
      }

      log_("reply", r.email, verdict.kind + " | " + fresh.slice(0, 120).replace(/\s+/g, " "));

      // One row's failure (Calendar quota, Gmail error) must not stop the others, and must leave the row with a
      // person, not half-done. BOOKED is written before the confirmation email so a Gmail failure after the
      // invite cannot make the next cycle "find" our own event and apologise for a clash.
      try {
        switch (verdict.kind) {
          case "OPT_OUT":
            updateRow_(sheet, r, { status: STATUS.optedOut, lastReplyAt: replyAt, sendState: STATE.optedOut, notes: appendNote_(r.notes, "opted out") });
            break;

          case "TIMES_REQUESTED":
            offerTimes_(thread, r, cfg, "Happy to. ");
            updateRow_(sheet, r, { status: STATUS.replied, lastReplyAt: replyAt, sendState: STATE.timesOffered, notes: appendNote_(r.notes, "offered 3 times") });
            break;

          case "TIME_PROPOSED":
            var outcome = tryBook_(thread, r, cfg, verdict.when, function (label) {
              updateRow_(sheet, r, { status: STATUS.meetingBooked, lastReplyAt: replyAt, sendState: STATE.booked, notes: appendNote_(r.notes, "booked " + label) });
              r.notes = appendNote_(r.notes, "booked " + label);
              SpreadsheetApp.flush();
            });
            if (outcome.booked) {
              if (outcome.confirmationFailed) {
                updateRow_(sheet, r, { notes: appendNote_(r.notes, "booked, but the confirmation email failed: " + outcome.confirmationFailed + ". The invite was sent; reply by hand if needed.") });
                log_("booked-no-confirmation", r.email, outcome.confirmationFailed);
              }
            } else {
              offerTimes_(thread, r, cfg, outcome.reason + " ");
              updateRow_(sheet, r, { status: STATUS.replied, lastReplyAt: replyAt, sendState: STATE.timesOffered, notes: appendNote_(r.notes, outcome.reason) });
            }
            break;

          default: // NEEDS_HUMAN
            updateRow_(sheet, r, { status: STATUS.replied, lastReplyAt: replyAt, sendState: STATE.needsHuman, notes: appendNote_(r.notes, needsHumanPrefix_(verdict.note) + fresh.slice(0, 200)) });
        }
      } catch (e) {
        updateRow_(sheet, r, { status: STATUS.replied, lastReplyAt: replyAt, sendState: STATE.needsHuman, notes: appendNote_(r.notes, "automation failed, needs a person: " + String(e.message || e)) });
        log_("reply-error", r.email, String(e.message || e));
      }
      SpreadsheetApp.flush();
    }
    }
  });
}

// ---------------------------------------------------------------------------
// Reply reading
// ---------------------------------------------------------------------------

/** The newest message in the thread sent by the lead after the last one we handled. */
var BOUNCE_FROM_RE = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;
var BOUNCE_BODY_RE = /(address not found|wasn'?t delivered|could not be delivered|delivery (has )?failed|undeliverable|does ?n[o']t exist|user unknown|no such user|mailbox (is )?(unavailable|not found)|recipient address rejected)/i;

/** The newest delivery-failure notice in the thread after the last message we handled, or null. */
function bounceIn_(thread, lastHandled) {
  var msgs = thread.getMessages();
  var floor = lastHandled instanceof Date ? lastHandled.getTime() : 0;
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (m.getDate().getTime() <= floor) break;
    if (BOUNCE_FROM_RE.test(m.getFrom()) && BOUNCE_BODY_RE.test(m.getPlainBody())) return m;
  }
  return null;
}

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

var OPT_OUT_RE = /\b(unsubscribe|opt[\s-]?out|remove me|take me off|stop (emailing|contacting|messaging|sending)|do not (email|contact) me( again)?|don'?t (email|contact) me( again)?)\b/i;
// "Not interested" is an answer to this email, not a request to never hear from us: a person decides.
var DECLINE_RE = /\b(not interested|no thank(s| you)|not (a )?(fit|priority)|not (looking|hiring) (right )?now|we('re| are) (all )?set|pass on this)\b/i;
var TIMES_RE = /\b(what times?|which times?|when (are|would|will) you|when works|your availability|times? (that )?works?|send (me )?(some|a few|your) (times|slots|options)|open slots?|available (times|slots)|availability)\b/i;

/** Order matters. Default is NEEDS_HUMAN, never OPT_OUT: a wrong opt-out is permanent. */
var AUTO_REPLY_RE = /\b(out of (the )?office|out[- ]of[- ]office|on (annual |parental |sick |medical )?leave|on vacation|on pto|away from (my |the )?(desk|office|email)|limited access to (my )?email|auto(matic|mated|-)?\s?(reply|response)|automatic reply|this is an automated|will (respond|reply|return) (when|on|after) i return|back in the office)\b/i;
var REFUSAL_RE = /\b(doesn'?t|does not|don'?t|do not|won'?t|will not|can'?t|cannot|can not|isn'?t|is not|not (going to )?work|no good|instead|rather|unless|except|busy|unavailable|conflict|reschedule|another (day|time)|different (day|time))\b/i;

/** The sentence that holds the clock time, so "Tuesday 2pm doesn't work, Thursday?" is judged on its own words. */
function sentenceWithTime_(text) {
  var parts = String(text).split(/(?<=[.!?\n])\s+|\n+/);
  for (var i = 0; i < parts.length; i++) {
    if (findClock_(parts[i].toLowerCase().replace(/\s+/g, " "))) return parts[i];
  }
  return text;
}

/** How many different weekdays the text names. Two or more means the person is offering a choice. */
function distinctDays_(text) {
  var t = String(text).toLowerCase();
  var n = 0;
  for (var i = 0; i < DAYS.length; i++) {
    var hit = new RegExp("\\b" + DAYS[i].slice(0, 3) + "(" + DAYS[i].slice(3) + ")?\\b").test(t);
    if (hit) n++;
  }
  return n;
}

/** Notes prefix for a reply that goes to a person, by why it went there. */
function needsHumanPrefix_(note) {
  if (note === "declined") return "said not interested (not opted out): ";
  if (note === "automatic reply") return "automatic reply (by its mail headers), not a decision: ";
  if (note === "asked a question") return "asked a question about the time, not a yes: ";
  return "reply needs a person: ";
}

/**
 * True when the message's headers say a machine sent it (vacation notice, ticket system, mailing list).
 * Headers are set by the sending mail system, so this catches auto-replies that use no English trigger words.
 * Tolerates a message object without getHeader (older runtimes, tests): then only the sender address is checked.
 */
function isAutomatedMessage_(msg) {
  var from = "";
  try { from = String(msg.getFrom() || ""); } catch (e) { /* ignore */ }
  if (/\b(no-?reply|do-?not-?reply|mailer-daemon|postmaster)\b/i.test(from)) return true;
  if (typeof msg.getHeader !== "function") return false;
  var h = function (name) { try { return String(msg.getHeader(name) || "").trim().toLowerCase(); } catch (e) { return ""; } };
  var auto = h("Auto-Submitted");
  if (auto && auto !== "no") return true;                          // auto-generated, auto-replied, auto-notified
  if (/^(auto[_-]?reply|bulk|junk|list)$/.test(h("Precedence"))) return true;
  if (h("X-Autoreply") || h("X-Autorespond") || h("X-Auto-Response-Suppress")) return true;
  return false;
}

/**
 * A question that holds a time is booked only when it is a plain offer ("Tuesday at 2pm?", "Does Tuesday 2pm work
 * for you?"): the booking confirmation is the answer to that question. Any other question about the time
 * ("Did you mean Tuesday 2pm?", "Is that Eastern?", "Is Tuesday 2pm the only option?") goes to a person.
 */
var OFFER_QUESTION_RE = /^\s*(?:(?:does|would|could|can|will|is|are|shall|maybe|perhaps|say)\b[^?]*\b(?:work|works|suit|suits|ok|okay|fine|good|possible|free|open|available|convenient|for you|with you|meet|talk|chat|call|connect|do|book|schedule)\b[^?]*|(?:how|what) about\b[^?]*|[^a-z?]*(?:next |this )?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z.]*,? )?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z.]* \d{1,2}(?:st|nd|rd|th)?,? |\d{1,2}\/\d{1,2},? |tomorrow,? )?(?:at )?\d[\d:apm. ]*(?:[a-z]{2,3}|eastern|central|mountain|pacific)?\s*)\?\s*$/i;

function isOfferQuestion_(sentence) {
  return OFFER_QUESTION_RE.test(String(sentence).trim().replace(/\s+/g, " "));
}

/** A time zone named in the reply ("2pm Pacific", "2 pm CT"), as an IANA zone; else null. */
function zoneInText_(text) {
  var t = String(text).toLowerCase().replace(/\s+/g, " ");
  // Full names anywhere; two/three-letter forms only right after a clock time ("2pm ct", "2:30 pm PST").
  var abbr = (t.match(/\d\s*(?:am|pm|a\.m\.|p\.m\.)?\s*\b([ecmp][sd]?t)\b/) || [])[1] || "";
  var k = /\beastern\b/.test(t) || abbr[0] === "e" ? "America/New_York"
        : /\bcentral\b/.test(t) || abbr[0] === "c" ? "America/Chicago"
        : /\bmountain\b/.test(t) || abbr[0] === "m" ? "America/Denver"
        : /\bpacific\b/.test(t) || abbr[0] === "p" ? "America/Los_Angeles" : null;
  return k;
}

function classifyReply_(fresh, row, cfg) {
  if (!fresh) return { kind: "NEEDS_HUMAN" };
  if (AUTO_REPLY_RE.test(fresh)) return { kind: "NEEDS_HUMAN" }; // an autoresponder is not a decision
  if (OPT_OUT_RE.test(fresh)) return { kind: "OPT_OUT" };
  if (DECLINE_RE.test(fresh)) return { kind: "NEEDS_HUMAN", note: "declined" };
  // A zone the person names wins over the zone we guessed for them.
  var when = parseProposedTime_(fresh, new Date(), zoneInText_(fresh) || leadZone_(row, cfg));
  if (when) {
    var sentence = sentenceWithTime_(fresh);
    if (REFUSAL_RE.test(sentence)) return { kind: "NEEDS_HUMAN" };   // "Tuesday 2pm doesn't work"
    if (distinctDays_(fresh) > 1) return { kind: "NEEDS_HUMAN" };     // "Tuesday 2pm or Thursday?" is a choice, not a time
    if (/\?\s*$/.test(sentence.trim()) && !isOfferQuestion_(sentence)) return { kind: "NEEDS_HUMAN", note: "asked a question" };
    return { kind: "TIME_PROPOSED", when: when };
  }
  if (TIMES_RE.test(fresh)) return { kind: "TIMES_REQUESTED" };
  return { kind: "NEEDS_HUMAN" };
}
