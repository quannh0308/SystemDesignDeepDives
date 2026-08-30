/**
 * SQS → Step Functions pump (lld.md §5, hld.md Deep Dive 9.3): starts one
 * workflow per ride with execution name = rideId, so SQS at-least-once
 * delivery cannot start a second matcher (`ExecutionAlreadyExists` is the
 * dedupe working, not an error). Anything else is reported as a per-item
 * batch failure — after 3 receives the message lands in the DLQ (poison
 * isolation, task 10.3).
 */
import { ExecutionAlreadyExists, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { requireEnv } from '../http/api';

export interface MatchRequest {
  rideId: string;
  pickup: { lat: number; lng: number };
  priceCents: number;
}

export interface WorkflowInput extends MatchRequest {
  excluded: string[];
  deadlineMs: number;
}

export interface WorkflowStarter {
  /** Resolves for both a fresh start and an ExecutionAlreadyExists dedupe. */
  start(name: string, input: WorkflowInput): Promise<void>;
}

export function toWorkflowInput(body: string, nowMs: number, budgetS: number): WorkflowInput {
  const msg = JSON.parse(body) as MatchRequest;
  if (typeof msg.rideId !== 'string' || msg.rideId === '') throw new Error('rideId missing');
  return { ...msg, excluded: [], deadlineMs: nowMs + budgetS * 1000 };
}

export async function handlePump(
  starter: WorkflowStarter,
  records: Pick<SQSRecord, 'messageId' | 'body'>[],
  nowMs: number,
  budgetS: number,
): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of records) {
    try {
      const input = toWorkflowInput(record.body, nowMs, budgetS);
      await starter.start(input.rideId, input);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

let starter: WorkflowStarter | undefined;

function liveStarter(): WorkflowStarter {
  if (!starter) {
    const sfn = new SFNClient({});
    const stateMachineArn = requireEnv('STATE_MACHINE_ARN');
    starter = {
      async start(name, input) {
        try {
          await sfn.send(new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify(input) }));
        } catch (error) {
          if (!(error instanceof ExecutionAlreadyExists)) throw error;
        }
      },
    };
  }
  return starter;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  return handlePump(liveStarter(), event.Records, Date.now(), Number(requireEnv('MATCH_BUDGET_S')));
}
