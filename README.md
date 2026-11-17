# vinreport

Thinking of buying a car, truck, RV, trailer, piece of heavy equipment, or a recreational boat? vinreport is a local forwarding client for the hosted title-check MCP service: it answers `tools/list` locally from the captured tool definition and forwards every call to the service, returning the report exactly as the service sends it back.

The single tool, `vehicle_report`, builds a pre-purchase report for a titled asset from public federal data. For a vehicle identified by its 17-character VIN it pulls open NHTSA recalls ranked by severity, consumer-complaint counts covering crashes, fires, injuries and deaths, any open investigations, and a VIN check-digit validation with a factory decode. For a boat, the same report is keyed by the 12-character Hull Identification Number (HIN) against USCG data. The report also names the exact next-step sources for lien and title-brand checks. It is not an official title record: lien and salvage status need a state or NMVTIS check, and the report links to those rather than pretending to settle them.

## The tool

- **`vehicle_report`** — Pre-purchase report for a titled asset by `vin` (cars, trucks, RVs, trailers, heavy equipment) or `hin` (recreational boats). Both parameters are optional in the captured schema; pass whichever identifier the asset carries.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/vinreport mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "vinreport": {
      "command": "npx",
      "args": ["-y", "@reneturcios/vinreport", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/vinreport
docker run --rm ghcr.io/cloudcorprecords/vinreport vehicle_report '{"vin":"1HGCM82633A004352"}'
```

## CLI

One binary serves both the command line and the MCP server. The tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
vinreport vehicle_report '{"vin":"1HGCM82633A004352"}'
vinreport vehicle_report '{"hin":"ABC12345J625"}'
vinreport --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `TITLECHECK_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://titlecheck.dropwatchhq.com/mcp`. (The override variable is a reconstruction added by this rebuild.)

The upstream registry record declares no headers, so no authentication header is ever sent; the tool surface was captured keyless.

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `vinreport error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface (the 1 tool, deep-equal, with no title invented and no `required` key added), exercises the session handshake and its reuse, verifies that no `Authorization` header is ever sent under any environment, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
