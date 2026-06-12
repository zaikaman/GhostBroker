import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";

export const correlationIdHeader = "x-correlation-id";

export interface CorrelatedLocals {
  correlationId: string;
}

function normalizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

export function correlationIdMiddleware(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const incoming = normalizeCorrelationId(request.header(correlationIdHeader));
    const correlationId = incoming ?? randomUUID();

    response.locals.correlationId = correlationId;
    response.setHeader(correlationIdHeader, correlationId);
    next();
  };
}
