import { describe, expect, it } from 'vitest';
import { InMemoryGeoClient } from '../location/geo-client.fake';
import { RideNotMatchableError } from '../rides/store';
import { handleGetCandidates, type CandidatesStepDeps } from './candidates';
import { handleOfferPoll } from './offer-poll';
import { handlePump, toWorkflowInput } from './pump';
import { toAuditRows } from './offer-audit';
import type { DriverOffer } from './offer-store';

const NOW = 1_700_000_000_000;

describe('GetCandidates state wrapper', () => {
  function deps(overrides: Partial<CandidatesStepDeps> = {}): CandidatesStepDeps {
    const geo = new InMemoryGeoClient();
    void geo.recordPing('driver-1', 13.405, 52.52, NOW);
    return {
      geo,
      rides: { hasActiveRide: async () => false, markMatching: async () => undefined },
      radiusKm: 5,
      limit: 10,
      now: () => NOW,
      ...overrides,
    };
  }
  const input = { rideId: 'ride-1', pickup: { lat: 52.52, lng: 13.405 }, excluded: [], deadlineMs: NOW + 60_000 };

  it('within budget: marks MATCHING and returns candidates', async () => {
    const result = await handleGetCandidates(deps(), input);
    expect(result.candidates.map((c) => c.driverId)).toEqual(['driver-1']);
  });

  it('budget spent → no candidates (workflow branches to MarkFailed)', async () => {
    const result = await handleGetCandidates(deps(), { ...input, deadlineMs: NOW - 1 });
    expect(result.candidates).toEqual([]);
  });

  it('ride no longer matchable (e.g. cancelled) → no candidates, no search', async () => {
    const result = await handleGetCandidates(
      deps({
        rides: {
          hasActiveRide: async () => false,
          markMatching: async () => {
            throw new RideNotMatchableError('ride-1');
          },
        },
      }),
      input,
    );
    expect(result.candidates).toEqual([]);
  });
});

describe('SQS→SFN pump', () => {
  it('starts one execution per record; duplicates resolve silently inside the starter', async () => {
    const started: string[] = [];
    const res = await handlePump(
      { start: async (name) => void started.push(name) },
      [{ messageId: 'm1', body: JSON.stringify({ rideId: 'ride-1', pickup: { lat: 1, lng: 2 }, priceCents: 5 }) }],
      NOW,
      60,
    );
    expect(started).toEqual(['ride-1']);
    expect(res.batchItemFailures).toEqual([]);
  });

  it('malformed message → per-item batch failure (→ DLQ after 3 receives)', async () => {
    const res = await handlePump({ start: async () => undefined }, [{ messageId: 'bad', body: '{not json' }], NOW, 60);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
  });

  it('workflow input carries the absolute match deadline', () => {
    const input = toWorkflowInput(JSON.stringify({ rideId: 'r', pickup: { lat: 1, lng: 2 }, priceCents: 7 }), NOW, 60);
    expect(input.deadlineMs).toBe(NOW + 60_000);
    expect(input.excluded).toEqual([]);
  });
});

describe('offer poll (lab notifier face)', () => {
  const offer: DriverOffer = {
    driverId: 'driver-9',
    rideId: 'ride-1',
    taskToken: 'secret-token',
    priceCents: 900,
    pickupLat: 52.52,
    pickupLng: 13.4,
    offeredAt: NOW,
    expiresAt: Math.floor(NOW / 1000) + 10,
  };

  it('live offer → 200 with the §2.2 shape, token never exposed', async () => {
    const res = await handleOfferPoll({ get: async () => offer }, 'driver-9', NOW);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body).toEqual({
      rideId: 'ride-1',
      pickup: { lat: 52.52, lng: 13.4 },
      priceCents: 900,
      expiresAt: offer.expiresAt,
    });
    expect(res.body).not.toContain('secret-token');
  });

  it('no offer or expired offer → 204', async () => {
    expect((await handleOfferPoll({ get: async () => undefined }, 'driver-9', NOW)).statusCode).toBe(204);
    const expired = { ...offer, expiresAt: Math.floor(NOW / 1000) - 1 };
    expect((await handleOfferPoll({ get: async () => expired }, 'driver-9', NOW)).statusCode).toBe(204);
  });
});

describe('offer-audit stream transform', () => {
  const image = (rideId: string) => ({
    driverId: { S: 'driver-9' },
    rideId: { S: rideId },
    taskToken: { S: 'secret-token' },
    priceCents: { N: '900' },
    pickupLat: { N: '52.52' },
    pickupLng: { N: '13.4' },
    offeredAt: { N: String(NOW) },
    expiresAt: { N: '1700000010' },
  });

  it('INSERT → OFFERED · REMOVE → RESOLVED · MODIFY → RESOLVED(old) + OFFERED(new)', () => {
    const at = { ApproximateCreationDateTime: 1_700_000_001 };
    expect(toAuditRows({ eventName: 'INSERT', dynamodb: { ...at, NewImage: image('ride-1') } }).map((r) => r.event)).toEqual(['OFFERED']);
    expect(toAuditRows({ eventName: 'REMOVE', dynamodb: { ...at, OldImage: image('ride-1') } }).map((r) => r.event)).toEqual(['RESOLVED']);
    const modify = toAuditRows({
      eventName: 'MODIFY',
      dynamodb: { ...at, OldImage: image('ride-1'), NewImage: image('ride-2') },
    });
    expect(modify.map((r) => `${r.event}:${r.rideId}`)).toEqual(['RESOLVED:ride-1', 'OFFERED:ride-2']);
  });

  it('audit rows never carry the task token', () => {
    const rows = toAuditRows({
      eventName: 'INSERT',
      dynamodb: { ApproximateCreationDateTime: 1_700_000_001, NewImage: image('ride-1') },
    });
    expect(JSON.stringify(rows)).not.toContain('secret-token');
  });
});
