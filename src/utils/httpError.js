export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code Machine-readable code
   * @param {string} message Human message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
