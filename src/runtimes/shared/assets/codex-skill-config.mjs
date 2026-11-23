import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

// Ask the CLI to resolve its own config layers and project trust rules.
export async function configuredMcpNames(executable, prefix, env, settings) {
  const { stdout } = await promisify(execFile)(executable, [...prefix, "mcp", "list", "--json", ...settings],
    { env, timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout).map(server => server.name);
}

// Both CLIs discover bundled and project skills themselves and accept only
// per-path exclusions. Query the same installation and attempt HOME used by exec.
export async function disabledSkillConfig(executable, prefix, env, settings) {
  const cwd = process.cwd();
  const child = spawn(executable, [...prefix, "app-server", ...settings], {
    cwd, env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  const timeout = setTimeout(() => child.kill(), 20000);
  const failure = new Promise((_, reject) => {
    child.once("error", reject);
    child.stdin.on("error", reject);
  });
  try {
    const query = async () => {
      send(1, "initialize", { clientInfo: { name: "evaluator", version: "1" } });
      for await (const line of output) {
        const message = JSON.parse(line);
        if (message.error) throw Error("Skill discovery failed: " + message.error.message);
        if (message.id === 1) send(2, "skills/list", { cwds: [cwd], forceReload: true });
        if (message.id !== 2) continue;
        const listing = message.result?.data?.find(item => item.cwd === cwd);
        if (!Array.isArray(listing?.skills) || listing.errors?.length) {
          throw Error("Incomplete skill list for " + cwd);
        }
        const paths = new Set(listing.skills.map(skill => skill.path));
        const entries = [...paths].map(path => {
          if (typeof path !== "string" || !path) throw Error("Skill discovery returned an invalid path");
          return "{path=" + JSON.stringify(path) + ",enabled=false}";
        });
        return "skills.config=[" + entries.join(",") + "]";
      }
      throw Error("App server closed before returning its skill list");
    };
    return await Promise.race([query(), failure]);
  } finally {
    clearTimeout(timeout);
    output.close();
    child.stdin.end();
    child.kill();
  }
}
