/**
 * POST /drivers/location (lld.md §2.2): validate the ping against the city
 * bbox, then record it — GEOADD + ZADD through the GeoClient seam. Identity
 * (driverId) comes from the authorizer context, never the body.
 */
import {
  errorResponse,
  identityOf,
  json,
  parseJsonBody,
  requireEnv,
  type ApiEvent,
  type ApiResult,
  type Identity,
} from '../http/api';
import { inBbox, parseBbox, type Bbox } from './bbox';
import type { GeoClient } from './geo-client';
import { RedisGeoClient } from './redis-geo-client';

export interface PingDeps {
  geo: GeoClient;
  bbox: Bbox;
  now(): number;
}

export async function handlePing(deps: PingDeps, identity: Identity, body: unknown): Promise<ApiResult> {
  if (identity.role !== 'driver') {
    return errorResponse(403, 'FORBIDDEN', 'Only drivers report location');
  }
  const ping = body as { lat?: unknown; lng?: unknown } | undefined;
  const lat = typeof ping?.lat === 'number' ? ping.lat : NaN;
  const lng = typeof ping?.lng === 'number' ? ping.lng : NaN;
  if (!inBbox({ lat, lng }, deps.bbox)) {
    return errorResponse(400, 'BAD_COORDS', 'Location outside the city bounding box');
  }
  await deps.geo.recordPing(identity.id, lng, lat, deps.now());
  return json(200, {});
}

let deps: PingDeps | undefined;

function liveDeps(): PingDeps {
  return (deps ??= {
    geo: RedisGeoClient.fromEndpoint(requireEnv('REDIS_ENDPOINT')),
    bbox: parseBbox(requireEnv('CITY_BBOX')),
    now: () => Date.now(),
  });
}

export async function handler(event: ApiEvent): Promise<ApiResult> {
  const identity = identityOf(event);
  if (!identity) return errorResponse(401, 'UNAUTHORIZED', 'Missing identity');
  return handlePing(liveDeps(), identity, parseJsonBody(event));
}
