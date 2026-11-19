import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchCodeCli, jsonlRun } from "./runtimes/shared/assets/native-code-launch.mjs";

await launchCodeCli({
  entry: "node_modules/@minimax-ai/code/cli.js",
  stageImages: true,
  async configure({ home, endpoint, env, api, model, token, maxTokens, contextWindow, reasoningEffort, maxTurns, supportsImages, prompt, files, toolPolicy }) {
    env.MINIMAX_DATA_DIR = join(home, "minimax");
    const none = toolPolicy.tools === "none";
    const config = {
      custom_provider: { evaluator: { kind: "custom", enabled: true, name: "Evaluator", api,
        options: { apiKey: token, baseURL: api === "anthropic-messages" ? endpoint.replace(/\/v1$/u, "") : endpoint, authMode: "api-key" }, models: { [model]: {
          id: model, name: model, attachment: supportsImages, tool_call: true,
          capabilities: { support_image: supportsImages },
          modalities: { input: supportsImages ? ["text", "image"] : ["text"], output: ["text"] },
          limit: { context: contextWindow ?? 200000, output: maxTokens ?? 16384 },
          ...(reasoningEffort === undefined ? {} : { reasoning: true, thinking: {
            effortOptions: [reasoningEffort], defaultEffort: reasoningEffort } }),
      } } } }, defaultModel: `custom_provider:evaluator/${model}`, defaultLightModel: `custom_provider:evaluator/${model}`,
      agents: { default: {
        ...(none ? { tools: [], builtinTools: [], skills: [] } : toolPolicy.webFetch === "disabled" ? {
          tools: ["read", "write", "edit", "bash", "task_query", "task_output", "task_stop", "grep", "glob", "todowrite", "website_deploy"],
        } : {}),
        ...(none ? { features: { mavis: false, delegation: false, webSearch: false } }
          : toolPolicy.webSearch === "disabled" ? { features: { webSearch: false } } : {}),
      } },
      telemetry: { enabled: false, metrics: false, diagnostics: false },
      sessionTitle: { enabled: false }, promptSuggestion: { enabled: false },
    };
    const configPath = join(home, "runtime.json");
    // JSON is also valid YAML; the native --config loader accepts this file.
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    return { args: ["exec", "--config", configPath, "--model", `custom_provider:evaluator/${model}`, "--permission", "full",
      "--input", "-", "--input-format", "json", "--output-format", "stream-json",
      ...(reasoningEffort === undefined ? [] : ["--effort", reasoningEffort]),
      ...(maxTurns === undefined ? [] : ["--max-steps", String(maxTurns)]),
      ...files.flatMap(file => ["--file", file])], input: JSON.stringify({ prompt }) };
  },
  async run(state) {
    let result;
    return jsonlRun(state, event => { if (event.type === "exec.completed") result = event.result; }, () => {
      if (!result || result.status !== "succeeded" || typeof result.output !== "string") {
        throw Error(result?.error?.message ?? `MiniMax Code result: ${result?.status ?? "missing"}`);
      }
      return { finalText: result.output, usage: result.usage };
    });
  },
});
