/**
 * Wraps an async route handler so a rejected promise reaches Express's error handler
 */
export function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
