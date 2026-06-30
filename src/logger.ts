import type { Logger } from "./types.js";

export const consoleLogger: Logger = {
  info(message, meta) {
    log("info", message, meta);
  },
  warn(message, meta) {
    log("warn", message, meta);
  },
  error(message, meta) {
    log("error", message, meta);
  },
};

function log(level: string, message: string, meta?: Record<string, unknown>) {
  const payload = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${payload}`;
  if (level === "error") console.error(line);
  else console.log(line);
}
