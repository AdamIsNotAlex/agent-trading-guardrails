import type { ApprovalRequest, ApprovalState } from "./interfaces.js";
import type { ApprovalStore } from "./store.js";

const APPROVAL_STATES = ["pending", "approved", "denied", "timeout", "consumed"] as const;

export type ApprovalCliCommand =
  | { type: "list"; state?: ApprovalState }
  | { type: "show"; approvalId: string }
  | { type: "approve"; approvalId: string; decidedBy: string }
  | { type: "deny"; approvalId: string; decidedBy: string }
  | { type: "watch" };

export interface ParsedApprovalArgs {
  dbPath?: string;
  help: boolean;
  command?: ApprovalCliCommand;
}

export type ApprovalWatchErrorHandler = (error: unknown) => void;

export function usage(): string {
  return [
    "Usage:",
    "  approval list [--state STATE] [--db PATH]",
    "  approval show <id> [--db PATH]",
    "  approval approve <id> --by <operator> [--db PATH]",
    "  approval deny <id> --by <operator> [--db PATH]",
    "  approval watch [--db PATH]",
  ].join("\n");
}

export function parseApprovalArgs(argv: string[]): ParsedApprovalArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let dbPath: string | undefined;
  let help = false;
  const rest: string[] = [];

  for (let index = 0; index < args.length; ) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      index += 1;
      continue;
    }
    if (arg === "--db" || arg.startsWith("--db=")) {
      const parsed = readOption(args, index, "db");
      dbPath = parsed.value;
      index = parsed.next;
      continue;
    }
    rest.push(arg);
    index += 1;
  }

  if (help) return { dbPath, help: true };
  if (rest.length === 0) return { dbPath, help: false };

  const [commandName, ...commandArgs] = rest;
  switch (commandName) {
    case "help":
      return { dbPath, help: true };
    case "list":
      return { dbPath, help: false, command: parseListCommand(commandArgs) };
    case "show":
      return {
        dbPath,
        help: false,
        command: { type: "show", approvalId: parseSingleId(commandArgs, "show") },
      };
    case "approve":
      return { dbPath, help: false, command: parseDecisionCommand("approve", commandArgs) };
    case "deny":
      return { dbPath, help: false, command: parseDecisionCommand("deny", commandArgs) };
    case "watch":
      if (commandArgs.length > 0) throw new Error("watch does not accept additional arguments.");
      return { dbPath, help: false, command: { type: "watch" } };
    default:
      throw new Error(`Unknown approval command: ${commandName}`);
  }
}

export class ApprovalCli {
  constructor(private store: ApprovalStore) {}

  list(state?: ApprovalState): string {
    this.store.checkTimeouts();
    return this.formatRequests(this.store.list(state ? { state } : undefined));
  }

  show(approvalId: string): string {
    this.store.checkTimeouts();
    const request = this.requireRequest(approvalId);
    return JSON.stringify(request, null, 2);
  }

  approve(approvalId: string, decidedBy: string): string {
    this.requireOperator(decidedBy);
    this.store.checkTimeouts();
    this.requireRequest(approvalId);
    const result = this.store.approve(approvalId, decidedBy);
    if (result) return `Approved ${approvalId} by ${decidedBy}.`;
    throw this.decisionFailure(approvalId, "approve");
  }

  deny(approvalId: string, decidedBy: string): string {
    this.requireOperator(decidedBy);
    this.store.checkTimeouts();
    this.requireRequest(approvalId);
    const result = this.store.deny(approvalId, decidedBy);
    if (result) return `Denied ${approvalId} by ${decidedBy}.`;
    throw this.decisionFailure(approvalId, "deny");
  }

