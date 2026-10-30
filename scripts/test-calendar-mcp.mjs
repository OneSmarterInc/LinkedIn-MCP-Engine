import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "calendar-mcp-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/tsx/dist/cli.mjs", "src/mcp/server.ts"],
  cwd: process.cwd(),
  env: process.env
});

try {
  await client.connect(transport);

  console.log("\nTesting Google Calendar availability...\n");

  const result = await client.callTool({
    name: "get_free_slots",
    arguments: {
      days_ahead: 2,
      slot_minutes: 30,
      max_slots: 5
    }
  });

  console.log("CALENDAR TOOL RESPONSE:");
  console.log(JSON.stringify(result, null, 2));

  if (result.isError) {
    console.error("\nCALENDAR TEST FAILED.");
    process.exitCode = 1;
  } else {
    console.log("\nCALENDAR TEST COMPLETED.");
  }

} catch (error) {
  console.error("CALENDAR TEST FAILED:", error);
  process.exitCode = 1;
} finally {
  await client.close();
}
