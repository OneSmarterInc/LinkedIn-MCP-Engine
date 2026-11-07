/** Sheet access. Pipeline tabs, reading rows, writing by email (never by stale row number), notes log, script lock. Part of AutoBooker: files load in name order; shared constants live in 00_Config.gs. */

// ---------------------------------------------------------------------------
// Sheet plumbing
// ---------------------------------------------------------------------------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function pipeline_() {
  var s = ss_().getSheetByName(TAB.pipeline);
  if (!s) throw new Error('No "' + TAB.pipeline + '" tab. Run the exporter first.');
  return s;
}

/** Every tab AutoBooker works on: Pipeline always, Jobs_Pipeline once search_jobs has created it. */
function pipelines_() {
  var list = [pipeline_()];
  var jobs = ss_().getSheetByName(TAB.jobsPipeline);
  if (jobs) list.push(jobs);
  return list;
}

/** Adds columns K–O to every pipeline tab. Also runs at the start of each send and reply run, for a new Jobs_Pipeline. */
function ensureOurColumns() {
  pipelines_().forEach(ensureColumnsOn_);
}

/** Gives a Jobs_Pipeline made after setup() its K–O headers. A problem is logged, never stops sending. */
function addColumnsQuietly_() {
  try { ensureOurColumns(); } catch (e) { log_("columns", "", String(e.message)); }
}

function ensureColumnsOn_(s) {
  if (s.getMaxColumns() < LAST_COL) s.insertColumnsAfter(s.getMaxColumns(), LAST_COL - s.getMaxColumns());
  var range = s.getRange(1, COL.messageId, 1, OUR_HEADERS.length);
  var cur = range.getValues()[0].map(String);
  if (cur.every(function (c) { return c.trim() === ""; })) {
    range.setValues([OUR_HEADERS]).setFontWeight("bold").setBackground("#e6e6e6");
    s.setColumnWidth(COL.notes, 360);
    s.setColumnWidth(COL.lastReply, 360);
  } else if (OUR_HEADERS.some(function (h, i) { return cur[i].trim() !== "" && cur[i] !== h; })) {
    throw new Error("Columns K–P already hold other headers (" + cur.join(", ") + "). Expected " + OUR_HEADERS.join(", ") + ".");
  } else if (cur.some(function (c) { return c.trim() === ""; })) {
    // A Sheet set up before a column was added (LastReply, 7 Nov 2026): add the missing headers, keep the rest.
    range.setValues([OUR_HEADERS]).setFontWeight("bold").setBackground("#e6e6e6");
    s.setColumnWidth(COL.lastReply, 360);
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
      notes: String(r[COL.notes - 1] || ""), lastReply: String(r[COL.lastReply - 1] || ""),
    };
  });
}

function setCell_(sheet, rowNo, col, value) { sheet.getRange(rowNo, col).setValue(value); }

/**
 * Rows are read once per run, but a person can insert or delete rows while the run is going.
 * Before every write, confirm the email is still at r.rowNo; if not, find it by email (column E).
 * Returns the row number, or null when the row is gone (then nothing is written and a log line says so).
 */
function locateRow_(sheet, r) {
  var at = String(sheet.getRange(r.rowNo, COL.email).getValues()[0][0] || "").trim().toLowerCase();
  if (at === r.email) return r.rowNo;
  var last = sheet.getLastRow();
  if (last >= 2) {
    var emails = sheet.getRange(2, COL.email, last - 1, 1).getValues();
    for (var i = 0; i < emails.length; i++) {
      if (String(emails[i][0] || "").trim().toLowerCase() === r.email) { r.rowNo = i + 2; return r.rowNo; }
    }
  }
  log_("row-moved", r.email, "Row for " + r.email + " is no longer in " + sheet.getName() + "; nothing written.");
  return null;
}

/** setCells_ by email: re-locates the row first. Returns false when the row is gone. */
function updateRow_(sheet, r, patch) {
  var n = locateRow_(sheet, r);
  if (n === null) return false;
  setCells_(sheet, n, patch);
  return true;
}
function setCells_(sheet, rowNo, patch) {
  Object.keys(patch).forEach(function (k) {
    if (!COL[k]) throw new Error("Unknown column " + k);
    sheet.getRange(rowNo, COL[k]).setValue(patch[k]);
  });
}

/** "" or junk -> 20. "0" -> 0 (sending paused). Never turns a real number into the default. */

/**
 * Notes is a log, not a label. Each new entry is added as a new line with a timestamp; nothing a person wrote
 * (such as "tz:America/Chicago" or "state:IL") is lost. The same message is not added twice in a row, so a
 * dry run that looks at the same row every 15 minutes writes one line, not a hundred. Oldest lines go first
 * when the cell passes 1,500 characters, hint lines excepted.
 */
var NOTES_MAX = 1500;

/**
 * The first lines of a reply for the LastReply column: spaces and line breaks squeezed, at most 500 characters.
 * A reply that starts with = + - or @ is stored as text, never as a formula.
 */
function replySnippet_(text) {
  var t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}
function appendNote_(existing, msg) {
  var lines = String(existing || "").split("\n").filter(function (l) { return l.trim() !== ""; });
  var last = lines.length ? lines[lines.length - 1].replace(/^\S+ \S+ /, "") : "";
  if (last === msg) return lines.join("\n");
  lines.push(stamp_(msg));
  var isHint = function (l) { return /\b(tz|state):\S+/.test(l); };
  while (lines.join("\n").length > NOTES_MAX) {
    var idx = -1;
    for (var i = 0; i < lines.length - 1; i++) { if (!isHint(lines[i])) { idx = i; break; } }
    if (idx === -1) break;
    lines.splice(idx, 1);
  }
  return lines.join("\n");
}

function stamp_(msg) { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm") + " " + msg; }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { log_("lock", "", "Another run is still going. Skipped."); return; }
  try { fn(); } finally { lock.releaseLock(); }
}
