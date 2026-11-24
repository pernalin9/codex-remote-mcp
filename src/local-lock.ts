import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const isBusy = (error: unknown) => (error as {errcode?: number})?.errcode === 5;

// A dedicated SQLite file provides an OS-released process lock. Keep the file
// in place so competing processes always contend on the same inode.
export function acquireLocalLock(file: string, busyMessage: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (error) {
    db.close();
    if (isBusy(error)) throw new Error(busyMessage);
    throw error;
  }
  return () => db.close();
}

export function isLocalLockHeld(file: string) {
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    db.exec("PRAGMA busy_timeout=0; SELECT 1 FROM sqlite_master LIMIT 1;");
    return false;
  } catch (error) {
    if (isBusy(error)) return true;
    throw error;
  } finally { db.close(); }
}
