class AppError extends Error {
  /**
   * @param message    human-readable, and shown to the operator for a 4xx
   * @param statusCode HTTP status
   * @param code       OPTIONAL machine-readable reason, SCREAMING_SNAKE_CASE.
   *
   * `code` exists for a refusal the CLIENT has to act on differently from
   * every other refusal of the same status -- "this needs consent first" is a
   * 409 like any other, and a UI that has to tell them apart would otherwise
   * be matching on English prose that a copy edit then breaks. Only set it
   * where a caller branches on it; a message is enough everywhere else.
   *
   * Never set on a 5xx: the error handler does not return codes for those, for
   * the same reason it does not return their messages.
   */
  constructor(message, statusCode, code = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
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
