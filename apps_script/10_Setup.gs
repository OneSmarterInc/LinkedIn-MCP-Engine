/** Setup and tabs. setup() once, triggers, the Config, Campaigns and SendLog tabs, onEdit. Part of AutoBooker: files load in name order; shared constants live in 00_Config.gs. */

// ---------------------------------------------------------------------------
// Entry points. Run setup() once, then let the triggers work.
// ---------------------------------------------------------------------------

function setup() {
  ensureConfigTab();
  ensureOurColumns();
  ensureLogTab();
  ensureCampaignsTab();
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

// ---------------------------------------------------------------------------
// Campaigns tab. The engine (src/config/store.ts) owns the layout and validates rows;
// this only makes the tab friendly to type into: dropdowns, checkboxes, widths, and an
// UpdatedAt stamp when a person edits a row. Column order must match CAMPAIGN_HEADERS in store.ts.
// ---------------------------------------------------------------------------

var CAMPAIGN_HEADERS = [
  "Name", "Active", "Mode", "Provider", "States", "Titles", "Keywords", "SignalQuery", "Persona",
  "SenderCompany", "Offer", "MeetingMinutes", "DailyCap", "BlockEmployerDomain", "CsvPath", "Status", "UpdatedAt",
];

function ensureCampaignsTab() {
  var s = ss_().getSheetByName(TAB.campaigns);
  if (!s) s = ss_().insertSheet(TAB.campaigns);
  var n = CAMPAIGN_HEADERS.length;
  var cur = s.getRange(1, 1, 1, n).getValues()[0].map(String);
  if (cur.every(function (c) { return c.trim() === ""; })) {
    s.getRange(1, 1, 1, n).setValues([CAMPAIGN_HEADERS]).setFontWeight("bold").setBackground("#e6e6e6");
    s.setFrozenRows(1);
  } else if (CAMPAIGN_HEADERS.some(function (h, i) { return cur[i] !== h; })) {
    throw new Error("Campaigns tab headers differ from the engine's. Expected: " + CAMPAIGN_HEADERS.join(", "));
  }
  var rows = Math.max(50, s.getMaxRows() - 1);
  var col = function (h) { return CAMPAIGN_HEADERS.indexOf(h) + 1; };
  var list = function (h, values) {
    s.getRange(2, col(h), rows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build());
  };
  var box = function (h) {
    s.getRange(2, col(h), rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  };
  list("Mode", ["CORPORATE", "CANDIDATE"]);
  list("Provider", ["gemini_xray", "csv_import", "apify_or_apollo"]);
  box("Active");
  box("BlockEmployerDomain");
  [["Name", 180], ["States", 180], ["Titles", 220], ["Keywords", 180], ["Offer", 360], ["Status", 320], ["UpdatedAt", 160]]
    .forEach(function (w) { s.setColumnWidth(col(w[0]), w[1]); });
  s.getRange(2, col("Status"), rows, 1).setWrap(true);
  // A fresh tab gets one example row so people see the shape. It is paused.
  if (s.getLastRow() < 2) {
    s.getRange(2, 1, 1, n).setValues([[
      "Example: Ohio TPAs", false, "CORPORATE", "gemini_xray", "Ohio, Indiana", "CFO, VP of Human Resources",
      "Third Party Administrator, Healthcare", "", "", "One Smarter",
      "a 15-minute call to compare how their team reviews medical claims before money goes out",
      15, 20, false, "", "Not checked yet. Run `campaign validate` or the validate_campaigns tool.", "",
    ]]);
  }
}

/** Simple trigger: when a person edits a Campaigns row, stamp UpdatedAt and clear a stale OK so it gets re-checked. */
function onEdit(e) {
  try {
    var r = e && e.range;
    if (!r || r.getSheet().getName() !== TAB.campaigns || r.getRow() < 2) return;
    var s = r.getSheet();
    var statusCol = CAMPAIGN_HEADERS.indexOf("Status") + 1;
    var updatedCol = CAMPAIGN_HEADERS.indexOf("UpdatedAt") + 1;
    if (r.getColumn() === statusCol || r.getColumn() === updatedCol) return;
    s.getRange(r.getRow(), updatedCol).setValue(new Date().toISOString());
    s.getRange(r.getRow(), statusCol).setValue("Edited. Not checked yet.");
  } catch (err) { /* never block a person's edit */ }
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
