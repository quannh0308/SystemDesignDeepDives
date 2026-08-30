import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Matching path (lld.md §5, §6): match queue + DLQ, SQS→Step Functions pump,
 * match state machine, matcher Lambdas, offer-audit stream handler,
 * dashboard + paging alarms. Resources arrive in task 4.
 */
export class MatchingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
  }
}
