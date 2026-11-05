/** AutoBooker constants. Tabs, columns, statuses, Config keys, US state time zones. Part of AutoBooker: files load in name order; shared constants live in 00_Config.gs. */

/**
 * AutoBooker.gs — Phase 5 sender for the LinkedIn MCP Engine.
 *
 * Reads the "Pipeline" tab the TypeScript exporter writes (columns A–J), and the "Jobs_Pipeline"
 * tab search_jobs writes (same columns) when it exists,
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

var TAB = { pipeline: "Pipeline", jobsPipeline: "Jobs_Pipeline", config: "Config", log: "SendLog", campaigns: "Campaigns" };

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
  meetingBooked: "Meeting Booked", optedOut: "Opted Out", bounced: "Bounced",
};

var STATE = {
  sending: "SENDING", sent: "SENT", timesOffered: "TIMES_OFFERED",
  needsHuman: "NEEDS_HUMAN", booked: "BOOKED", optedOut: "OPTED_OUT", sendFailed: "SEND_FAILED", bounced: "BOUNCED",
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
