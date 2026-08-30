import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  buildAcceptRide,
  buildCreateRide,
  buildMarkFailed,
  buildMarkMatching,
  buildMarkOffered,
  buildReleaseOffer,
  buildUseFare,
  FareNotFoundError,
  FareUnavailableError,
  LostMatchRaceError,
  RideAlreadyExistsError,
  RideAlreadyTerminalError,
  RideNotMatchableError,
  RideStore,
  StaleOfferError,
  StaleReleaseError,
  type Ride,
  type StoreClient,
} from './store';

const TABLES = { rides: 'rides-table', fares: 'fares-table' };

function conditionalFailure(item?: Record<string, unknown>): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: 'The conditional request failed',
    $metadata: {},
    ...(item ? { Item: marshall(item) } : {}),
  });
}

/** Fake client: rejects every send with the given error, or resolves with the given output. */
function fakeClient(behavior: { throws?: Error; resolves?: object }): StoreClient {
  return {
    send: () => (behavior.throws ? Promise.reject(behavior.throws) : Promise.resolve(behavior.resolves ?? {})),
  } as StoreClient;
}

const ride: Ride = {
  rideId: 'ride-1',
  riderId: 'rider-1',
  fareId: 'fare-1',
  status: 'REQUESTED',
  attempt: 0,
  createdAt: 1000,
};

