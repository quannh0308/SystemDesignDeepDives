/**
 * POST /fares (lld.md §2.2, hld.md §6.1): validate coords against the city
 * bbox, route via the RoutingPort (lab: haversine × city speed), price, and
 * persist with a 5-minute expiry. `expiresAt` is epoch SECONDS (DynamoDB TTL
 * and the useFare guard comparand); all other timestamps are epoch ms.
 */
import { randomUUID } from 'node:crypto';
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
import { inBbox, parseBbox, type Bbox, type Point } from '../location/bbox';
import { RideStore, type Fare } from '../rides/store';
import { docClient } from '../rides/doc-client';
import { priceCents } from './pricing';
import { CityRouting, type RoutingPort } from './routing';

/** The one store operation this handler needs — RideStore implements it. */
export interface FareWriter {
  createFare(fare: Fare): Promise<void>;
}

export interface FareDeps {
  store: FareWriter;
  routing: RoutingPort;
  bbox: Bbox;
  fareTtlS: number;
  now(): number;
  newId(): string;
}

function asPoint(value: unknown): Point | undefined {
  const p = value as { lat?: unknown; lng?: unknown } | undefined;
  return typeof p?.lat === 'number' && typeof p?.lng === 'number' ? { lat: p.lat, lng: p.lng } : undefined;
}

export async function handleCreateFare(deps: FareDeps, identity: Identity, body: unknown): Promise<ApiResult> {
  if (identity.role !== 'rider') {
    return errorResponse(403, 'FORBIDDEN', 'Only riders request fares');
  }
  const input = body as { pickup?: unknown; destination?: unknown } | undefined;
  const pickup = asPoint(input?.pickup);
  const destination = asPoint(input?.destination);
  if (!pickup || !destination || !inBbox(pickup, deps.bbox) || !inBbox(destination, deps.bbox)) {
    return errorResponse(400, 'BAD_COORDS', 'Coordinates missing or outside the city bounding box');
  }

  const { distanceKm, durationSeconds } = await deps.routing.route(pickup, destination);
  const nowMs = deps.now();
  const fare: Fare = {
    fareId: deps.newId(),
    riderId: identity.id,
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    destLat: destination.lat,
    destLng: destination.lng,
    priceCents: priceCents(distanceKm, durationSeconds),
    etaSeconds: durationSeconds,
    createdAt: nowMs,
    expiresAt: Math.floor(nowMs / 1000) + deps.fareTtlS,
  };
  await deps.store.createFare(fare);

  return json(201, {
    fareId: fare.fareId,
    priceCents: fare.priceCents,
    currency: 'EUR',
    etaSeconds: fare.etaSeconds,
    expiresAt: fare.expiresAt,
  });
}

let deps: FareDeps | undefined;

function liveDeps(): FareDeps {
  return (deps ??= {
    store: new RideStore(docClient(), { rides: '', fares: requireEnv('FARES_TABLE') }),
    routing: new CityRouting(),
    bbox: parseBbox(requireEnv('CITY_BBOX')),
    fareTtlS: Number(requireEnv('FARE_TTL_S')),
    now: () => Date.now(),
    newId: () => randomUUID(),
  });
}

export async function handler(event: ApiEvent): Promise<ApiResult> {
  const identity = identityOf(event);
  if (!identity) return errorResponse(401, 'UNAUTHORIZED', 'Missing identity');
  return handleCreateFare(liveDeps(), identity, parseJsonBody(event));
}
