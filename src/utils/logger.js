const winston = require('winston');
const config = require('../config/config');
const path = require('path');
const fs = require('fs');

// // Create logs directory if it doesn't exist
// const logsDir = path.dirname(config.LOG_FILE);
// if (!fs.existsSync(logsDir)) {
//   fs.mkdirSync(logsDir, { recursive: true });
// }

const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: config.LOG_FILE,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// Console logging for development
if (config.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

module.exports = logger;