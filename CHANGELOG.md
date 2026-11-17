# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted title-check MCP server. The single captured tool is answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tool: `vehicle_report`. The capture carries no `title` key, so none is served; the tool carries no `required` key in the capture — both `vin` and `hin` are optional properties — and none is served.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `vinreport error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `TITLECHECK_MCP_URL`. The upstream record declares no headers, so no auth header is ever sent.
