import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { nativeCodeInstallation, nativeCodeVersions, type NativeCodeName } from "../../src/runtimes/shared/native-code-runtime.js";
import { nativeCodeModel } from "../fixtures/native-code-model.js";

const names = ["qwencode", "kimicode", "minimaxcode", "opencode"] as const;
const enabled = process.env.EVALUATOR_NATIVE_CODE_TEST === "local";

async function run(name: NativeCodeName, api: string, toolPolicy: object, mode: "answer" | "read" | "loop" | "discover-fetch" = "answer", maxTurns = 4) {
  const root = resolve(process.env.EVALUATOR_NATIVE_CODE_ROOT ?? ".scratch/new-code-runtimes", name);
  const installation = await nativeCodeInstallation(name, new AbortController().signal);
  for (const file of installation.files.filter(file => !file.target.startsWith("package"))) {
    const target = join(root, file.target);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.source, target);
  }
  const workspace = await mkdtemp(join(tmpdir(), "native-code-smoke-"));
  const mock = await nativeCodeModel(mode, "127.0.0.1", join(workspace, "input.txt"));
  try {
    await writeFile(join(workspace, "input.txt"), "TOOL_EVIDENCE");
    const input = { apiKey: "fixture-upstream-secret", token: "fixture-relay-token", baseUrl: mock.endpoint, model: "fixture-model", api,
      reasoningEffort: "low", maxTokens: 70000, maxTurns, supportsImages: true, toolPolicy,
      prompt: mode === "answer" ? "Describe the image." : "Read input.txt then answer.",
      media: [{ mediaType: "image/png", data: (await readFile(new URL("../fixtures/multimodal/figure.png", import.meta.url))).toString("base64") }] };
    const child = spawn(process.execPath, [join(root, "launch.mjs"), join(workspace, "state")], { cwd: workspace, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      else child.kill("SIGTERM");
    }, 30000);
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("close", code => resolveExit(code)); });
    clearTimeout(timer);
    await writeFile(join(root, `smoke-${api}-${mode}.json`), JSON.stringify({ stdout, stderr, requests: mock.requests }, null, 2));
    console.info(`${name}/${api}/${mode}: exit=${code}, requests=${mock.requests.length}`);
    const events = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const result = events.find(event => event.type === "evaluator.result");
    return { code, result, requests: mock.requests, diagnostic: stdout.slice(-1500) + stderr.slice(-1500), stdout };
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

for (const name of names) {
  test.skipIf(!enabled)(`${name} ${nativeCodeVersions[name]} transmits images without tools over all supported APIs`, async () => {
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
      const result = await run(name, api, { tools: "none", webSearch: "disabled", webFetch: "disabled" });
      expect(result.code, `${api}: ${result.diagnostic}`).toBe(0);
      expect(result.result).toMatchObject({ finalText: "The answer is 42." });
      expect(result.requests.length).toBeGreaterThan(0);
      for (const request of result.requests) {
        expect(request.model).toBe("fixture-model");
        expect(request.tools ?? []).toHaveLength(0);
        expect(request.max_tokens ?? request.max_completion_tokens ?? request.max_output_tokens).toBe(70000);
        expect(request).toMatchObject(api === "openai-completions" ? { reasoning_effort: "low" }
          : api === "openai-responses" ? { reasoning: { effort: "low" } } : { output_config: { effort: "low" } });
      }
      expect(JSON.stringify(result.requests)).toMatch(/image_url|input_image|"type":"image"/u);
      expect(result.stdout).not.toContain("fixture-upstream-secret");
      expect(result.result.usage.inputTokens).toBeGreaterThan(0);
    }
  }, 190000);

  test.skipIf(!enabled)(`${name} keeps file tools while disabling native web tools`, async () => {
    const result = await run(name, "openai-completions", { webSearch: "disabled", webFetch: "disabled" }, "read");
    expect(result.code, result.diagnostic).toBe(0);
    expect(result.result.finalText).toBe("The answer is 42.");
    expect(JSON.stringify(result.requests)).toContain("TOOL_EVIDENCE");
    const tools = result.requests.flatMap(request => request.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? "");
    expect(tools).toContainEqual(expect.stringMatching(/^(?:read|Read|read_file)$/u));
    expect(tools.filter(tool => /web[_]?(?:fetch|search)|FetchURL|WebSearch/iu.test(tool))).toEqual([]);
  }, 70000);

  test.skipIf(!enabled)(`${name} applies the native model-step limit`, async () => {
    const result = await run(name, "openai-completions", { webSearch: "disabled", webFetch: "disabled" }, "loop", 1);
    const modelRequests = result.requests.filter(request => request.tools?.length);
    expect(modelRequests.length, result.diagnostic).toBeGreaterThan(0);
    expect(modelRequests.length, result.diagnostic).toBeLessThanOrEqual(2);
  }, 70000);

  test.skipIf(!enabled)(`${name} enables native fetch independently of search`, async () => {
    const result = await run(name, "openai-completions", { webSearch: "disabled", webFetch: "enabled" }, "discover-fetch");
    expect(result.code, result.diagnostic).toBe(0);
    const tools = result.requests.flatMap(request => request.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? "");
    if (name === "qwencode") expect(JSON.stringify(result.requests)).toMatch(/web_fetch[\s\S]*url/u);
    else expect(tools).toContainEqual(expect.stringMatching(/^(?:web_fetch|webfetch|FetchURL)$/u));
    expect(tools.filter(tool => /^(?:web_search|websearch|WebSearch)$/u.test(tool))).toEqual([]);
  }, 70000);
}

test.skipIf(!enabled)("OpenCode enables Exa search on custom model services while fetch remains disabled", async () => {
  const result = await run("opencode", "openai-completions", { webSearch: "enabled", webFetch: "disabled" });
  expect(result.code, result.diagnostic).toBe(0);
  const tools = result.requests.flatMap(request => request.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? "");
  expect(tools).toContain("websearch");
  expect(tools).not.toContain("webfetch");
}, 70000);
