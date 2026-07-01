import { Logger } from "./types.js";

function redact(value: unknown): unknown {
  if (typeof value === "string" && /(token|key|password|secret)/i.test(value)) return "[redacted]";
  return value;
}

function write(level: string, message: string, fields: Record<string, unknown> = {}): void {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(redact(value))}`)
    .join(" ");
  const line = `${new Date().toISOString()} level=${level} message=${JSON.stringify(message)}${pairs ? ` ${pairs}` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const consoleLogger: Logger = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
  debug: (message, fields) => write("debug", message, fields),
};
