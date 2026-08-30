/**
 * GET /drivers/offer (lld.md §0 substitution: polling stands in for APNs/FCM
 * push; the offer contract is unchanged). 200 with the §2.2 shape while a
 * live offer exists, 204 otherwise.
 */
import { errorResponse, identityOf, json, requireEnv, type ApiEvent, type ApiResult } from '../http/api';
import { docClient } from '../rides/doc-client';
import { OfferStore } from './offer-store';

export async function handleOfferPoll(
  offers: Pick<OfferStore, 'get'>,
  driverId: string,
  nowMs: number,
): Promise<ApiResult> {
  const offer = await offers.get(driverId);
  if (!offer || offer.expiresAt * 1000 <= nowMs) return { statusCode: 204 };
  return json(200, {
    rideId: offer.rideId,
    pickup: { lat: offer.pickupLat, lng: offer.pickupLng },
    priceCents: offer.priceCents,
    expiresAt: offer.expiresAt,
  });
}

let store: OfferStore | undefined;

export async function handler(event: ApiEvent): Promise<ApiResult> {
  const identity = identityOf(event);
  if (!identity) return errorResponse(401, 'UNAUTHORIZED', 'Missing identity');
  if (identity.role !== 'driver') return errorResponse(403, 'FORBIDDEN', 'Offers are for drivers');
  store ??= new OfferStore(docClient(), requireEnv('OFFERS_TABLE'));
  return handleOfferPoll(store, identity.id, Date.now());
}
