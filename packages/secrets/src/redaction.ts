const SECRET_PATTERNS = [
  /(?:api[_-]?key|api[_-]?secret|private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|vault[_-]?token)[=:]\s*["']?([^\s"']+)/gi,
  /0x[0-9a-f]{64}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.length <= 8) return "[REDACTED]";
      return `${match.slice(0, 4)}...[REDACTED]`;
    });
  }
  return result;
}

export function redactObject(obj: unknown): unknown {
  if (typeof obj === "string") return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("secret") ||
        lowerKey.includes("private") ||
        lowerKey.includes("mnemonic") ||
        lowerKey.includes("seed") ||
        lowerKey === "apikey" ||
        lowerKey === "api_key" ||
        lowerKey === "apisecret" ||
        lowerKey === "api_secret"
      ) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactObject(value);
      }
    }
    return result;
  }
  return obj;
}
