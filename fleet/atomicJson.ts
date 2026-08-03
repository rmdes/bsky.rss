import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function writePrivateJsonAtomic(path: string, value: unknown): void {
  const destinationPath = resolve(path);
  const parentDirectory = dirname(destinationPath);
  const randomSuffix = randomBytes(8).toString("hex");
  const tempPath = resolve(
    join(parentDirectory, `.${basename(destinationPath)}.${process.pid}.${randomSuffix}.tmp`)
  );
  let ownsTempPath = false;

  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw new TypeError("Value is not JSON-serializable");

    mkdirSync(parentDirectory, { recursive: true });
    const descriptor = openSync(tempPath, "wx", 0o600);
    ownsTempPath = true;
    try {
      writeFileSync(descriptor, `${serialized}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, destinationPath);
    ownsTempPath = false;
  } catch (error) {
    if (ownsTempPath) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Preserve the original write/rename failure.
      }
    }
    throw error;
  }
}
