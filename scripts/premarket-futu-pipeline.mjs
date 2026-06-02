import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadDotenv(path.join(root, ".env"));

const env = { ...process.env };
const futuAppData = path.join(root, ".futu-appdata");
mkdirSync(futuAppData, { recursive: true });
env.APPDATA = env.APPDATA || futuAppData;

await run("python", ["scripts/premarket_futu.py"], env);
await run("node", ["scripts/ai-analyze.mjs"], env);

function run(command, args, envVars) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: envVars,
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function loadDotenv(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] ??= rest.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
}
