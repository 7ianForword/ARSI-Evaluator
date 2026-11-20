import { readFile } from "node:fs/promises";
import type { LoadedConfig } from "../config/loaded.js";
import type { ImageCleanupSummary } from "../core/contracts/image-cleanup.js";
import { formatError } from "../core/errors/diagnostics.js";
import { loadedConfigSecrets } from "./config.js";
import { cleanupImages as cleanInventory } from "./cleanup.js";
import { diagnoseExperiment as diagnoseConfig } from "./inspection.js";
import type { EvaluatorRunOptions } from "./run.js";

type ConfigOptions = Pick<EvaluatorRunOptions, "configPath" | "networkConfigPath" | "patchPath" | "env" | "signal">;
export type DoctorOptions = ConfigOptions & Pick<EvaluatorRunOptions, "overrides">;
export type DoctorReport = Awaited<ReturnType<typeof diagnoseConfig>>;
export type ImageCleanupOptions = ConfigOptions & {
  /** Preview by default. Execution is scoped to the configuration's inventory ownership. */
  execute?: boolean;
};

/** Maintenance may fail during config expansion, before the resolved credentials are available. */
async function withDiagnostics<T>(options: DoctorOptions, run: (signal: AbortSignal, loaded: (config: LoadedConfig) => void) => Promise<T>): Promise<T> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const env = options.env ?? process.env;
  const secrets = new Set<string>();
  try {
    return await run(signal, config => { for (const secret of loadedConfigSecrets(config)) secrets.add(secret); });
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

/** Run the same configuration and network probes as doctor and return their structured findings. */
export function diagnoseExperiment(options: DoctorOptions): Promise<DoctorReport> {
  return withDiagnostics(options, async (signal, onLoaded) => {
    const report = await diagnoseConfig({ ...options, file: options.configPath, overrides: options.overrides ?? {}, onLoaded }, signal, () => {});
    signal.throwIfAborted();
    return report;
  });
}

/** Inspect or release the image references owned by one experiment configuration. */
export async function cleanupImages(options: ImageCleanupOptions): Promise<ImageCleanupSummary> {
  if (options.execute !== undefined && typeof options.execute !== "boolean")
    throw new TypeError("cleanupImages execute must be a boolean");
  return withDiagnostics(options, (signal, onLoaded) => cleanInventory({
    file: options.configPath, all: false, execute: options.execute ?? false, signal, onLoaded,
    env: options.env ?? process.env,
    ...(options.patchPath !== undefined ? { patchPath: options.patchPath } : {}),
    ...(options.networkConfigPath !== undefined ? { networkConfigPath: options.networkConfigPath } : {}),
  }));
}
