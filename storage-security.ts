import { chmodSync } from "node:fs";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export function secureEnvFileBeforeRead(file: string, platform = process.platform): void {
  if (platform === "win32") return;
  chmodSync(file, 0o600);
}

export async function secureSessionFile(file: string): Promise<void> {
  await chmod(file, 0o600);
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
