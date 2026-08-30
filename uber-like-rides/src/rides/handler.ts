/**
 * Ride endpoints (lld.md §2.2).
 * - `POST /rides`: the useFare conditional write is the arbiter (one ride per
 *   fare, unexpired); persist the ride, then enqueue the match request
 *   (hld.md Deep Dive 9.3 — the queue absorbs bursts).
 * - `PATCH /rides/{rideId}` accept: the acceptRide guard (owner condition)
 *   decides FIRST; only after it succeeds is the task token resolved — the
 *   ride record, not the workflow, is the source of truth (lld.md §5).
 * - `GET /rides/{rideId}`: rider state polling.
 */
import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
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
import { OfferStore } from '../matching/offer-store';
import { docClient } from './doc-client';
import {
  FareNotFoundError,
  FareUnavailableError,
  RideStore,
  StaleOfferError,
  type Ride,
} from './store';

export interface MatchEnqueuer {
  enqueue(message: { rideId: string; pickup: { lat: number; lng: number }; priceCents: number }): Promise<void>;
}

export interface WorkflowSignaler {
  taskSuccess(taskToken: string, output: { rideId: string; driverId: string }): Promise<void>;
  taskFailure(taskToken: string, error: string): Promise<void>;
}

export interface RideDeps {
  store: Pick<RideStore, 'getRide' | 'getFare' | 'useFare' | 'createRide' | 'acceptRide'>;
  offers: Pick<OfferStore, 'get' | 'delete'>;
  queue: MatchEnqueuer;
  workflow: WorkflowSignaler;
  now(): number;
  newId(): string;
}

export async function handleGetRide(deps: Pick<RideDeps, 'store'>, rideId: string | undefined): Promise<ApiResult> {
  if (!rideId) return errorResponse(404, 'NOT_FOUND', 'No such ride');
  const ride = await deps.store.getRide(rideId);
  if (!ride) return errorResponse(404, 'NOT_FOUND', 'No such ride');
  return json(200, {
    rideId: ride.rideId,
    status: ride.status,
    ...(ride.driverId === undefined ? {} : { driverId: ride.driverId }),
    attempt: ride.attempt,
  });
}

export async function handleCreateRide(deps: RideDeps, identity: Identity, body: unknown): Promise<ApiResult> {
  if (identity.role !== 'rider') return errorResponse(403, 'FORBIDDEN', 'Only riders request rides');
  const fareId = (body as { fareId?: unknown } | undefined)?.fareId;
  if (typeof fareId !== 'string' || fareId === '') return errorResponse(400, 'BAD_REQUEST', 'fareId required');

  const fare = await deps.store.getFare(fareId);
  if (!fare || fare.riderId !== identity.id) {
    return errorResponse(404, 'FARE_NOT_FOUND', 'Unknown fare'); // never leak another rider's fare
  }

  const rideId = deps.newId();
  const nowMs = deps.now();
  try {
    await deps.store.useFare(fareId, rideId, Math.floor(nowMs / 1000)); // guard comparand is epoch seconds
  } catch (error) {
    if (error instanceof FareNotFoundError) return errorResponse(404, 'FARE_NOT_FOUND', 'Unknown fare');
    if (error instanceof FareUnavailableError) return errorResponse(409, error.code, error.message);
    throw error;
  }

  const ride: Ride = {
    rideId,
    riderId: identity.id,
    fareId,
    status: 'REQUESTED',
    attempt: 0,
    createdAt: nowMs,
  };
  await deps.store.createRide(ride);
  // Persist, then enqueue (tasks.md 4.1). A crash between the two leaves a
  // REQUESTED ride whose fare is consumed — visible in the audit, accepted
  // as a lab edge; the smoke suite exercises the full path.
  await deps.queue.enqueue({
    rideId,
    pickup: { lat: fare.pickupLat, lng: fare.pickupLng },
    priceCents: fare.priceCents,
  });

  return json(202, { rideId, status: 'REQUESTED' });
}

export async function handleDriverAction(
  deps: RideDeps,
  identity: Identity,
  rideId: string | undefined,
  body: unknown,
): Promise<ApiResult> {
  if (identity.role !== 'driver') return errorResponse(403, 'FORBIDDEN', 'Only drivers act on offers');
  const action = (body as { action?: unknown } | undefined)?.action;
  if (action !== 'accept' && action !== 'decline') {
    return errorResponse(400, 'BAD_REQUEST', 'action must be accept or decline');
  }

  const offer = await deps.offers.get(identity.id);
  if (!rideId || !offer || offer.rideId !== rideId) {
    return errorResponse(409, 'STALE_OFFER', 'This offer is no longer yours to answer');
  }

  if (action === 'accept') {
    try {
      await deps.store.acceptRide(rideId, identity.id, deps.now());
    } catch (error) {
      if (error instanceof StaleOfferError) return errorResponse(409, 'STALE_OFFER', error.message);
      throw error;
    }
    // Guard succeeded — only now resolve the workflow's task token.
    await deps.workflow.taskSuccess(offer.taskToken, { rideId, driverId: identity.id });
    await deps.offers.delete(identity.id, rideId);
    return json(200, { status: 'ACCEPTED' });
  }

  await deps.workflow.taskFailure(offer.taskToken, 'DriverDeclined');
  await deps.offers.delete(identity.id, rideId);
  return json(200, { status: 'MATCHING' }); // the workflow's release path re-opens matching
}

let deps: RideDeps | undefined;

function liveDeps(): RideDeps {
  if (!deps) {
    const sqs = new SQSClient({});
    const sfn = new SFNClient({});
    const queueUrl = requireEnv('MATCH_QUEUE_URL');
    deps = {
      store: new RideStore(docClient(), { rides: requireEnv('RIDES_TABLE'), fares: requireEnv('FARES_TABLE') }),
      offers: new OfferStore(docClient(), requireEnv('OFFERS_TABLE')),
      queue: {
        enqueue: async (message) =>
          void (await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }))),
      },
      workflow: {
        taskSuccess: async (taskToken, output) =>
          void (await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }))),
        taskFailure: async (taskToken, error) =>
          void (await sfn.send(new SendTaskFailureCommand({ taskToken, error }))),
      },
      now: () => Date.now(),
      newId: () => randomUUID(),
    };
  }
  return deps;
}

export async function handler(event: ApiEvent): Promise<ApiResult> {
  const identity = identityOf(event);
  if (!identity) return errorResponse(401, 'UNAUTHORIZED', 'Missing identity');
  const method = event.requestContext.http.method;
  const rideId = event.pathParameters?.rideId;
  if (method === 'GET') return handleGetRide(liveDeps(), rideId);
  if (method === 'POST') return handleCreateRide(liveDeps(), identity, parseJsonBody(event));
  if (method === 'PATCH') return handleDriverAction(liveDeps(), identity, rideId, parseJsonBody(event));
  return errorResponse(405, 'METHOD_NOT_ALLOWED', `Unsupported method ${method}`);
}
