import { chmodSync } from "node:fs";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export function secureEnvFileBeforeRead(file: string, platform = process.platform): void {
  if (platform === "win32") return;
  chmodSync(file, 0o600);
}

export async function secureSessionFile(file: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(file, 0o600);
  } catch (error) {
    // Pi reserves a session path before the first turn writes the JSONL file.
    // Creating that path here makes Pi treat it as an existing empty session,
    // which suppresses later model turns. The private 0700 parent directory
    // protects it until we chmod the file immediately after the first turn.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function secureSessionStorage(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await secureSessionStorage(path);
    else if (entry.isFile()) await secureSessionFile(path);
  }
}
