'use strict';

require('dotenv').config();
const { createLogger, format, transports } = require('winston');
const chalk = require('chalk');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// ─── Pretty console format ────────────────────────────────────────────────────
const consoleFormat = format.printf(({ level, message, timestamp, ...meta }) => {
  const ts = chalk.gray(timestamp);
  let prefix;
  switch (level) {
    case 'error': prefix = chalk.red.bold('[ERROR]'); break;
    case 'warn':  prefix = chalk.yellow.bold('[WARN] '); break;
    case 'info':  prefix = chalk.cyan.bold('[INFO] '); break;
    case 'debug': prefix = chalk.magenta('[DEBUG]'); break;
    default:      prefix = `[${level.toUpperCase()}]`;
  }
  const metaStr = Object.keys(meta).length ? '\n  ' + JSON.stringify(meta, null, 2) : '';
  return `${ts} ${prefix} ${message}${metaStr}`;
});

const logger = createLogger({
  level: LOG_LEVEL,
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.errors({ stack: true }),
  ),
  transports: [
    // Console: human-readable colored output
    new transports.Console({
      format: format.combine(
        format.timestamp({ format: 'HH:mm:ss' }),
        consoleFormat,
      ),
    }),
    // File: machine-readable JSON for auditing all actions
    new transports.File({
      filename: 'logs/actions.log',
      format: format.combine(
        format.timestamp(),
        format.json(),
      ),
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 5,
    }),
  ],
});

module.exports = logger;
