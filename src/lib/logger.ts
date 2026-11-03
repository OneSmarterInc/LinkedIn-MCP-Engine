import pino from "pino";

/**
 * Structured JSON logger. Emails and keys are redacted so no PII or secrets reach the logs.
 *
 * Logs go to STDERR, always. The MCP server talks to Claude Desktop over STDOUT (one JSON message per line),
 * so a log line on stdout lands in the middle of that conversation and the client stops understanding the
 * server. That showed up as tool calls that never returned while sourcing ran in the background.
 * The CLI prints its human-readable summary with console.log; diagnostics belong on stderr there too.
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: ["email", "*.email", "api_key", "*.api_key", "apiKey"], censor: "[redacted]" },
  },
  pino.destination({ fd: 2, sync: true }),
);
