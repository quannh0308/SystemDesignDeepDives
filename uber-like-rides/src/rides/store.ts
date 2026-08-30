/**
 * System-of-record helpers for `rides` and `fares` (lld.md §3).
 *
 * The conditional-write guards below are the final arbiter of ride state
 * (hld.md Deep Dive 9.2): locks and workflow state only reduce contention,
 * the guarded write decides. Guards are exposed as pure command builders so
 * their expressions unit-test without AWS; `RideStore` executes them and maps
 * `ConditionalCheckFailedException` to typed domain errors (lld.md §2.2).
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DeleteCommandOutput,
  type GetCommandOutput,
  type PutCommandInput,
  type PutCommandOutput,
  type QueryCommandOutput,
  type UpdateCommandInput,
  type UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// Types (lld.md §3 attributes)
// ---------------------------------------------------------------------------

export type RideStatus =
  | 'REQUESTED'
  | 'MATCHING'
  | 'OFFERED'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

/** Statuses that make a driver ineligible for new offers (candidate filter). */
export const ACTIVE_DRIVER_STATUSES: readonly RideStatus[] = ['OFFERED', 'ACCEPTED', 'IN_PROGRESS'];

export interface Ride {
  rideId: string;
  riderId: string;
  fareId: string;
  status: RideStatus;
  driverId?: string;
  attempt: number;
  runId?: string;
  createdAt: number;
  offeredAt?: number;
  acceptedAt?: number;
  terminalAt?: number;
}

export interface Fare {
  fareId: string;
  riderId: string;
  pickupLat: number;
  pickupLng: number;
  destLat: number;
  destLng: number;
  priceCents: number;
  etaSeconds: number;
  usedByRideId?: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch SECONDS — DynamoDB TTL requires it; also the useFare guard comparand. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Guard errors — a failed condition never retries blindly (lld.md §3)
// ---------------------------------------------------------------------------

/** acceptRide guard failed: offer reassigned, timed out, or not this driver's. Maps to 409 STALE_OFFER. */
export class StaleOfferError extends Error {
  readonly code = 'STALE_OFFER';
  constructor(rideId: string) {
    super(`Ride ${rideId} is not offered to this driver anymore`);
    this.name = 'StaleOfferError';
  }
}

/** markOffered guard failed: the ride left MATCHING while we held the candidate. Matcher moves on. */
export class LostMatchRaceError extends Error {
  readonly code = 'LOST_MATCH_RACE';
  constructor(rideId: string) {
    super(`Ride ${rideId} is no longer in MATCHING`);
    this.name = 'LostMatchRaceError';
  }
}

/** releaseOffer guard failed: an accept won the race — the release must not clobber it. Ignorable. */
export class StaleReleaseError extends Error {
  readonly code = 'STALE_RELEASE';
  constructor(rideId: string) {
    super(`Offer on ride ${rideId} already resolved; release skipped`);
    this.name = 'StaleReleaseError';
  }
}

/** markMatching guard failed: ride is beyond MATCHING (e.g. cancelled). Matching halts. */
export class RideNotMatchableError extends Error {
  readonly code = 'RIDE_NOT_MATCHABLE';
  constructor(rideId: string) {
    super(`Ride ${rideId} is not in a matchable state`);
    this.name = 'RideNotMatchableError';
  }
}

export class RideAlreadyExistsError extends Error {
  readonly code = 'RIDE_EXISTS';
  constructor(rideId: string) {
    super(`Ride ${rideId} already exists`);
    this.name = 'RideAlreadyExistsError';
  }
}

export class FareNotFoundError extends Error {
  readonly code = 'FARE_NOT_FOUND';
  constructor(fareId: string) {
    super(`Fare ${fareId} not found`);
    this.name = 'FareNotFoundError';
  }
}

/** useFare guard failed on an existing fare. Maps to 409 FARE_EXPIRED / FARE_ALREADY_USED. */
export class FareUnavailableError extends Error {
  constructor(
    readonly code: 'FARE_EXPIRED' | 'FARE_ALREADY_USED',
    fareId: string,
  ) {
    super(`Fare ${fareId}: ${code}`);
    this.name = 'FareUnavailableError';
  }
}

/** markFailed guard failed: the ride is already terminal or accepted — never clobber. Ignorable. */
export class RideAlreadyTerminalError extends Error {
  readonly code = 'RIDE_ALREADY_TERMINAL';
  constructor(rideId: string) {
    super(`Ride ${rideId} already left the matching states`);
    this.name = 'RideAlreadyTerminalError';
  }
}

// ---------------------------------------------------------------------------
// Pure command builders — expressions verbatim from lld.md §3
// ---------------------------------------------------------------------------

const STATUS_ALIAS = { '#status': 'status' }; // `status` is a DynamoDB reserved word

export function buildCreateRide(table: string, ride: Ride): PutCommandInput {
  return {
    TableName: table,
    Item: ride,
    ConditionExpression: 'attribute_not_exists(rideId)',
  };
}

/** REQUESTED→MATCHING, idempotent: re-entry while already MATCHING is a no-op (lld.md §5.1). */
export function buildMarkMatching(table: string, rideId: string): UpdateCommandInput {
  return {
    TableName: table,
    Key: { rideId },
    UpdateExpression: 'SET #status = :matching',
    ConditionExpression: '#status = :requested OR #status = :matching',
    ExpressionAttributeNames: STATUS_ALIAS,
    ExpressionAttributeValues: { ':matching': 'MATCHING', ':requested': 'REQUESTED' },
  };
}

export function buildMarkOffered(
  table: string,
  rideId: string,
  driverId: string,
  attempt: number,
  now: number,
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { rideId },
    UpdateExpression: 'SET #status = :offered, driverId = :d, attempt = :a, offeredAt = :now',
    ConditionExpression: '#status = :matching',
    ExpressionAttributeNames: STATUS_ALIAS,
    ExpressionAttributeValues: {
      ':offered': 'OFFERED',
      ':matching': 'MATCHING',
      ':d': driverId,
      ':a': attempt,
      ':now': now,
    },
  };
}

