import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../logger';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

export const errorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    // Never leak internals to the client; the request id lets us find the log line.
    logger.error({ err: err instanceof Error ? err.message : String(err), requestId: req.id });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  };
