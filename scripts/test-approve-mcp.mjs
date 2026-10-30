import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "linkedin-mcp-approval-test",
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

  const result = await client.callTool({
    name: "approve_lead",
    arguments: {
      email: "jane.miller@caresource.com",
      confirm: true
    }
  });

  const output = result.content?.find(item => item.type === "text")?.text;

  if (result.isError) {
    throw new Error(output || "Approval test failed");
  }

  console.log("\nAPPROVAL TOOL TEST:");
  console.log(output);
  console.log("\nAPPROVAL TOOL TEST: SUCCESS");

} catch (error) {
  console.error("\nAPPROVAL TOOL TEST FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
