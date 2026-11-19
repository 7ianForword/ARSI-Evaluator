import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";

export const nativeCodeVersions = { qwencode: "0.28.0", kimicode: "2.7.0", minimaxcode: "0.7.8", opencode: "1.19.6" } as const;
export type NativeCodeName = keyof typeof nativeCodeVersions;

export async function nativeCodeInstallation(name: NativeCodeName, signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const version = nativeCodeVersions[name];
  return {
    id: `${name}:${version}`, cacheName: `${name}-${version}`,
    files: [
      ...["package.json", "package-lock.json", "launch.mjs"].map(target => ({
        source: fileURLToPath(new URL(`../${name}/assets/${target}`, import.meta.url)), target,
      })),
      ...["native-code-launch.mjs", "model-relay.mjs"].map(target => ({
        source: fileURLToPath(new URL(`./assets/${target}`, import.meta.url)), target: `runtimes/shared/assets/${target}`,
      })),
      { source: fileURLToPath(new URL("../../infrastructure/models/reasoning-effort.mjs", import.meta.url)), target: "infrastructure/models/reasoning-effort.mjs" },
    ],
    commands: [
      { executable: "npm", args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] },
      ...(name === "minimaxcode" ? [
        { executable: "npm", args: ["rebuild", "better-sqlite3", "--no-audit", "--no-fund"] },
        { executable: "node", args: ["node_modules/@minimax-ai/code/verify-native-install.mjs"] },
      ] : []),
      ...(name === "opencode" ? [{ executable: "node", args: ["node_modules/opencode-ai/postinstall.mjs"] }] : []),
    ],
    probes: [{ executable: "node", args: ["launch.mjs", "--version", version] }],
  };
}
