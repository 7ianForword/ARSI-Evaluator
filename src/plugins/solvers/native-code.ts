import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { EnvironmentSession, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { ServiceBinding } from "../../core/contracts/plugin.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { expectPositiveInteger, expectRecord } from "../../core/validation/input.js";
import { parseSolverToolPolicy, toolPolicyProvenance, unsupportedToolPolicy, type SolverToolPolicy } from "../../core/validation/solver-tool-policy.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";
import { consumeNativeCode } from "../../runtimes/shared/native-code-protocol.js";
import { nativeCodeInstallation, nativeCodeVersions, type NativeCodeName } from "../../runtimes/shared/native-code-runtime.js";

export type NativeCodeConfig = SolverToolPolicy & { maxTurns?: number };

export function parseNativeCodeConfig(name: NativeCodeName, value: unknown): NativeCodeConfig {
  const config = expectRecord(value, `${name} config`);
  return {
    ...parseSolverToolPolicy(config, `${name} config`, ["maxTurns"]),
    ...(config.maxTurns === undefined ? {} : { maxTurns: expectPositiveInteger(config.maxTurns, `${name} config.maxTurns`) }),
  };
}

function apiBase(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/(?:chat\/completions|responses|messages)\/*$/u.test(url.pathname)) {
    throw new TypeError("Code CLI solvers require an HTTP(S) base_url without credentials, query, fragment or API method path");
  }
  return url.href.replace(/\/+$/u, "");
}

/** Four independent native CLIs share only Evaluator's process/attachment plumbing. */
export class NativeCodeSolver implements Solver {
  readonly inputModalities = ["text", "image"] as const;
  private readonly endpoint: string;

  constructor(private readonly name: NativeCodeName, private readonly binding: ServiceBinding, private readonly config: NativeCodeConfig = {}) {
    const { model } = binding;
    if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(model.api ?? "")) {
      throw new TypeError(`${name} requires api: openai-completions, openai-responses or anthropic-messages`);
    }
    if (model.retry !== undefined) throw new TypeError(`${name} does not support services.*.retry`);
    this.endpoint = apiBase(model.endpoint);
    // Native search needs backend-specific settings and authentication,
    // which this model-only service binding does not configure.
    if (config.webSearch === "enabled" && name !== "opencode") {
      unsupportedToolPolicy(name, "native web search requires a vendor search service; the selected model service does not configure one");
    }
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = (signal: AbortSignal) => nativeCodeInstallation(this.name, signal);

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    const { maxTurns, ...policy } = this.config;
    return { ...toolPolicyProvenance(policy, `${this.name}-native-model-relay`), harnessVersion: nativeCodeVersions[this.name],
      harnessEntry: this.name === "minimaxcode" ? "exec" : "acp",
      ...(maxTurns === undefined ? {} : { maxTurns: String(maxTurns) }) };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    context.signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) throw new EvaluatorError("MODEL_AUTH_FAILED", `${this.name} requires a non-empty, single-line API key`);
    if (input.skillsDirectories?.length || input.mcpServers?.length) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", `${this.name} does not yet support task-provided skills or MCP servers`);
    }
    if (input.attachments?.some(attachment => attachment.kind === "pdf" && attachment.mode === "native")) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", `${this.name} requires PDF attachments in pages mode`);
    }
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", `${this.name} requires an environment-prepared runtime with writable state`);
    const path = runtime.persistent ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const token = randomUUID();
    const media = await loadAttachments(input, session, context);
    const mapping = session.modelEndpoint;
    const baseUrl = mapping?.originEndpoint === model.endpoint ? apiBase(mapping.baseUrl) : this.endpoint;
    try {
      const handle = await session.start({
        executable: runtime.persistent ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home], cwd: session.workdir, inheritEnv: false,
        env: { NODE_USE_ENV_PROXY: "1" },
        input: Buffer.from(JSON.stringify({ apiKey: auth.value, api: model.api, baseUrl, model: model.name,
          maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort,
          toolPolicy: this.config, maxTurns: this.config.maxTurns, prompt: input.prompt,
          supportsImages: model.inputModalities?.includes("image") ?? false, token, media }), "utf8"),
      }, context.signal);
      return await consumeNativeCode(this.name, handle, context, [auth.value, token]);
    } finally {
      if (runtime.persistent) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: `Could not remove temporary ${this.name} state` });
      });
    }
  }
}
