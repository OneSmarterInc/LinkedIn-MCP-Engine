import pino from "pino";

// Logs go to stderr. stdout is reserved for the MCP protocol: any log line there breaks Claude Desktop.
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: ["email", "*.email", "api_key", "*.api_key", "apiKey"], censor: "[redacted]" },
  },
  pino.destination(2),
);