describe('guard expressions match lld.md §3 verbatim', () => {
  it('createRide refuses to overwrite an existing ride', () => {
    const cmd = buildCreateRide(TABLES.rides, ride);
    expect(cmd.ConditionExpression).toBe('attribute_not_exists(rideId)');
  });

  it('markMatching: REQUESTED→MATCHING, idempotent on re-entry', () => {
    const cmd = buildMarkMatching(TABLES.rides, 'ride-1');
    expect(cmd.UpdateExpression).toBe('SET #status = :matching');
    expect(cmd.ConditionExpression).toBe('#status = :requested OR #status = :matching');
    expect(cmd.ExpressionAttributeNames).toEqual({ '#status': 'status' });
  });

  it('markOffered: only from MATCHING', () => {
    const cmd = buildMarkOffered(TABLES.rides, 'ride-1', 'driver-9', 2, 5000);
    expect(cmd.UpdateExpression).toBe('SET #status = :offered, driverId = :d, attempt = :a, offeredAt = :now');
    expect(cmd.ConditionExpression).toBe('#status = :matching');
    expect(cmd.ExpressionAttributeValues).toEqual({
      ':offered': 'OFFERED',
      ':matching': 'MATCHING',
      ':d': 'driver-9',
      ':a': 2,
      ':now': 5000,
    });
  });

  it('acceptRide: owner condition — status OFFERED and driverId equals the caller', () => {
    const cmd = buildAcceptRide(TABLES.rides, 'ride-1', 'driver-9', 6000);
    expect(cmd.UpdateExpression).toBe('SET #status = :accepted, acceptedAt = :now');
    expect(cmd.ConditionExpression).toBe('#status = :offered AND driverId = :caller');
    expect(cmd.ExpressionAttributeValues).toMatchObject({ ':caller': 'driver-9' });
    expect(cmd.ReturnValues).toBe('ALL_NEW');
  });

  it('releaseOffer: pinned to driver AND attempt so a delayed release cannot clobber a re-offer', () => {
    const cmd = buildReleaseOffer(TABLES.rides, 'ride-1', 'driver-9', 2);
    expect(cmd.UpdateExpression).toBe('SET #status = :matching REMOVE driverId');
    expect(cmd.ConditionExpression).toBe('#status = :offered AND driverId = :d AND attempt = :a');
    expect(cmd.ExpressionAttributeValues).toEqual({
      ':matching': 'MATCHING',
      ':offered': 'OFFERED',
      ':d': 'driver-9',
      ':a': 2,
    });
  });

  it('useFare: unused-and-unexpired condition, old image requested for 409 disambiguation', () => {
    const cmd = buildUseFare(TABLES.fares, 'fare-1', 'ride-1', 7000);
    expect(cmd.UpdateExpression).toBe('SET usedByRideId = :r');
    expect(cmd.ConditionExpression).toBe('attribute_not_exists(usedByRideId) AND expiresAt > :now');
    expect(cmd.ExpressionAttributeValues).toEqual({ ':r': 'ride-1', ':now': 7000 });
    expect(cmd.ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
  });

  it('markFailed: drives any pre-acceptance state terminal, never clobbers ACCEPTED or CANCELLED', () => {
    const cmd = buildMarkFailed(TABLES.rides, 'ride-1', 9000);
    expect(cmd.UpdateExpression).toBe('SET #status = :failed, terminalAt = :now');
    expect(cmd.ConditionExpression).toBe('#status = :requested OR #status = :matching OR #status = :offered');
    expect(cmd.ExpressionAttributeValues).toMatchObject({ ':failed': 'FAILED', ':now': 9000 });
  });
});

describe('RideStore maps conditional failures to typed guard errors', () => {
  const failing = new RideStore(fakeClient({ throws: conditionalFailure() }), TABLES);

  it('createRide → RideAlreadyExistsError', async () => {
    await expect(failing.createRide(ride)).rejects.toBeInstanceOf(RideAlreadyExistsError);
  });

  it('markMatching → RideNotMatchableError (e.g. rider cancelled before matching)', async () => {
    await expect(failing.markMatching('ride-1')).rejects.toBeInstanceOf(RideNotMatchableError);
  });

  it('markFailed → RideAlreadyTerminalError (ride accepted or cancelled first — callers swallow)', async () => {
    await expect(failing.markFailed('ride-1', 9000)).rejects.toBeInstanceOf(RideAlreadyTerminalError);
  });

  it('markOffered → LostMatchRaceError (ride left MATCHING first)', async () => {
    await expect(failing.markOffered('ride-1', 'driver-9', 1, 5000)).rejects.toBeInstanceOf(LostMatchRaceError);
  });

  it('acceptRide → StaleOfferError with code STALE_OFFER (the 409 of lld.md §2.2)', async () => {
    const error = await failing.acceptRide('ride-1', 'driver-9', 6000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaleOfferError);
    expect((error as StaleOfferError).code).toBe('STALE_OFFER');
  });

  it('releaseOffer → StaleReleaseError (accept won the race; caller ignores)', async () => {
    await expect(failing.releaseOffer('ride-1', 'driver-9', 1)).rejects.toBeInstanceOf(StaleReleaseError);
  });

  it('acceptRide returns the updated ride on success', async () => {
    const accepted = { ...ride, status: 'ACCEPTED' as const, driverId: 'driver-9' };
    const store = new RideStore(fakeClient({ resolves: { Attributes: accepted } }), TABLES);
    await expect(store.acceptRide('ride-1', 'driver-9', 6000)).resolves.toEqual(accepted);
  });

  it('non-conditional errors pass through unchanged', async () => {
    const boom = new Error('network');
    const store = new RideStore(fakeClient({ throws: boom }), TABLES);
    await expect(store.acceptRide('ride-1', 'driver-9', 6000)).rejects.toBe(boom);
  });
});

describe('useFare 409 disambiguation from the returned old image', () => {
  it('old image already carries usedByRideId → FARE_ALREADY_USED', async () => {
    const store = new RideStore(
      fakeClient({ throws: conditionalFailure({ fareId: 'fare-1', usedByRideId: 'ride-0', expiresAt: 9999 }) }),
      TABLES,
    );
    const error = await store.useFare('fare-1', 'ride-1', 7000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FareUnavailableError);
    expect((error as FareUnavailableError).code).toBe('FARE_ALREADY_USED');
  });

  it('old image unused but past expiry → FARE_EXPIRED', async () => {
    const store = new RideStore(
      fakeClient({ throws: conditionalFailure({ fareId: 'fare-1', expiresAt: 6000 }) }),
      TABLES,
    );
    const error = await store.useFare('fare-1', 'ride-1', 7000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FareUnavailableError);
    expect((error as FareUnavailableError).code).toBe('FARE_EXPIRED');
  });

  it('no old image → the fare never existed → FareNotFoundError', async () => {
    const store = new RideStore(fakeClient({ throws: conditionalFailure() }), TABLES);
    await expect(store.useFare('fare-1', 'ride-1', 7000)).rejects.toBeInstanceOf(FareNotFoundError);
  });
});

describe('client seam', () => {
  it('the real DynamoDBDocumentClient satisfies StoreClient at compile time', () => {
    const accepts = (client: StoreClient): StoreClient => client;
    const witness = null as unknown as DynamoDBDocumentClient;
    expect(accepts(witness)).toBeNull();
  });
});