  watch(
    callback: (message: string) => void,
    onError?: ApprovalWatchErrorHandler,
    intervalMs?: number,
  ): () => void {
    const resolvedIntervalMs = intervalMs ?? 2000;
    if (!Number.isInteger(resolvedIntervalMs) || resolvedIntervalMs <= 0) {
      throw new Error("Watch interval must be a positive integer.");
    }
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      try {
        this.store.checkTimeouts();
        const pending = this.store.list({ state: "pending" });
        if (pending.length > 0) {
          callback(`${pending.length} pending approval(s):\n${this.formatRequests(pending)}`);
        }
      } catch (error) {
        stopped = true;
        clearInterval(interval);
        if (!onError) throw error;
        onError(error);
      }
    };
    const interval = setInterval(tick, resolvedIntervalMs);
    try {
      tick();
    } catch (error) {
      clearInterval(interval);
      throw error;
    }
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  execute(command: Exclude<ApprovalCliCommand, { type: "watch" }>): string {
    switch (command.type) {
      case "list":
        return this.list(command.state);
      case "show":
        return this.show(command.approvalId);
      case "approve":
        return this.approve(command.approvalId, command.decidedBy);
      case "deny":
        return this.deny(command.approvalId, command.decidedBy);
    }
  }

  private formatRequests(requests: ApprovalRequest[]): string {
    if (requests.length === 0) return "No approval requests found.";
    return requests
      .map((request) => {
        const state = request.state.toUpperCase();
        const reason = `(${request.escalationReason})`;
        return [request.approvalId, state, request.action, request.resource, reason].join(" ");
      })
      .join("\n");
  }

  private requireRequest(approvalId: string) {
    if (!approvalId.trim()) throw new Error("Approval id must not be empty.");
    const request = this.store.get(approvalId);
    if (!request) throw new Error(`Approval ${approvalId} was not found.`);
    return request;
  }

  private requireOperator(decidedBy: string): void {
    if (!decidedBy.trim()) throw new Error("Operator id must not be empty.");
  }

  private decisionFailure(approvalId: string, action: "approve" | "deny"): Error {
    const request = this.store.get(approvalId);
    if (!request) return new Error(`Approval ${approvalId} was not found.`);
    if (request.state === "timeout") {
      return new Error(`Approval ${approvalId} timed out.`);
    }
    return new Error(`Cannot ${action} ${approvalId} because it is ${request.state}.`);
  }
}

function parseListCommand(args: string[]): Extract<ApprovalCliCommand, { type: "list" }> {
  let state: ApprovalState | undefined;
  for (let index = 0; index < args.length; ) {
    const arg = args[index];
    if (arg === "--state" || arg.startsWith("--state=")) {
      const parsed = readOption(args, index, "state");
      state = parseApprovalState(parsed.value);
      index = parsed.next;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown list option: ${arg}`);
    throw new Error("list does not accept positional arguments.");
  }
  return { type: "list", state };
}

function parseDecisionCommand(
  type: "approve" | "deny",
  args: string[],
): Extract<ApprovalCliCommand, { type: "approve" | "deny" }> {
  let decidedBy: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; ) {
    const arg = args[index];
    if (arg === "--by" || arg.startsWith("--by=")) {
      const parsed = readOption(args, index, "by");
      decidedBy = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown ${type} option: ${arg}`);
    positionals.push(arg);
    index += 1;
  }
  if (positionals.length !== 1) {
    throw new Error(`${type} requires a single approval id.`);
  }
  if (!decidedBy) throw new Error(`${type} requires --by <operator>.`);
  const approvalId = positionals[0];
  if (!approvalId?.trim()) throw new Error("Approval id must not be empty.");
  if (!decidedBy.trim()) throw new Error("Operator id must not be empty.");
  return { type, approvalId, decidedBy };
}

function parseSingleId(args: string[], command: string): string {
  if (args.length !== 1 || args.some((arg) => arg.startsWith("-"))) {
    throw new Error(`${command} requires a single approval id.`);
  }
  const approvalId = args[0];
  if (!approvalId?.trim()) throw new Error("Approval id must not be empty.");
  return approvalId;
}

function parseApprovalState(value: string): ApprovalState {
  if ((APPROVAL_STATES as readonly string[]).includes(value)) return value as ApprovalState;
  throw new Error(`Invalid approval state: ${value}`);
}

function readOption(args: string[], index: number, name: string): { value: string; next: number } {
  const current = args[index];
  if (current === `--${name}`) {
    const value = args[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`--${name} requires a value.`);
    return { value, next: index + 2 };
  }
  if (current.startsWith(`--${name}=`)) {
    const value = current.slice(name.length + 3);
    if (!value) throw new Error(`--${name} requires a value.`);
    return { value, next: index + 1 };
  }
  throw new Error(`Expected --${name}.`);
}
