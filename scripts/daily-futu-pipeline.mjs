import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadDotenv(path.join(root, ".env"));

const env = {
  ...process.env,
  FUTU_USE_OPTION_VOLUME_UNIVERSE: process.env.FUTU_USE_OPTION_VOLUME_UNIVERSE || "1",
  FUTU_OPTION_SCREEN_CONTRACTS: process.env.FUTU_OPTION_SCREEN_CONTRACTS || "500",
  FUTU_MAX_SYMBOLS: process.env.FUTU_MAX_SYMBOLS || "5"
};

const futuAppData = path.join(root, ".futu-appdata");
mkdirSync(futuAppData, { recursive: true });
env.APPDATA = env.APPDATA || futuAppData;

await run("python", ["scripts/scan_futu.py"], env);
await runOptional("node", ["scripts/ai-analyze.mjs"], env);
// Backtest is temporarily disabled. Keep scripts/backtest_futu.py for later use.

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

async function runOptional(command, args, envVars) {
  try {
    await run(command, args, envVars);
  } catch (error) {
    console.warn(`Optional step failed: ${error.message}`);
  }
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
