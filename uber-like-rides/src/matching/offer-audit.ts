/**
 * Offer-audit writer (lld.md §3): consumes the `driver-offers` stream and
 * appends one row per lifecycle event to the audit table — the record the
 * invariant auditor (task 8.3) uses to prove no driver ever held two
 * overlapping offers. INSERT = OFFERED, REMOVE = RESOLVED, MODIFY (a
 * re-offer overwrote the row) = RESOLVED(old) + OFFERED(new).
 * The task token is deliberately never copied into audit rows.
 */
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { requireEnv } from '../http/api';
import { docClient } from '../rides/doc-client';
import type { StoreClient } from '../rides/store';
import type { DriverOffer } from './offer-store';

export interface AuditRow {
  driverId: string;
  /** Sort key: `${atMs}#${event}#${rideId}` — append-only, time-ordered per driver. */
  sk: string;
  event: 'OFFERED' | 'RESOLVED';
  rideId: string;
  atMs: number;
  offeredAt: number;
  expiresAt: number;
}

export interface OfferStreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE' | string;
  dynamodb?: {
    NewImage?: Record<string, unknown>;
    OldImage?: Record<string, unknown>;
    ApproximateCreationDateTime?: number;
  };
}

function toRow(image: Record<string, unknown>, event: AuditRow['event'], atMs: number): AuditRow {
  const offer = unmarshall(image as Record<string, AttributeValue>) as DriverOffer;
  return {
    driverId: offer.driverId,
    sk: `${atMs}#${event}#${offer.rideId}`,
    event,
    rideId: offer.rideId,
    atMs,
    offeredAt: offer.offeredAt,
    expiresAt: offer.expiresAt,
  };
}

export function toAuditRows(record: OfferStreamRecord): AuditRow[] {
  const atMs = (record.dynamodb?.ApproximateCreationDateTime ?? 0) * 1000;
  const oldImage = record.dynamodb?.OldImage;
  const newImage = record.dynamodb?.NewImage;
  switch (record.eventName) {
    case 'INSERT':
      return newImage ? [toRow(newImage, 'OFFERED', atMs)] : [];
    case 'MODIFY':
      return [
        ...(oldImage ? [toRow(oldImage, 'RESOLVED', atMs)] : []),
        ...(newImage ? [toRow(newImage, 'OFFERED', atMs)] : []),
      ];
    case 'REMOVE':
      return oldImage ? [toRow(oldImage, 'RESOLVED', atMs)] : [];
    default:
      return [];
  }
}

let client: StoreClient | undefined;

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  client ??= docClient();
  const table = requireEnv('AUDIT_TABLE');
  for (const record of event.Records) {
    for (const row of toAuditRows(record as OfferStreamRecord)) {
      await client.send(new PutCommand({ TableName: table, Item: row }));
    }
  }
}
