import { describe, expect, it } from 'vitest';
import { mintToken, verifyToken } from './token';

const SECRET = 'test-secret';

describe('HMAC identity token (lld.md §2.1)', () => {
  it('round-trips a minted token', () => {
    const token = mintToken({ role: 'driver', id: 'driver-42' }, SECRET);
    expect(verifyToken(token, SECRET)).toEqual({ role: 'driver', id: 'driver-42' });
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = mintToken({ role: 'rider', id: 'rider-1' }, SECRET);
    const [, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ role: 'driver', id: 'rider-1' })).toString('base64')}.${sig}`;
    expect(verifyToken(forged, SECRET)).toBeUndefined();
  });

  it('rejects a token signed with a different secret', () => {
    const token = mintToken({ role: 'rider', id: 'rider-1' }, 'other-secret');
    expect(verifyToken(token, SECRET)).toBeUndefined();
  });

  it('rejects malformed tokens and invalid roles', () => {
    expect(verifyToken('not-a-token', SECRET)).toBeUndefined();
    expect(verifyToken('a.', SECRET)).toBeUndefined();
    expect(verifyToken('.b', SECRET)).toBeUndefined();
    const admin = mintToken({ role: 'admin' as never, id: 'x' }, SECRET);
    expect(verifyToken(admin, SECRET)).toBeUndefined();
  });
});
