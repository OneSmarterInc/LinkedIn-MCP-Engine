/** Calendar. Booking inside office hours, free slots, offering times. Part of AutoBooker: files load in name order; shared constants live in 00_Config.gs. */

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** "9 AM to 5 PM Eastern": the office hours in words, for a reply that declines a time. */
function officeHoursText_(cfg) {
  var startH = Number(cfg.WorkStartHour) || 9, endH = Number(cfg.WorkEndHour) || 17;
  var h12 = function (h) { return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? " AM" : " PM"); };
  return h12(startH) + " to " + h12(endH) + " " + zoneLabel_(cfg.TimeZone);
}

/**
 * Books the proposed time or says why not. Working hours and weekdays are judged in the office zone
 * (cfg.TimeZone); the lead's zone is used only to word the confirmation. `onBooked` is called right after the
 * calendar event exists and before the confirmation email, so the row says BOOKED even if Gmail then fails.
 */
function tryBook_(thread, row, cfg, when, onBooked) {
  var mins = Number(cfg.MeetingMinutes) || 15;
  var end = new Date(when.getTime() + mins * 60000);
  var leadTz = leadZone_(row, cfg);
  var office = partsInZone_(when, cfg.TimeZone);
  var startH = Number(cfg.WorkStartHour) || 9, endH = Number(cfg.WorkEndHour) || 17;

  if (office.h < startH || office.h >= endH) return { booked: false, reason: "That time is outside my working hours (" + officeHoursText_(cfg) + ")." };
  var dow = weekdayOf_(office);
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

  var label = Utilities.formatDate(when, leadTz, "EEEE, MMM d 'at' h:mm a") + " " + zoneLabel_(leadTz);
  if (onBooked) onBooked(label); // the Sheet says BOOKED before any further Gmail call

  try {
    thread.reply(
      "Hi " + firstName_(row.name) + ",\n\nBooked for " + label + ". A calendar invite is on its way. Talk then.\n\n" + signature_(cfg),
      mailOpts_(cfg)
    );
  } catch (e) {
    return { booked: true, label: label, confirmationFailed: String(e.message || e) };
  }
  return { booked: true, label: label };
}

/** Three open slots on three different working days, next 7 days, inside the office hours (cfg.TimeZone). */
function freeSlots_(cfg, count) {
  var tz = cfg.TimeZone;
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
    var dow = weekdayOf_(p);
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
  var tz = leadZone_(row, cfg); // slots are picked in office hours; they are written in the lead's zone
  var slots = freeSlots_(cfg, 3);
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
