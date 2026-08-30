/**
 * HTTP glue shared by all API handlers: identity comes from the authorizer
 * context, never the request body (lld.md §2.1), and every error uses the
 * §2.2 shape `{error: {code, message}}`.
 */
import type { APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export interface Identity {
  role: 'rider' | 'driver';
  id: string;
}

export type ApiEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<Identity>;
export type ApiResult = APIGatewayProxyStructuredResultV2;

export function identityOf(event: ApiEvent): Identity | undefined {
  const ctx = event.requestContext.authorizer?.lambda;
  if (!ctx || (ctx.role !== 'rider' && ctx.role !== 'driver') || typeof ctx.id !== 'string' || ctx.id === '') {
    return undefined;
  }
  return { role: ctx.role, id: ctx.id };
}

export function parseJsonBody(event: ApiEvent): unknown {
  if (event.body === undefined) return undefined;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function json(statusCode: number, body: unknown): ApiResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode: number, code: string, message: string): ApiResult {
  return json(statusCode, { error: { code, message } });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}
