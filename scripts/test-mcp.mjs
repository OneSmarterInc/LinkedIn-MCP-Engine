import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "linkedin-mcp-test",
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

  const result = await client.listTools();

  console.log("\nMCP CONNECTION: SUCCESS");
  console.log("REGISTERED TOOLS:");

  for (const tool of result.tools) {
    console.log(`- ${tool.name}`);
  }

  console.log(`\nTOTAL TOOLS: ${result.tools.length}`);
} catch (error) {
  console.error("MCP TEST FAILED:", error);
  process.exitCode = 1;
} finally {
  await client.close();
}
