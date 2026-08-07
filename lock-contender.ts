import { acquireConnectionLock, releaseConnectionLock } from "./connection-lock.ts";

const lockPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? 400);
if (!lockPath) process.exit(2);

try {
  const lock = await acquireConnectionLock(lockPath, {
    sessionId: `contender-${process.pid}`,
    cwd: process.cwd(),
  });
  process.stdout.write("ACQUIRED\n");
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await releaseConnectionLock(lockPath, lock);
} catch (error: any) {
  if (error?.name === "FeishuConnectionBusyError") {
    process.stdout.write("BUSY\n");
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
