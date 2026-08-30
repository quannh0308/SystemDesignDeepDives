import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Location path (lld.md §6): VPC (2 AZ private-isolated), single-node
 * ElastiCache Redis, security groups, DynamoDB gateway endpoint, Step
 * Functions + SQS interface endpoints. Resources arrive in task 3.
 */
export class LocationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
  }
}
