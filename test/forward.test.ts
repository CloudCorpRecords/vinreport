import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  VinreportClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real title-check endpoint is
 * never contacted. The one CLI forwarding test points the
 * CLI at a stub HTTP server on 127.0.0.1 for the same
 * reason.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/titlecheck-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const PRIMARY = "vehicle_report";

const SAMPLE_RESULT = {
  content: [
    {
      type: "text",
      text: "{\"vin\":\"1HGCM82633A004352\",\"recalls\":2}",
    },
  ],
  structuredContent: { vin: "1HGCM82633A004352", recalls: 2 },
};

const SAMPLE_ARGS = { vin: "1HGCM82633A004352" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-v1" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "title-check", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new VinreportClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function hasAuthHeader(call: Captured): boolean {
  return Object.keys(call.headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 1 tool, deep-equal", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 1);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 1 tool name in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ["vehicle_report"]);
  });

  it("carries exactly the fixture's keys on the tool (no title invented)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
      ]);
      assert.equal("title" in tool, false);
    }
  });

  it("carries the fixture's description verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(TOOL_DEFS[0].description, fixture.tools[0].description);
  });

  it("vehicle_report carries NO required key, exactly as captured", () => {
    assert.equal("required" in schemaOf(TOOL_DEFS[0]), false);
  });

  it("carries object type and no $schema or additionalProperties marker on the inputSchema", () => {
    assert.equal(schemaOf(TOOL_DEFS[0]).type, "object");
    assert.equal("$schema" in schemaOf(TOOL_DEFS[0]), false);
    assert.equal("additionalProperties" in schemaOf(TOOL_DEFS[0]), false);
  });

  it("carries every fixture property, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.deepEqual(
      Object.keys(schemaOf(TOOL_DEFS[0]).properties),
      Object.keys(schemaOf(fixture.tools[0]).properties),
    );
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), [
      "vin",
      "hin",
    ]);
  });

  it("carries the captured property types across the surface", () => {
    const props = schemaOf(TOOL_DEFS[0]).properties;
    assert.equal(props.vin.type, "string");
    assert.equal(props.hin.type, "string");
  });

  it("carries the captured property descriptions verbatim", () => {
    const props = schemaOf(TOOL_DEFS[0]).properties;
    assert.equal(
      props.vin.description,
      "17-character VIN (cars/trucks/RVs/trailers/equipment).",
    );
    assert.equal(
      props.hin.description,
      "12-character Hull Identification Number (recreational boats).",
    );
  });

  it("isKnownTool recognises the built tool and rejects others", () => {
    assert.equal(isKnownTool("vehicle_report"), true);
    assert.equal(isKnownTool("vehicle"), false);
    assert.equal(isKnownTool("title_check"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(
      DEFAULT_ENDPOINT_URL,
      "https://titlecheck.dropwatchhq.com/mcp",
    );
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-v1");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-v1");
  });

  it("sends clientInfo name vinreport and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "vinreport", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    await c.callTool(PRIMARY, { hin: "ABC12345J625" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-v1");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the TITLECHECK_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new VinreportClient({
      fetchFn: upstream.fetchFn,
      env: { TITLECHECK_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { TITLECHECK_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new VinreportClient({
      fetchFn: upstream.fetchFn,
      env: { TITLECHECK_MCP_URL: "   " },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no Authorization header is ever sent (record declares no headers)", () => {
  it("sends no Authorization header with an empty environment", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => !hasAuthHeader(call)));
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when key-like env vars are set", async () => {
    const upstream = makeUpstream();
    const c = new VinreportClient({
      fetchFn: upstream.fetchFn,
      env: {
        TITLECHECK_API_KEY: "should-never-be-sent",
        API_KEY: "also-ignored",
        AUTHORIZATION: "Bearer planted",
      },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(upstream.calls.length, 3);
    assert.ok(upstream.calls.every((call) => !hasAuthHeader(call)));
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new VinreportClient({
      fetchFn: upstream.fetchFn,
      env: { TITLECHECK_API_KEY: "should-never-be-sent" },
    });
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), ["Accept", "Content-Type"]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a vehicle_report call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, PRIMARY);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a vehicle_report call with both identifiers verbatim", async () => {
    const args = { vin: "1HGCM82633A004352", hin: "ABC12345J625" };
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "vehicle_report");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a hin-only vehicle_report call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(PRIMARY, { hin: "ABC12345J625" });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "vehicle_report");
    assert.deepEqual(params.arguments, { hin: "ABC12345J625" });
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no report for that VIN" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(PRIMARY, { vin: "00000000000000000" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      PRIMARY,
      { hin: "ABC12345J625" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "vehicle_report");
    assert.deepEqual(params.arguments, { hin: "ABC12345J625" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as vinreport error text", () => {
  it("maps a JSON-RPC error to `vinreport error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "report failed upstream" },
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "vinreport error: report failed upstream");
  });

  it("maps an initialize JSON-RPC error to vinreport error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "vinreport error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "vinreport error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "vinreport error: malformed response");
  });

  it("maps a non-2xx upstream status to vinreport error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "vinreport error: HTTP 500");
  });

  it("maps a throwing fetch to vinreport error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^vinreport error: /);
  });

  it("maps a throwing initialize fetch to vinreport error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "vinreport error: socket hang up");
  });

  it("maps a timed-out call to vinreport error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(PRIMARY, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^vinreport error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, PRIMARY, "vin=1HGCM82633A004352"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid vehicle_report call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PRIMARY, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, PRIMARY, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, ...env },
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /vehicle_report/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([PRIMARY, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([PRIMARY, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });

  it("the vehicle_report subcommand forwards to the upstream and prints the result", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const stub = createHttpServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push(body);
        res.setHeader("Content-Type", "application/json");
        if (body.method === "initialize") {
          res.setHeader("Mcp-Session-Id", "sess-cli");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: "title-check", version: "1.0.0" },
              },
            }),
          );
        } else if (body.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end("");
        } else if (body.method === "tools/call") {
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: SAMPLE_RESULT }),
          );
        } else {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
        }
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address();
    assert.ok(address !== null && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    try {
      const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", cliPath, PRIMARY, JSON.stringify(SAMPLE_ARGS)],
            {
              cwd: root,
              env: { ...process.env, TITLECHECK_MCP_URL: url },
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => {
            stdout += d;
          });
          child.stderr.on("data", (d) => {
            stderr += d;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        },
      );
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /1HGCM82633A004352/);
      const call = seen.find((b) => b.method === "tools/call");
      assert.ok(call !== undefined);
      const params = call.params as Record<string, unknown>;
      assert.equal(params.name, "vehicle_report");
      assert.deepEqual(params.arguments, SAMPLE_ARGS);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});
