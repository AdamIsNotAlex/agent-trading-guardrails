const SECRET_KEY_PATTERN =
  "api[_-]?key|api[_-]?secret|private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|vault[_-]?token";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
];

const DOUBLE_QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `(["']?(?:${SECRET_KEY_PATTERN})["']?\\s*[:=]\\s*")([^"]*)(")`,
  "gi",
);

const SINGLE_QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `(["']?(?:${SECRET_KEY_PATTERN})["']?\\s*[:=]\\s*')([^']*)(')`,
  "gi",
);

const UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:${SECRET_KEY_PATTERN})\\s*[:=]\\s*)([^\\r\\n,}]+)`,
  "gi",
);

const LABELED_HEX_SECRET_PATTERN = /\b((?:key|private key|secret key)\s+is\s+)0x[0-9a-f]{64}\b/gi;

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  result = result.replace(DOUBLE_QUOTED_SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]$3");
  result = result.replace(SINGLE_QUOTED_SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]$3");
  result = result.replace(UNQUOTED_SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]");
  result = result.replace(LABELED_HEX_SECRET_PATTERN, "$1[REDACTED]");
  return result;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized.includes("secret") ||
    normalized.includes("private") ||
    normalized.includes("mnemonic") ||
    normalized.includes("seed") ||
    normalized === "token" ||
    normalized === "authorization" ||
    ["vaulttoken", "accesstoken", "refreshtoken", "authtoken", "bearertoken"].some((suffix) =>
      normalized.endsWith(suffix),
    ) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("apisecret")
  );
}

export function redactObject(obj: unknown): unknown {
  if (typeof obj === "string") return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSecretKey(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactObject(value);
      }
    }
    return result;
  }
  return obj;
}
