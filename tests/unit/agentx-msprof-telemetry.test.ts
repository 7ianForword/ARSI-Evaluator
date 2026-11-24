import { expect, test } from "vitest";
import { parseMsprofConfig, parseMsprofOutput } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/msprof-telemetry.js";
import { parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";

test("msprof telemetry config is opt-in and validates device identity", () => {
  expect(parseAgentXReplayConfig({}).telemetry).toBeUndefined();
  const config = { telemetry: { msprof: { devices: [{ deviceId: 0 }, { deviceId: 1 }] } } };
  const parsed = parseAgentXReplayConfig(config);
  expect(parsed.telemetry?.msprof).toBeDefined();
  expect(parsed.telemetry?.msprof?.devices).toEqual([{ deviceId: 0 }, { deviceId: 1 }]);
  expect(parsed.telemetry?.msprof?.freqHz).toBe(10);
  expect(parsed.telemetry?.msprof?.metrics).toBe("ArithmeticUtilization");
  expect(parsed.telemetry?.msprof?.includeHbm).toBe(false);
  for (const bad of [{}, { devices: [] }, { devices: [{ deviceId: -1 }] },
    { devices: [{ deviceId: 0 }, { deviceId: 0 }] }, { devices: [{ deviceId: 0 }], freqHz: 0 },
    { devices: [{ deviceId: 0 }], freqHz: 101 }, { devices: [{ deviceId: 0, chipId: 0 }], unknownField: true }])
    expect(() => parseAgentXReplayConfig({ telemetry: { msprof: bad } })).toThrow();
});

test("msprof summary validates mac_fp16_ratio bounds and schema version", () => {
  const valid = {
    status: "completed",
    summary: {
      schemaVersion: 1, kind: "profiling-summary",
      aggregate: { device_count: 2, mac_fp16_ratio_mean: 0.109 },
      devices: {
        "0": { mac_fp16_ratio: 0.1096, mac_int8_ratio: 0.0, samples: 21 },
        "1": { mac_fp16_ratio: 0.1090, mac_int8_ratio: null, samples: 21 },
      },
      availability: { mac_fp16_ratio: "interpretable" },
      csv_parse_errors: [],
    },
    window: { tag: "agentx", period_sec: 3600 },
  };
  const result = parseMsprofOutput(JSON.stringify(valid));
  expect(result.status).toBe("completed");
  expect(result.summary?.aggregate.mac_fp16_ratio_mean).toBe(0.109);
  expect(result.summary?.devices["0"]?.mac_fp16_ratio).toBe(0.1096);
  for (const ratio of [-0.01, 1.01, NaN, "0.5"]) {
    const bad = { ...valid, summary: { ...valid.summary, devices: { "0": { mac_fp16_ratio: ratio, samples: 1 } } } };
    expect(() => parseMsprofOutput(JSON.stringify(bad))).toThrow();
  }
  const badSchema = { ...valid, summary: { ...valid.summary, schemaVersion: 2 } };
  expect(() => parseMsprofOutput(JSON.stringify(badSchema))).toThrow();
});

test("msprof error and empty outputs produce error result without throwing", () => {
  expect(parseMsprofOutput("").status).toBe("error");
  expect(parseMsprofOutput(JSON.stringify({ status: "error", code: "msprof_binary_missing" })).status).toBe("error");
  expect(parseMsprofOutput("not json\nat all")).toBeDefined();
});
