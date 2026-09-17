# Optional MCP gateway

MCP is opt-in and only connects to endpoints supplied by the deployment operator in `HARNESS_MCP_SERVERS`; a model never selects an endpoint, transport, or secret.

```sh
# HTTPS is required except explicitly allowed loopback development endpoints.
HARNESS_MCP_SERVERS='[
  {"id":"internal","url":"https://mcp.example.net/mcp","tokenEnv":"INTERNAL_MCP_TOKEN"}
]'
INTERNAL_MCP_TOKEN='stored-outside-the-repository'
```

Each entry has a lowercase `id`, an HTTPS URL with no credentials, query, or fragment, and an optional environment-variable *name* (`tokenEnv`). Inline secrets are rejected. For a local test server only, `http://localhost`, `127.0.0.1`, or `[::1]` requires `"allowHttpLoopback":true`. Store tokens in the deployment secret manager/environment and scope them only to the configured MCP endpoint; never place them in session data, tool definitions, prompts, or source control.

`parseMcpServers(process.env.HARNESS_MCP_SERVERS ?? "")` creates operator configuration, then `new McpGateway(servers).connect()` supplies native `ToolPlugin`s. Registered names are deterministic `mcp_<server>_<tool>` values. The parent registry can expose their `definition` objects to either native tool calling or PTC just as other plugins. Calls are always approval-required, including a remote server's claimed `readOnlyHint`; call through the normal registry approval boundary and pass its `ToolContext`.

The gateway uses the maintained MCP SDK Streamable HTTP client, supports `tools/list` pagination, and limits configuration to 8 servers, discovery to 32 tools, individual descriptions/schemas to 16 KiB, schema depth to 24, and results to 64 KiB. Schemas are locally validated with Ajv before any remote call; references are disallowed. Calls have a 20-second request/total timeout and honor the run abort signal. Redirects and requests outside the exact configured URL are rejected, preventing authorization headers from following a redirect.

The included test suite uses only a temporary loopback JSON-RPC fixture implementing the SDK handshake, paginated discovery, and tool calls. It does not contact a live third-party MCP server.
