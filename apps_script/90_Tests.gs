/** Tests. runTests() from the editor before going live; read the log. Part of AutoBooker: files load in name order; shared constants live in 00_Config.gs. */

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
  check("offer question books", classifyReply_("Does Tuesday at 2pm work for you?", row, cfg).kind, "TIME_PROPOSED");
  check("other question -> human", classifyReply_("Did you mean Tuesday at 2pm?", row, cfg).note, "asked a question");
  check("header auto-reply", isAutomatedMessage_({ getFrom: function () { return "a@b.com"; }, getHeader: function (n) { return n === "Auto-Submitted" ? "auto-replied" : ""; } }), true);
  check("zone in text", zoneInText_("Tuesday at 2pm Pacific works"), "America/Los_Angeles");

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