/** Owner condition: only the driver currently holding the offer can accept. */
export function buildAcceptRide(
  table: string,
  rideId: string,
  callerDriverId: string,
  now: number,
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { rideId },
    UpdateExpression: 'SET #status = :accepted, acceptedAt = :now',
    ConditionExpression: '#status = :offered AND driverId = :caller',
    ExpressionAttributeNames: STATUS_ALIAS,
    ExpressionAttributeValues: {
      ':accepted': 'ACCEPTED',
      ':offered': 'OFFERED',
      ':caller': callerDriverId,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
  };
}

/** The attempt pin makes a delayed release harmless after a re-offer (hld.md Deep Dive 9.2). */
export function buildReleaseOffer(
  table: string,
  rideId: string,
  driverId: string,
  attempt: number,
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { rideId },
    UpdateExpression: 'SET #status = :matching REMOVE driverId',
    ConditionExpression: '#status = :offered AND driverId = :d AND attempt = :a',
    ExpressionAttributeNames: STATUS_ALIAS,
    ExpressionAttributeValues: {
      ':matching': 'MATCHING',
      ':offered': 'OFFERED',
      ':d': driverId,
      ':a': attempt,
    },
  };
}

/** One ride per fare, within the fare's validity window. Old image returned to tell 409 reasons apart. */
export function buildUseFare(table: string, fareId: string, rideId: string, now: number): UpdateCommandInput {
  return {
    TableName: table,
    Key: { fareId },
    UpdateExpression: 'SET usedByRideId = :r',
    ConditionExpression: 'attribute_not_exists(usedByRideId) AND expiresAt > :now',
    ExpressionAttributeValues: { ':r': rideId, ':now': now },
    ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
  };
}

/**
 * Terminal FAILED. Covers REQUESTED/MATCHING (no candidates, budget spent) and
 * OFFERED (workflow died mid-offer — the ride must still reach a terminal
 * state; a late accept then gets a clean STALE_OFFER 409). Never touches
 * ACCEPTED or CANCELLED: the guard, not the caller, arbitrates.
 */
