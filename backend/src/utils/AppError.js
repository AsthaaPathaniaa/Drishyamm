class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * A 5xx whose message is written for the user ("X isn't switched on yet",
   * "still starting, try again"). errorHandler hides every other 5xx message,
   * so only use this for fixed text, never text built from upstream errors.
   */
  static public(message, statusCode = 503) {
    const e = new AppError(message, statusCode);
    e.expose = true;
    return e;
  }
}

module.exports = AppError;
