import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "worker" },
  redact: ["*.apiKey", "ANTHROPIC_API_KEY"],
  ...(process.env.NODE_ENV !== "production" ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,service" } } } : {}),
});
