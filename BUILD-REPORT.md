# BUILD REPORT — vinreport

Clean-room rebuild of `com.dropwatchhq/title-check`
v1.0.0 (remote-only MCP server at
`https://titlecheck.dropwatchhq.com/mcp`), built 2026-10-28
as a forwarding client. Package: `@reneturcios/vinreport`
0.1.0, registry name `io.github.CloudCorpRecords/vinreport`.

## Surface built

Full surface: **1 of 1 captured tools built**.

| Tool | Required fields as served |
|------|---------------------------|
| `vehicle_report` | NO `required` key in the capture (both `vin` and `hin` are optional properties) — served verbatim, none invented |

The served tool carries exactly the keys `name`, `description`,
`inputSchema`, exactly as captured: the capture carries NO `title`
key, so none is served. The tool literal was generated
programmatically from
`harness/fixtures/titlecheck-tools-original.json` by the script
at `/tmp/b48-vinreport-scratch/gen.py` (parse + re-serialise; the
emitted `TOOL_DEFS` block was verified to byte-match the block in
`src/forward.ts`, and the generator's own round-trip assertion
confirmed the literal parses back to the fixture's tool object) —
never retyped — and the registration-integrity test suite plus the
parity harness confirmed the served literal deep-equals the
fixture's 1 tool object. Tools are registered via the MCP SDK
low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

The tool builds a pre-purchase report about a VEHICLE or boat
(an asset, identified by VIN/HIN) from PUBLIC NHTSA/USCG data —
open recalls (severity-ranked), consumer-complaint
crash/fire/injury/death counts, open investigations, and a VIN
check-digit + factory decode. It does NOT return lien or
title-brand records itself: the capture states it is "not an
official title record" and returns "the exact next-step sources
for lien & title-brand" (links to the state/NMVTIS checks) —
reads and links only, no transaction executed. The subject is
an asset, never a person or counterparty; no exclusion list is
checked, nothing is gated, and no payment, metering, contact,
signup or send tool exists in the surface.

## Fixture conflicts

**None.** The spec and the fixture agree on the tool's name,
description, required fields (including the absence of a
`required` key) and property shapes. The spec's note that the
capture carries no `title` key matches the fixture exactly.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://titlecheck.dropwatchhq.com/mcp`.
- Env override `TITLECHECK_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no auth
  header is ever sent. Tests assert that no `Authorization` header
  is sent under any environment — including with key-like env vars
  (`TITLECHECK_API_KEY`, `API_KEY`, `AUTHORIZATION`) set — and
  that no `X-API-Key` header is ever sent; upstream requests carry
  only `Content-Type`, `Accept` and, when issued, `Mcp-Session-Id`.
- Error rendering `vinreport error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP
  JSON-RPC: initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring
  `Mcp-Session-Id` when issued; plain-JSON and SSE replies are
  both parsed. The forwarding core takes an injectable fetch;
  tests stub the upstream — no live network calls in tests (the
  one CLI forwarding test points the CLI at a stub HTTP server
  on 127.0.0.1).

## Deviations

None.

## Lockfile

- Route: generated clean from birth in the build dir with no
  `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`
  (Route 3).
- Parses as JSON; `name` == `@reneturcios/vinreport`.
- Package entries: **128**.
- sha256: `0afd39808222c7a21326d3459e4fa9129fd8d37266b78aa8b6874be701db4c42`
  (re-verified unchanged after the subsequent offline `npm ci`).

## server.json

- Description exactly: "VIN/HIN pre-purchase report: NHTSA recalls, complaints, investigations, factory decode." —
  **87 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/vinreport:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio.
  Dockerfile (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/vinreport"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/vinreport`
  and its smoke test asserts the server name `vinreport`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`.
4. `npm test` → **54 tests, 54 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 1
   tool, including the no-title and no-required-key assertions,
   session handling/reuse, env override, the
   no-Authorization-header assertions under any environment,
   verbatim argument forwarding and result pass-through including
   upstream isError, SSE parsing, error rendering, MCP-layer
   validation, and CLI behaviour including a vehicle_report
   forwarding test against a local stub upstream).
5. Parity: `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/titlecheck-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/vinreport/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/vinreport/parity-out` → **verdict PASS, parity 100.0**
   (1/1 identical, 0 missing, 0 extra, no schema diffs). Output in
   `parity-out/`.
