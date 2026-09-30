import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("extension routes model commands before prompting and guards shared/queued/restored conversations", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/model-command-routing.ts", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    if (code !== 0) throw new Error(output);
    expect(output).toContain("Model command routing, busy guards, chat isolation and restart restoration verified.");
  } finally {
    clearTimeout(timer);
  }
});
