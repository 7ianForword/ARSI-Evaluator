import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LoadedConfig } from "../config/loaded.js";
import type { ImageCleanupSummary } from "../core/contracts/image-cleanup.js";
import { formatError } from "../core/errors/diagnostics.js";
import { cleanupImages } from "./cleanup.js";
import { loadedConfigSecrets } from "./config.js";
import { diagnoseExperiment } from "./inspection.js";
import { rebuildReport } from "./report/index.js";
import { executeExperiment, type EvaluationResult, type EvaluatorRunOptions } from "./run.js";

export type { EvaluationResult, EvaluatorRunOptions } from "./run.js";

type ConfigOptions = Pick<EvaluatorRunOptions, "configPath" | "networkConfigPath" | "patchPath" | "env" | "signal">;
export type DoctorOptions = ConfigOptions & Pick<EvaluatorRunOptions, "overrides">;
export type DoctorReport = Awaited<ReturnType<typeof diagnoseExperiment>>;
export type CleanupOptions = ConfigOptions & {
  /** Preview by default. Execution is scoped to the configuration's inventory ownership. */
  execute?: boolean;
};

/** A failed application operation, possibly with a persisted partial run. */
export class EvaluatorRunError extends Error {
  constructor(
    message: string,
    readonly phase: string,
    readonly exitCode: number,
    readonly result: EvaluationResult | null,
    options: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EvaluatorRunError";
  }
}

/** Each call owns its registry and resources; instances hold no process-wide state. */
export class Evaluator {
  async run(options: EvaluatorRunOptions): Promise<EvaluationResult> {
    const outcome = await executeExperiment(options);
    if (outcome.diagnostics.length || !outcome.result) {
      const first = outcome.diagnostics[0];
      const causes = outcome.diagnostics.map(item => new Error(formatError(item.error, outcome.secrets)));
      throw new EvaluatorRunError(causes[0]?.message ?? "Evaluation did not create a run",
        first?.phase ?? "config", outcome.exitCode, outcome.result,
        { cause: causes.length === 1 ? causes[0] : new AggregateError(causes, "Evaluation operation failed") });
    }
    return outcome.result;
  }

  async report(runDirectory: string): Promise<string> {
    const directory = resolve(runDirectory);
    await rebuildReport(directory);
    return join(directory, "report.md");
  }

  /** Run configuration and network checks and return their individual results. */
  doctor(options: DoctorOptions): Promise<DoctorReport> {
    return withDiagnostics(options, async (signal, onLoaded) => {
      const report = await diagnoseExperiment({
        ...options, file: options.configPath, overrides: options.overrides ?? {}, onLoaded,
      }, signal, () => {});
      signal.throwIfAborted();
      return report;
    });
  }

  /** Preview or release the image references owned by one experiment configuration. */
  async cleanup(options: CleanupOptions): Promise<ImageCleanupSummary> {
    if (options.execute !== undefined && typeof options.execute !== "boolean")
      throw new TypeError("cleanup.execute must be a boolean");
    return withDiagnostics(options, (signal, onLoaded) => cleanupImages({
      file: options.configPath, all: false, execute: options.execute ?? false, signal, onLoaded,
      env: options.env ?? process.env,
      ...(options.patchPath !== undefined ? { patchPath: options.patchPath } : {}),
      ...(options.networkConfigPath !== undefined ? { networkConfigPath: options.networkConfigPath } : {}),
    }));
  }
}

/** Config expansion can fail before the resolved credentials are available for redaction. */
async function withDiagnostics<T>(
  options: DoctorOptions,
  run: (signal: AbortSignal, onLoaded: (config: LoadedConfig) => void) => Promise<T>,
): Promise<T> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const env = options.env ?? process.env;
  const secrets = new Set<string>();
  try {
    return await run(signal, config => {
      for (const secret of loadedConfigSecrets(config)) secrets.add(secret);
    });
  } catch (error) {
    signal.throwIfAborted();
    for (const [name, value] of Object.entries(env))
      if (value && /key|token|secret|password|credential|authorization/i.test(name)) secrets.add(value);
    if (options.overrides?.apiKey) secrets.add(options.overrides.apiKey);
    const overrideKey = options.overrides?.apiKeyEnv;
    if (overrideKey && env[overrideKey]) secrets.add(env[overrideKey]);
    for (const path of [options.configPath, options.networkConfigPath]) {
      if (!path) continue;
      const input = await readFile(path, { encoding: "utf8", signal }).catch(() => "");
      for (const match of input.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const value = env[match[1]!];
        if (value) secrets.add(value);
      }
    }
    signal.throwIfAborted();
    throw new Error(formatError(error, [...secrets].sort((a, b) => b.length - a.length)));
  }
}
