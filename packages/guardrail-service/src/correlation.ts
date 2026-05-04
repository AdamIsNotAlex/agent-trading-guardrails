import { randomUUID } from "node:crypto";

export function generateCorrelationId(): string {
  return randomUUID();
}
