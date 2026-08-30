/**
 * `driver-offers` table access (lld.md §3): one row per driver (PK driverId),
 * carrying the Step Functions task token. Written by the offer step, read by
 * `GET /drivers/offer` (the lab stand-in for push delivery), deleted on
 * accept/decline/release. Delete is pinned to the rideId so a delayed cleanup
 * can never remove a NEWER offer the driver has since received.
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { StoreClient } from '../rides/store';

export interface DriverOffer {
  driverId: string;
  rideId: string;
  taskToken: string;
  priceCents: number;
  pickupLat: number;
  pickupLng: number;
  /** Epoch milliseconds. */
  offeredAt: number;
  /** Epoch SECONDS — DynamoDB TTL garbage-collects expired offers. */
  expiresAt: number;
}

export class OfferStore {
  constructor(
    private readonly client: StoreClient,
    private readonly table: string,
  ) {}

  /** Plain put — PK is driverId, so re-offering a driver overwrites (the stream records both). */
  async put(offer: DriverOffer): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: offer }));
  }

  async get(driverId: string): Promise<DriverOffer | undefined> {
    const out = await this.client.send(new GetCommand({ TableName: this.table, Key: { driverId } }));
    return out.Item as DriverOffer | undefined;
  }

  /** True if this ride's offer row was deleted; false if it was already gone or replaced. */
  async delete(driverId: string, rideId: string): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { driverId },
          ConditionExpression: 'rideId = :r',
          ExpressionAttributeValues: { ':r': rideId },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
}
