import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Stateful stores (lld.md §3, §6): `fares`, `rides` (+ 2 GSIs) and
 * `driver-offers` (+ stream) DynamoDB tables. Resources arrive in task 2.
 */
export class DataStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
  }
}
