/**
 * Ride endpoints (lld.md §2.2). Task 5 delivers `GET /rides/{rideId}` — the
 * rider's state-polling substitute for push (lld.md §0). `POST /rides` and
 * `PATCH /rides/{rideId}` land with the matching path (task 4).
 */
import { errorResponse, identityOf, json, requireEnv, type ApiEvent, type ApiResult } from '../http/api';
import { docClient } from './doc-client';
import { RideStore } from './store';

export interface RideReader {
  getRide(rideId: string): ReturnType<RideStore['getRide']>;
}

export async function handleGetRide(store: RideReader, rideId: string | undefined): Promise<ApiResult> {
  if (!rideId) return errorResponse(404, 'NOT_FOUND', 'No such ride');
  const ride = await store.getRide(rideId);
  if (!ride) return errorResponse(404, 'NOT_FOUND', 'No such ride');
  return json(200, {
    rideId: ride.rideId,
    status: ride.status,
    ...(ride.driverId === undefined ? {} : { driverId: ride.driverId }),
    attempt: ride.attempt,
  });
}

let store: RideStore | undefined;

function liveStore(): RideStore {
  return (store ??= new RideStore(docClient(), { rides: requireEnv('RIDES_TABLE'), fares: '' }));
}

export async function handler(event: ApiEvent): Promise<ApiResult> {
  const identity = identityOf(event);
  if (!identity) return errorResponse(401, 'UNAUTHORIZED', 'Missing identity');
  if (event.requestContext.http.method === 'GET') {
    return handleGetRide(liveStore(), event.pathParameters?.rideId);
  }
  return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Arrives with the matching path (task 4)');
}
