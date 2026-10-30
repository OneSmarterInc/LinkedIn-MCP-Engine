import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "linkedin-mcp-sheets-test",
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

  console.log("\nTESTING GOOGLE SHEETS: get_pipeline");

  const result = await client.callTool({
    name: "get_pipeline",
    arguments: { limit: 5 }
  });

  if (result.isError) {
    throw new Error(result.content?.[0]?.text || "Google Sheets request failed");
  }

  const output = JSON.parse(
    result.content.find(item => item.type === "text").text
  );

  console.log("\nGOOGLE SHEETS CONNECTION: SUCCESS");
  console.log("Records returned:", output.total);
  console.log(JSON.stringify(output.records, null, 2));

} catch (error) {
  console.error("\nGOOGLE SHEETS TEST FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
