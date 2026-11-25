import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentXAssets } from "../../../../../runtimes/agentx/runtime.js";
import { expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";

/** msprof service-level profiling config (opt-in, alongside vllm/ascend telemetry). */
export type MsprofConfig = {
  devices: { deviceId: number }[];
  freqHz: number;
  metrics: string;
  includeHbm: boolean;
  /** vLLM metrics endpoint used to detect when the measurement traffic starts. */
  metricsUrl?: string;
  /** When true, the helper waits for sustained serving traffic before collecting. */
  waitForTraffic?: boolean;
};

/** Parsed profiling summary emitted by msprof_service.py (profiling-summary v1). */
export type MsprofSummary = {
  schemaVersion: 1;
  kind: "profiling-summary";
  requestedDevices?: number[];
  aggregate: { device_count: number; mac_fp16_ratio_mean: number | null };
  devices: Record<string, { mac_fp16_ratio: number; mac_int8_ratio: number | null; samples: number }>;
  availability: Record<string, string>;
  csv_parse_errors: string[];
  sqlite_devices?: Record<string, number>;
};

export type MsprofResult = { status: "completed" | "error"; summary?: MsprofSummary; window?: Record<string, unknown>; code?: string; detail?: string };

/** Stoppable collection handle; `stop` also reclaims the helper process tree. */
export type MsprofCollection = {
  requestedDevices: number[];
  result: Promise<MsprofResult>;
  stop(): Promise<void>;
};

/** Fill only missing traffic-detection fields from solver context. */
export function resolveMsprofSettings(config: MsprofConfig, inferredMetricsUrl?: string): MsprofConfig {
  if (config.metricsUrl !== undefined || inferredMetricsUrl === undefined) return config;
  return { ...config, metricsUrl: inferredMetricsUrl,
    ...(config.waitForTraffic === undefined ? { waitForTraffic: true } : {}) };
}

export function parseMsprofConfig(value: unknown): MsprofConfig {
  const raw = expectRecord(value, "telemetry.msprof");
  rejectUnknown(raw, ["devices", "freqHz", "metrics", "includeHbm", "metricsUrl", "waitForTraffic"], "telemetry.msprof");
  if (!Array.isArray(raw.devices) || !raw.devices.length)
    throw new TypeError("msprof telemetry requires at least one device");
  const seen = new Set<number>();
  const devices = raw.devices.map(entry => {
    const device = expectRecord(entry, "telemetry.msprof.devices entry");
    rejectUnknown(device, ["deviceId"], "telemetry.msprof.devices entry");
    const deviceId = typeof device.deviceId === "number" && Number.isSafeInteger(device.deviceId) && device.deviceId >= 0
      ? device.deviceId : (() => { throw new TypeError("Invalid msprof deviceId"); })();
    if (seen.has(deviceId)) throw new TypeError("Duplicate msprof deviceId");
    seen.add(deviceId);
    return { deviceId };
  });
  const freqHz = raw.freqHz === undefined ? 10 : (() => {
    if (typeof raw.freqHz !== "number" || !Number.isInteger(raw.freqHz) || raw.freqHz < 1 || raw.freqHz > 100)
      throw new TypeError("Invalid msprof freqHz: must be integer 1-100");
    return raw.freqHz;
  })();
  const metrics = typeof raw.metrics === "string" && raw.metrics.length ? raw.metrics : "ArithmeticUtilization";
  const includeHbm = raw.includeHbm === true;
  const metricsUrl = raw.metricsUrl === undefined ? undefined : (() => {
    if (typeof raw.metricsUrl !== "string") throw new TypeError("Invalid msprof metricsUrl");
    const parsed = new URL(raw.metricsUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new TypeError("Invalid msprof metricsUrl: must be http(s)");
    return raw.metricsUrl;
  })();
  const waitForTraffic = raw.waitForTraffic === true;
  return { devices, freqHz, metrics, includeHbm, waitForTraffic, ...(metricsUrl === undefined ? {} : { metricsUrl }) };
}

export function parseMsprofSummary(value: unknown): MsprofSummary {
  const raw = expectRecord(value, "msprof summary");
  rejectUnknown(raw, ["schemaVersion", "kind", "requestedDevices", "aggregate", "devices", "availability", "csv_parse_errors", "sqlite_devices"], "msprof summary");
  if (raw.schemaVersion !== 1 || raw.kind !== "profiling-summary")
    throw new TypeError("Invalid msprof summary schema");
  if (raw.requestedDevices !== undefined) {
    const requested = raw.requestedDevices;
    if (!Array.isArray(requested) || !requested.length ||
        requested.some(entry => typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0))
      throw new TypeError("Invalid msprof requestedDevices");
  }
  const aggregate = expectRecord(raw.aggregate, "msprof summary aggregate");
  rejectUnknown(aggregate, ["device_count", "mac_fp16_ratio_mean"], "msprof summary aggregate");
  if (typeof aggregate.device_count !== "number" || !Number.isSafeInteger(aggregate.device_count) || aggregate.device_count < 0)
    throw new TypeError("Invalid msprof aggregate device_count");
  const mean = aggregate.mac_fp16_ratio_mean;
  if (mean !== null && (typeof mean !== "number" || !Number.isFinite(mean) || mean < 0 || mean > 1))
    throw new TypeError("Invalid msprof aggregate mac_fp16_ratio_mean");
  const devices = expectRecord(raw.devices, "msprof summary devices");
  for (const entry of Object.values(devices)) {
    const device = expectRecord(entry, "msprof device entry");
    rejectUnknown(device, ["mac_fp16_ratio", "mac_int8_ratio", "samples"], "msprof device entry");
    if (typeof device.mac_fp16_ratio !== "number" || !Number.isFinite(device.mac_fp16_ratio) || device.mac_fp16_ratio < 0 || device.mac_fp16_ratio > 1)
      throw new TypeError("Invalid msprof mac_fp16_ratio");
    if (device.mac_int8_ratio !== null && (typeof device.mac_int8_ratio !== "number" || !Number.isFinite(device.mac_int8_ratio) || device.mac_int8_ratio < 0 || device.mac_int8_ratio > 1))
      throw new TypeError("Invalid msprof mac_int8_ratio");
    if (typeof device.samples !== "number" || !Number.isSafeInteger(device.samples) || device.samples <= 0)
      throw new TypeError("Invalid msprof samples");
  }
  const availability = expectRecord(raw.availability, "msprof summary availability");
  if (Object.values(availability).some(value => typeof value !== "string"))
    throw new TypeError("Invalid msprof summary availability");
  if (!Array.isArray(raw.csv_parse_errors) || raw.csv_parse_errors.some(error => typeof error !== "string"))
    throw new TypeError("Invalid msprof csv_parse_errors");
  if (raw.sqlite_devices !== undefined) {
    const sqliteDevices = expectRecord(raw.sqlite_devices, "msprof summary sqlite_devices");
    if (Object.values(sqliteDevices).some(value => typeof value !== "number" || !Number.isFinite(value)))
      throw new TypeError("Invalid msprof sqlite_devices");
  }
  return raw as unknown as MsprofSummary;
}

/** Parse the helper's terminal stdout JSON (last non-empty line). */
export function parseMsprofOutput(stdout: string): MsprofResult {
  const lines = stdout.trim().split(/\r?\n/u).filter(line => line.trim() !== "");
  if (!lines.length) return { status: "error", code: "no_output" };
  let terminal: unknown;
  try { terminal = JSON.parse(lines[lines.length - 1]!); } catch { return { status: "error", code: "malformed_output" }; }
  const parsed = terminal as Record<string, unknown>;
  if (parsed.status === "completed") {
    return { status: "completed", summary: parseMsprofSummary(parsed.summary), window: parsed.window as Record<string, unknown> };
  }
  return { status: "error", code: typeof parsed.code === "string" ? parsed.code : "unknown" };
}

/** Helper ships with the packaged AgentX runtime assets (dist). */
export function helperPath(): string {
  return join(agentXAssets, "msprof_service.py");
}

/** Build the terminal result from helper exit state; prefers structured error JSON. */
export function settleHelperResult(exitCode: number | null, stdout: string, stderr: string): MsprofResult {
  const parsed = parseMsprofOutput(stdout);
  const structural = parsed.status === "error" && !["no_output", "malformed_output"].includes(parsed.code ?? "");
  if (exitCode === 0 || structural) return parsed;
  const detail = stderr.replace(/\s+/gu, " ").trim().slice(0, 500);
  return { status: "error", code: exitCode === null ? "helper_exit_unknown" : `msprof_exit_${exitCode}`,
    ...(detail ? { detail } : {}) };
}

/** Spawn the one-shot msprof helper; `result` settles when collection + parsing finishes. */
export function startMsprofCollection(
  config: MsprofConfig, artifacts: string, periodSec: number, signal: AbortSignal,
  pythonExecutable?: string,
): MsprofCollection {
  const helper = helperPath();
  const python = pythonExecutable ?? "python3";
  const stopFile = join(artifacts, "msprof", "STOP");
  const helperConfig = {
    devices: config.devices.map(device => device.deviceId),
    freqHz: config.freqHz,
    metrics: config.metrics,
    includeHbm: config.includeHbm,
    periodSec,
    ...(config.metricsUrl === undefined ? {} : { metricsUrl: config.metricsUrl }),
    ...(config.waitForTraffic === undefined ? {} : { waitForTraffic: config.waitForTraffic }),
  };
  let settled = false;
  let resolveResult!: (value: MsprofResult) => void;
  const result = new Promise<MsprofResult>(resolve => { resolveResult = resolve; });
  const settle = (value: MsprofResult) => { if (!settled) { settled = true; resolveResult(value); } };
  let stdout = "", stderr = "";
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(python, ["-B", "-u", helper,
      "--config", JSON.stringify(helperConfig), "--artifacts", artifacts],
      { stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
  } catch (error) {
    settle({ status: "error", code: error instanceof Error ? error.message : "spawn_failed" });
  }
  if (child) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child!.kill("SIGTERM"); });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error: Error) => settle({ status: "error", code: error.message }));
    child.on("close", (code: number | null) => {
      try {
        settle(settleHelperResult(code, stdout, stderr));
      } catch (error) {
        settle({ status: "error", code: error instanceof Error ? error.message : "parse_failed" });
      }
    });
  }
  return {
    requestedDevices: helperConfig.devices,
    result,
    async stop() {
      if (stopped || settled) return;
      stopped = true;
      await mkdir(join(artifacts, "msprof"), { recursive: true }).catch(() => undefined);
      await writeFile(stopFile, `${new Date().toISOString()}\n`, "utf8").catch(() => undefined);
      if (!settled && child?.pid) child.kill("SIGTERM");
      const hardKill = setTimeout(() => { if (!settled) child?.kill("SIGKILL"); }, 15000);
      hardKill.unref?.();
      try { await result; } finally { clearTimeout(hardKill); }
    },
  };
}
