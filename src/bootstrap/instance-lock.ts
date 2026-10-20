import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

/**
 * Refuses to start a second writer on this machine. A lock left by a dead
 * process, or by a different container hostname, is replaced. A live process
 * on this same host is not.
 */
export function acquireInstanceLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const host = hostname();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${host} ${process.pid}\n`);
      closeQuietly(fd);
      return () => {
        try { unlinkSync(lockPath); } catch { /* already released */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockHeldByLivePeer(lockPath, host)) {
        throw new Error(`Another YIBO process holds ${lockPath}. Run one instance only.`);
      }
      try { unlinkSync(lockPath); } catch { /* raced with the other starter */ }
    }
  }
  throw new Error(`Could not acquire instance lock ${lockPath}`);
}

function lockHeldByLivePeer(lockPath: string, host: string): boolean {
  let recorded = "";
  try { recorded = readFileSync(lockPath, "utf8"); } catch { return false; }
  const [recordedHost, pidText] = recorded.trim().split(/\s+/);
  const pid = Number(pidText);
  return recordedHost === host && Number.isInteger(pid) && pid > 0 && isAlive(pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function closeQuietly(fd: number): void {
  try { closeSync(fd); } catch { /* the lock file is already written */ }
}
