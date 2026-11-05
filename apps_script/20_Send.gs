/** Sending. sendApproved(): Approved rows go out by Gmail under the daily cap; signature; cap parsing. Part of AutoBooker: files load in name order; shared constants live in 00_Config.gs. */

function sendApproved() {
  withLock_(function () {
    var cfg = readConfig_();
    addColumnsQuietly_();
    // Pipeline first, then Jobs_Pipeline. The daily cap covers both, since they share one Gmail account.
    var tabs = pipelines_().map(function (sheet) { return { sheet: sheet, rows: readRows_(sheet) }; });
    var sentToday = tabs.reduce(function (n, t) { return n + countSentToday_(t.rows, cfg.TimeZone); }, 0);
    var cap = parseCap_(cfg.DailySendCap);
    var sentNow = 0;
    var capHit = false;

    for (var ti = 0; ti < tabs.length && !capHit; ti++) {
    var sheet = tabs[ti].sheet;
    var rows = tabs[ti].rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.status !== STATUS.approved) continue;
      if (r.sendState || r.messageId) continue; // already sent or mid-send; never twice
      if (!r.email) continue;

      if (sentToday + sentNow >= cap) {
        log_("cap", r.email, "Daily cap of " + cap + " reached. " + sheet.getName() + " row " + r.rowNo + " waits for tomorrow.");
        capHit = true;
        break;
      }

      var body = r.body.trim() + "\n\n" + signature_(cfg);

      if (cfg.dryRun) {
        updateRow_(sheet, r, { notes: appendNote_(r.notes, "[DRY RUN] would send: " + r.subject) });
        log_("dry-send", r.email, r.subject);
        sentNow++;
        continue;
      }

      // Mark first, send second. If the script dies between the two, the row is never resent.
      if (!updateRow_(sheet, r, { sendState: STATE.sending })) continue; // row deleted by hand: do not send
      SpreadsheetApp.flush();

      try {
        var draft = GmailApp.createDraft(r.email, r.subject, body, mailOpts_(cfg));
        var msg = draft.send();
        var now = new Date();
        updateRow_(sheet, r, {
          status: STATUS.sent,
          threadId: msg.getThread().getId(),
          messageId: msg.getId(),
          sentAt: now,
          sendState: STATE.sent,
        });
        log_("sent", r.email, r.subject);
        sentNow++;
      } catch (e) {
        updateRow_(sheet, r, { sendState: STATE.sendFailed, notes: appendNote_(r.notes, "send failed: " + e.message) });
        log_("send-failed", r.email, String(e.message));
      }
      SpreadsheetApp.flush();
    }
    }
  });
}

/** Looks at every thread we started, classifies the newest reply from the lead, and acts on it. */

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


function parseCap_(raw) {
  var t = String(raw === undefined || raw === null ? "" : raw).trim();
  if (t === "") return 20;
  var n = Number(t);
  if (isNaN(n)) return 20;
  return Math.max(0, Math.floor(n));
}

function countSentToday_(rows, tz) {
  var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  return rows.filter(function (r) {
    return r.sentAt instanceof Date && Utilities.formatDate(r.sentAt, tz, "yyyy-MM-dd") === today;
  }).length;
}

function mailOpts_(cfg) { return cfg.SenderName ? { name: cfg.SenderName } : {}; }
function firstName_(full) { return String(full || "").trim().split(/\s+/)[0] || "there"; }
