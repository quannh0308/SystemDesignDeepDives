import { Duration } from 'aws-cdk-lib';
import type { IVpc, ISecurityGroup, SubnetSelection } from 'aws-cdk-lib/aws-ec2';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { join } from 'node:path';

export interface NodeFnProps {
  /** Path under src/, e.g. 'location/handler.ts'. */
  entry: string;
  environment?: Record<string, string>;
  vpc?: IVpc;
  vpcSubnets?: SubnetSelection;
  securityGroups?: ISecurityGroup[];
  timeout?: Duration;
}

/** Node.js 22 (lld.md §1), ARM, esbuild-bundled per entry — one Lambda per handler. */
export function nodeFn(scope: Construct, id: string, props: NodeFnProps): NodejsFunction {
  return new NodejsFunction(scope, id, {
    entry: join(import.meta.dirname, '..', 'src', props.entry),
    handler: 'handler',
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    memorySize: 256,
    timeout: props.timeout ?? Duration.seconds(10),
    environment: props.environment,
    vpc: props.vpc,
    vpcSubnets: props.vpcSubnets,
    securityGroups: props.securityGroups,
  });
}
