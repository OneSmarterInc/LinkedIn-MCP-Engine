/** Dates and time zones. Parsing a proposed day and clock time; wall-clock conversion; weekday; lead zone. Part of AutoBooker: files load in name order; shared constants live in 00_Config.gs. */

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
      var todayDow = weekdayOf_(today);
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

/** Weekday (0 = Sunday) of a calendar date, independent of the time zone the script happens to run in. */
function weekdayOf_(p) {
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
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
