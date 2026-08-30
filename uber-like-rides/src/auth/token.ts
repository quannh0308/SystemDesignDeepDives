/**
 * Lab identity token (lld.md §2.1):
 * `token = base64(payload) + "." + hex(hmacSHA256(payload, SIM_SECRET))`
 * with `payload = {"role":"rider"|"driver","id":"<uuid>"}`.
 *
 * Deliberately not production auth — it exists so the "identity from token,
 * never body" rule is real in code. Minting is shared with the simulators.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Identity } from '../http/api';

function hmacHex(payloadJson: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadJson).digest('hex');
}

export function mintToken(identity: Identity, secret: string): string {
  const payloadJson = JSON.stringify({ role: identity.role, id: identity.id });
  return `${Buffer.from(payloadJson).toString('base64')}.${hmacHex(payloadJson, secret)}`;
}

export function verifyToken(token: string, secret: string): Identity | undefined {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return undefined;
  const payloadJson = Buffer.from(token.slice(0, dot), 'base64').toString('utf8');
  const givenSig = Buffer.from(token.slice(dot + 1));
  const expectedSig = Buffer.from(hmacHex(payloadJson, secret));
  if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
  const candidate = payload as { role?: unknown; id?: unknown };
  if ((candidate.role !== 'rider' && candidate.role !== 'driver') || typeof candidate.id !== 'string' || candidate.id === '') {
    return undefined;
  }
  return { role: candidate.role, id: candidate.id };
}