export function buildMarkFailed(table: string, rideId: string, now: number): UpdateCommandInput {
  return {
    TableName: table,
    Key: { rideId },
    UpdateExpression: 'SET #status = :failed, terminalAt = :now',
    ConditionExpression: '#status = :requested OR #status = :matching OR #status = :offered',
    ExpressionAttributeNames: STATUS_ALIAS,
    ExpressionAttributeValues: {
      ':failed': 'FAILED',
      ':requested': 'REQUESTED',
      ':matching': 'MATCHING',
      ':offered': 'OFFERED',
      ':now': now,
    },
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Structural subset of DynamoDBDocumentClient — lets tests inject a fake sender. */
export interface StoreClient {
  send(command: DeleteCommand): Promise<DeleteCommandOutput>;
  send(command: GetCommand): Promise<GetCommandOutput>;
  send(command: PutCommand): Promise<PutCommandOutput>;
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: UpdateCommand): Promise<UpdateCommandOutput>;
}

export interface StoreTables {
  rides: string;
  fares: string;
}

export class RideStore {
  constructor(
    private readonly client: StoreClient,
    private readonly tables: StoreTables,
  ) {}

  async createRide(ride: Ride): Promise<void> {
    try {
      await this.client.send(new PutCommand(buildCreateRide(this.tables.rides, ride)));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new RideAlreadyExistsError(ride.rideId);
      throw error;
    }
  }

  async getRide(rideId: string): Promise<Ride | undefined> {
    const out = await this.client.send(new GetCommand({ TableName: this.tables.rides, Key: { rideId } }));
    return out.Item as Ride | undefined;
  }

  /**
   * Active-ride filter for the candidate finder (lld.md §1): Query the
   * `driverId-status` GSI (keys-only) and check for any active status
   * client-side — Query cannot express IN on a sort key, and a driver's
   * ride count is tiny.
   */
  async hasActiveRide(driverId: string): Promise<boolean> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.tables.rides,
        IndexName: 'driverId-status',
        KeyConditionExpression: 'driverId = :d',
        ExpressionAttributeValues: { ':d': driverId },
      }),
    );
    const statuses = (out.Items ?? []).map((item) => item.status as RideStatus);
    return statuses.some((s) => ACTIVE_DRIVER_STATUSES.includes(s));
  }

  async getFare(fareId: string): Promise<Fare | undefined> {
    const out = await this.client.send(new GetCommand({ TableName: this.tables.fares, Key: { fareId } }));
    return out.Item as Fare | undefined;
  }

  /** Plain put — fareId is a fresh UUID, no condition needed. */
  async createFare(fare: Fare): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tables.fares, Item: fare }));
  }

  async markMatching(rideId: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand(buildMarkMatching(this.tables.rides, rideId)));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new RideNotMatchableError(rideId);
      throw error;
    }
  }

  async markOffered(rideId: string, driverId: string, attempt: number, now: number): Promise<void> {
    try {
      await this.client.send(new UpdateCommand(buildMarkOffered(this.tables.rides, rideId, driverId, attempt, now)));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new LostMatchRaceError(rideId);
      throw error;
    }
  }

  async acceptRide(rideId: string, callerDriverId: string, now: number): Promise<Ride> {
    try {
      const out = await this.client.send(
        new UpdateCommand(buildAcceptRide(this.tables.rides, rideId, callerDriverId, now)),
      );
      return out.Attributes as Ride;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new StaleOfferError(rideId);
      throw error;
    }
  }

  async releaseOffer(rideId: string, driverId: string, attempt: number): Promise<void> {
    try {
      await this.client.send(new UpdateCommand(buildReleaseOffer(this.tables.rides, rideId, driverId, attempt)));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new StaleReleaseError(rideId);
      throw error;
    }
  }

  async markFailed(rideId: string, now: number): Promise<void> {
    try {
      await this.client.send(new UpdateCommand(buildMarkFailed(this.tables.rides, rideId, now)));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new RideAlreadyTerminalError(rideId);
      throw error;
    }
  }

  async useFare(fareId: string, rideId: string, now: number): Promise<void> {
    try {
      await this.client.send(new UpdateCommand(buildUseFare(this.tables.fares, fareId, rideId, now)));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        const oldFare = error.Item ? (unmarshall(error.Item) as Partial<Fare>) : undefined;
        if (!oldFare || Object.keys(oldFare).length === 0) throw new FareNotFoundError(fareId);
        if (oldFare.usedByRideId !== undefined) throw new FareUnavailableError('FARE_ALREADY_USED', fareId);
        throw new FareUnavailableError('FARE_EXPIRED', fareId);
      }
      throw error;
    }
  }
}
