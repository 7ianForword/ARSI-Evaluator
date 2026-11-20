import { createServer } from "node:http";
import { expect, test } from "vitest";

const moduleUrl = new URL("../../src/runtimes/shared/assets/model-relay.mjs", import.meta.url);
const { startModelRelay } = await import(moduleUrl.href);
const { nativeMessages } = await import(new URL("../../src/runtimes/shared/assets/native-code-launch.mjs", import.meta.url).href);

test("native output preserves split UTF-8 and rejects corrupt or truncated records", async () => {
  async function* chunks(...values: Uint8Array[]) { yield* values; }
  const line = Buffer.from('{"type":"text","text":"鲸🐳"}\n');
  const parsed = [];
  for await (const event of nativeMessages(chunks(...[...line].map(byte => Uint8Array.of(byte))))) parsed.push(event);
  expect(parsed).toEqual([{ type: "text", text: "鲸🐳" }]);
  const read = async (bytes: Uint8Array) => { for await (const _event of nativeMessages(chunks(bytes))) { /* Drain controlled output. */ } };
  await expect(read(Buffer.from('{"type":"text"}'))).rejects.toThrow(/incomplete/u);
  await expect(read(Buffer.from('{not json}\n'))).rejects.toThrow(/invalid JSONL/u);
  await expect(read(Buffer.from([0xff, 0x0a]))).rejects.toThrow();
});

test.each(["openai-completions", "openai-responses", "anthropic-messages"])("native CLI relay applies %s limits and effort on every call without leaking its key", async api => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push(JSON.parse(text));
    expect(request.headers.authorization ?? request.headers["x-api-key"]).toMatch(/upstream-secret/u);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const usage = api === "anthropic-messages" ? { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3 }
      : api === "openai-completions" ? { prompt_tokens: 13, completion_tokens: 2 } : { input_tokens: 13, output_tokens: 2 };
    response.end(`data: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const relay = await startModelRelay({ api, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "upstream-secret", token: "relay-token", reasoningEffort: "low", maxTokens: 70000, noTools: true, captureUsage: true });
  try {
    const route = api === "openai-completions" ? "/chat/completions" : api === "openai-responses" ? "/responses" : "/messages";
    for (let i = 0; i < 2; i++) {
      const response = await fetch(relay.endpoint + route, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture", tools: [{ type: "function", name: "Bash" }], tool_choice: "required", max_tokens: 8, reasoning_effort: "high" }) });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("upstream-secret");
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.tools).toBeUndefined();
      expect(request.tool_choice).toBeUndefined();
      expect(request).toMatchObject(api === "openai-responses" ? { max_output_tokens: 70000, reasoning: { effort: "low" } }
        : api === "anthropic-messages" ? { max_tokens: 70000, output_config: { effort: "low" } } : { max_tokens: 70000, reasoning_effort: "low" });
    }
    expect(relay.usage()).toEqual({ inputTokens: 26, outputTokens: 4, totalTokens: 30 });
    expect((await fetch(relay.endpoint + route, { method: "POST", body: "{}" })).status).toBe(401);
  } finally { relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test.each([false, true])("no-tools relay blocks unexpected tool output before native execution (SSE=%s)", async stream => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the controlled request. */ }
    const payload = { choices: [{ delta: { tool_calls: [{ id: "call", type: "function", function: { name: "Bash", arguments: "{}" } }] }, message: { tool_calls: [{}] } }] };
    response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
    response.end(stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const relay = await startModelRelay({ api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "secret", token: "token", noTools: true });
  try {
    // The tool-bearing record must never reach the CLI, even if the provider
    // violates the empty tool declaration. A broken stream is an invalid attempt.
    const output = await fetch(relay.endpoint + "/chat/completions", { method: "POST", headers: { authorization: "Bearer token" }, body: "{}" })
      .then(response => response.text()).catch(() => "stream rejected");
    expect(output).not.toContain("tool_calls");
    expect(output).not.toContain('"Bash"');
  } finally { relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("the ACP request ceiling excludes HTTP failures and rejects requests before another model step", async () => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the controlled request. */ }
    calls++;
    response.writeHead(calls === 1 ? 503 : 200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const relay = await startModelRelay({ api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "secret", token: "token", maxModelCalls: 1 });
  const request = () => fetch(relay.endpoint + "/chat/completions", { method: "POST", headers: { authorization: "Bearer token" }, body: "{}" });
  try {
    const failed = await request(); expect(failed.status).toBe(503); await failed.text();
    const success = await request(); expect(success.status).toBe(200); await success.text();
    const rejected = await request(); expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("MAX_TURNS_EXCEEDED");
    expect(calls).toBe(2);
  } finally { relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
