import { randomBytes } from "node:crypto";

/** Small local id helper so we do not depend on Prisma cuid generation in scripts. */
export function createId(prefix: "m" | "e" | "s" | "sn" = "m"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}
