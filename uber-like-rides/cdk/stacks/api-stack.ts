import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Front door (lld.md §2, §6): HTTP API Gateway, HMAC Lambda authorizer,
 * fare/ride/location/offer-poll handlers, `SIM_SECRET`. Resources arrive
 * in tasks 3–5.
 */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
  }
}
