import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { applyReasoningEffort } from "../../../infrastructure/models/reasoning-effort.mjs";

const routes = {
  "openai-completions": ["/chat/completions"],
  "openai-responses": ["/responses"],
  "anthropic-messages": ["/messages", "/messages/count_tokens"],
};
const requestHeaders = ["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"];
const responseHeaders = ["content-type", "retry-after", "request-id"];
const hasToolCall = event => event.choices?.some(choice => choice.delta?.tool_calls?.length || choice.message?.tool_calls?.length || choice.delta?.function_call || choice.message?.function_call)
  || ["tool_use", "server_tool_use"].includes(event.content_block?.type)
  || ["function_call", "custom_tool_call"].includes(event.item?.type)
  || event.output?.some(item => ["function_call", "custom_tool_call"].includes(item.type))
  || event.response?.output?.some(item => ["function_call", "custom_tool_call"].includes(item.type))
  || event.content?.some(item => ["tool_use", "server_tool_use"].includes(item.type));

export async function startModelRelay({ api, baseUrl, apiKey, token, reasoningEffort, maxTokens, noTools = false, captureUsage = false, maxModelCalls }) {
  const anthropic = api === "anthropic-messages";
  const base = anthropic && !baseUrl.endsWith("/v1") ? baseUrl + "/v1" : baseUrl;
  const totals = { inputTokens: 0, outputTokens: 0, reported: false };
  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    const authorized = request.headers.authorization === "Bearer " + token
      || (anthropic && request.headers["x-api-key"] === token);
    if (!authorized) return response.writeHead(401).end();
    const url = URL.parse(request.url, "http://localhost");
    const route = routes[api]?.find(path => url?.pathname === "/v1" + path);
    if (request.method !== "POST" || !route) return response.writeHead(404).end();
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    try {
      const counted = route !== "/messages/count_tokens" && maxModelCalls !== undefined;
      if (counted && modelCalls >= maxModelCalls) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: {
          type: "invalid_request_error", code: "MAX_TURNS_EXCEEDED", message: `The configured maxTurns limit (${maxModelCalls}) was reached` } }));
        return;
      }
      const headers = new Headers(anthropic ? { "x-api-key": apiKey } : { authorization: "Bearer " + apiKey });
      for (const name of requestHeaders) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      let body = request;
      if (noTools || (route !== "/messages/count_tokens" && (reasoningEffort !== undefined || maxTokens !== undefined))) {
        let payload = JSON.parse(await text(request));
        if (reasoningEffort !== undefined && route !== "/messages/count_tokens") payload = applyReasoningEffort(payload, api, reasoningEffort);
        if (maxTokens !== undefined && route !== "/messages/count_tokens") {
          const key = api === "openai-responses" ? "max_output_tokens" : api === "openai-completions" && payload.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
          delete payload.max_tokens;
          delete payload.max_completion_tokens;
          delete payload.max_output_tokens;
          payload[key] = maxTokens;
        }
        if (noTools) { delete payload.tools; delete payload.tool_choice; delete payload.parallel_tool_calls; }
        body = JSON.stringify(payload);
      }
      if (counted) modelCalls++;
      let upstream;
      try {
        upstream = await fetch(base + route + url.search, {
          method: "POST", headers, body, duplex: "half", redirect: "error", signal: controller.signal,
        });
      } catch (error) {
        if (counted) modelCalls--;
        throw error;
      }
      if (counted && !upstream.ok) modelCalls--;
      for (const name of responseHeaders) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.writeHead(upstream.status);
      if (upstream.body && (noTools || captureUsage) && upstream.headers.get("content-type")?.includes("text/event-stream")) {
        let pending = "";
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        let usage;
        const commitUsage = () => {
          if (!captureUsage || !usage) return;
          const input = usage.prompt_tokens ?? usage.input_tokens;
          const output = usage.completion_tokens ?? usage.output_tokens;
          if (Number.isSafeInteger(input) && Number.isSafeInteger(output)) {
            totals.reported = true;
            totals.inputTokens += input + (anthropic ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0);
            totals.outputTokens += output;
          }
        };
        const inspect = line => {
          if (!line.startsWith("data:")) return;
          let event;
          try { event = JSON.parse(line.slice(5)); } catch { return; }
          if (noTools && hasToolCall(event)) {
            throw Error("Tool calls are disabled for this attempt");
          }
          const current = event.usage ?? event.message?.usage ?? event.response?.usage;
          if (current) usage = { ...usage, ...current };
        };
        const inspector = new Transform({
          transform(chunk, _encoding, callback) {
            try {
              pending += decoder.decode(chunk, { stream: true });
              let newline;
              while ((newline = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, newline + 1);
                pending = pending.slice(newline + 1);
                inspect(line);
                this.push(line);
              }
              callback();
            } catch (error) { callback(error); }
          },
          flush(callback) {
            try { pending += decoder.decode(); inspect(pending); this.push(pending); commitUsage(); callback(); }
            catch (error) { callback(error); }
          },
        });
        await pipeline(upstream.body, inspector, response, { signal: controller.signal });
      }
      else if (upstream.body && noTools && upstream.headers.get("content-type")?.includes("application/json")) {
        const payload = await upstream.text();
        if (hasToolCall(JSON.parse(payload))) throw Error("Tool calls are disabled for this attempt");
        response.end(payload);
      }
      else if (upstream.body) await pipeline(upstream.body, response, { signal: controller.signal });
      else response.end();
    } catch {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "Model relay could not reach its upstream" } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: "http://127.0.0.1:" + server.address().port + "/v1",
    usage() { return totals.reported ? { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, totalTokens: totals.inputTokens + totals.outputTokens } : {}; },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
