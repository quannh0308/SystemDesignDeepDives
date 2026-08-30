/**
 * MarkFailed step (lld.md §5.7): terminal FAILED via the guarded write. If the
 * ride already left the matching states (accepted or cancelled), the guard
 * refuses and this step is a no-op — the guard, not the workflow, arbitrates.
 */
import { requireEnv } from '../http/api';
import { RideAlreadyTerminalError, RideStore } from '../rides/store';
import { docClient } from '../rides/doc-client';

export interface FailInput {
  rideId: string;
}

export async function handleFail(rides: Pick<RideStore, 'markFailed'>, input: FailInput, now: number): Promise<void> {
  try {
    await rides.markFailed(input.rideId, now);
  } catch (error) {
    if (!(error instanceof RideAlreadyTerminalError)) throw error;
  }
}

let store: RideStore | undefined;

export async function handler(input: FailInput): Promise<void> {
  store ??= new RideStore(docClient(), { rides: requireEnv('RIDES_TABLE'), fares: '' });
  return handleFail(store, input, Date.now());
}
