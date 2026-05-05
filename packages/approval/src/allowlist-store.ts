import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AllowlistOnboardingEntry, AllowlistOnboardingStore } from "./interfaces.js";

export class JsonFileAllowlistOnboardingStore implements AllowlistOnboardingStore {
  constructor(private filePath: string) {}

  add(entry: AllowlistOnboardingEntry): () => void {
    const previousEntries = this.readEntries();
    const entries = [...previousEntries, entry];
    this.writeEntries(entries);
    return () => this.writeEntries(previousEntries);
  }

  private readEntries(): AllowlistOnboardingEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf8").trim();
    if (!content) return [];
    const parsed = JSON.parse(content) as AllowlistOnboardingEntry[];
    if (!Array.isArray(parsed)) {
      throw new Error("Allowlist onboarding file must contain a JSON array.");
    }
    return parsed;
  }

  private writeEntries(entries: AllowlistOnboardingEntry[]): void {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(tempPath, this.filePath);
  }
}
