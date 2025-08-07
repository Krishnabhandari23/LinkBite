const logger = require('../utils/logger');

function errorHandler(error, req, res, next) {
  logger.error('API Error:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip
  });

  // Default error
  let status = 500;
  let message = 'Internal server error';

  // Handle specific error types
  if (error.code === 'ENOTFOUND') {
    status = 503;
    message = 'External service unavailable';
  } else if (error.response && error.response.status) {
    status = error.response.status;
    message = error.response.data?.message || error.message;
  } else if (error.name === 'ValidationError') {
    status = 400;
    message = error.message;
  }

  res.status(status).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
}

module.exports = errorHandler;