import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({
  name: "linkedin-mcp-workflow-test",
  version: "1.0.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["node_modules/tsx/dist/cli.mjs", "src/mcp/server.ts"],
  cwd: process.cwd(),
  env: process.env
});

function parseResult(result, toolName) {
  if (result.isError) {
    throw new Error(`${toolName} failed: ${result.content?.[0]?.text}`);
  }

  const text = result.content?.find(item => item.type === "text")?.text;
  if (!text) throw new Error(`${toolName} returned no data`);

  return JSON.parse(text);
}

try {
  await client.connect(transport);

  console.log("\n1. TESTING SOURCE_LEADS");

  const source = parseResult(
    await client.callTool({
      name: "source_leads",
      arguments: {
        campaign_path: "campaigns/b2b_healthcare.json",
        csv_path: "tests/fixtures/dirty_leads.csv",
        limit: 2
      }
    }),
    "source_leads"
  );

  console.log(source);

  console.log("\n2. TESTING VERIFY_LEADS");

  const verification = parseResult(
    await client.callTool({
      name: "verify_leads",
      arguments: { run_id: source.run_id }
    }),
    "verify_leads"
  );

  console.log(verification);

  console.log("\n3. TESTING DRAFT_EMAILS");

  const drafts = parseResult(
    await client.callTool({
      name: "draft_emails",
      arguments: {
        run_id: source.run_id,
        concurrency: 2
      }
    }),
    "draft_emails"
  );

  console.log({
    run_id: drafts.run_id,
    status: drafts.status,
    total_drafts: drafts.total_drafts,
    ready: drafts.ready,
    needs_rewrite: drafts.needs_rewrite,
    errors: drafts.errors
  });

  console.log("\nALL THREE MCP TOOLS TESTED SUCCESSFULLY");

} catch (error) {
  console.error("\nWORKFLOW TEST FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
