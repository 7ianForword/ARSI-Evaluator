import { launchCodeCli, acpRun } from "./runtimes/shared/assets/native-code-launch.mjs";

await launchCodeCli({
  entry: "node_modules/opencode-ai/bin/opencode.exe", native: true, enforceMaxTurns: true,
  async configure({ endpoint, env, api, model, token, maxTokens, contextWindow, maxTurns, supportsImages, toolPolicy }) {
    const permission = toolPolicy.tools === "none" ? { "*": "deny" } : { "*": "allow",
      ...(toolPolicy.webSearch === "disabled" ? { websearch: "deny", search: "deny" } : {}),
      ...(toolPolicy.webFetch === "disabled" ? { webfetch: "deny", fetch: "deny" } : {}) };
    const npm = api === "anthropic-messages" ? "@ai-sdk/anthropic" : api === "openai-responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible";
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: `evaluator/${model}`, small_model: `evaluator/${model}`,
      provider: { evaluator: { npm, options: { apiKey: token, baseURL: endpoint }, models: { [model]: {
        id: model, name: model, attachment: supportsImages, tool_call: true,
        ...(maxTokens === undefined && contextWindow === undefined ? {} : { limit: { context: contextWindow ?? 200000, output: maxTokens ?? 32000 } }),
        modalities: { input: supportsImages ? ["text", "image"] : ["text"], output: ["text"] },
      } } } },
      agent: { title: { disable: true }, build: { permission, ...(maxTurns === undefined ? {} : { steps: maxTurns }) } },
      permission, share: "disabled", autoupdate: false, snapshot: false,
    });
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    env.OPENCODE_PURE = "1";
    env.OPENCODE_WEBSEARCH_PROVIDER = "exa";
    if (toolPolicy.webSearch === "enabled") env.OPENCODE_ENABLE_EXA = "1";
    return { args: ["acp"], modeId: "build" };
  },
  run: acpRun,
});
