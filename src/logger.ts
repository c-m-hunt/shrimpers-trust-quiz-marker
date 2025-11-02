import winston from "winston";

// Custom format for console output with colors
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level}] ${message}`;
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
  }),
);

// Format for file output (no colors)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: fileFormat,
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.LOG_LEVEL || "info",
    }),
    // Write all logs with level 'info' and below to combined.log
    new winston.transports.File({
      filename: "logs/combined.log",
      level: "info",
    }),
    // Write all errors to error.log
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
    }),
  ],
});

// Create a logger that can be used with additional context
export function createContextLogger(context: string) {
  return {
    debug: (message: string, meta?: any) => logger.debug(message, { context, ...meta }),
    info: (message: string, meta?: any) => logger.info(message, { context, ...meta }),
    warn: (message: string, meta?: any) => logger.warn(message, { context, ...meta }),
    error: (message: string, meta?: any) => logger.error(message, { context, ...meta }),
  };
}

export default logger;
