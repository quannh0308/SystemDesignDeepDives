import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  GatewayVpcEndpointAwsService,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { CfnCacheCluster, CfnSubnetGroup } from 'aws-cdk-lib/aws-elasticache';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { CONFIG } from '../config';
import { nodeFn } from '../lambda';

/**
 * Location path (lld.md §6): isolated VPC (no NAT — nothing here talks to the
 * internet), single-node ElastiCache Redis standing in for the sharded geo
 * cluster (hld.md Deep Dive 9.1), free DynamoDB gateway endpoint for the VPC
 * Lambdas that arrive with task 4, location handler + stale sweeper.
 */
export class LocationStack extends Stack {
  readonly locationHandler: NodejsFunction;
  readonly vpc: Vpc;
  readonly lambdaSecurityGroup: SecurityGroup;
  readonly redisEndpoint: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    vpc.addGatewayEndpoint('DynamoEndpoint', { service: GatewayVpcEndpointAwsService.DYNAMODB });
    this.vpc = vpc;

    const lambdaSg = new SecurityGroup(this, 'LambdaSg', { vpc, allowAllOutbound: true });
    const redisSg = new SecurityGroup(this, 'RedisSg', { vpc, allowAllOutbound: false });
    redisSg.addIngressRule(Peer.securityGroupId(lambdaSg.securityGroupId), Port.tcp(6379), 'Redis from Lambdas');

    const subnetGroup = new CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'Isolated subnets for the geo Redis node',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    const redis = new CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });

    const redisEndpoint = `${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`;
    this.lambdaSecurityGroup = lambdaSg;
    this.redisEndpoint = redisEndpoint;
    const vpcPlacement = {
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
    };

    this.locationHandler = nodeFn(this, 'LocationHandler', {
      entry: 'location/handler.ts',
      environment: { REDIS_ENDPOINT: redisEndpoint, CITY_BBOX: CONFIG.CITY_BBOX },
      ...vpcPlacement,
    });

    const sweeper = nodeFn(this, 'Sweeper', {
      entry: 'location/sweeper.ts',
      environment: { REDIS_ENDPOINT: redisEndpoint, STALE_DRIVER_S: CONFIG.STALE_DRIVER_S },
      timeout: Duration.seconds(30),
      ...vpcPlacement,
    });
    new Rule(this, 'SweepEveryMinute', {
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [new LambdaFunction(sweeper)],
    });

    new CfnOutput(this, 'RedisEndpoint', { value: redisEndpoint });
  }
}
