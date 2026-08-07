import { chmodSync } from "node:fs";
import { chmod, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export function secureEnvFileBeforeRead(file: string, platform = process.platform): void {
  if (platform === "win32") return;
  chmodSync(file, 0o600);
}

export async function secureSessionFile(file: string): Promise<void> {
  // Pi allocates the persistent session path before the first JSONL record is
  // written. Materialize that path securely instead of assuming it exists.
  const handle = await open(file, "a", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
  } finally {
    await handle.close();
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
