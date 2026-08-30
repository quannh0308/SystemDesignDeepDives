import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { LocationStack } from './location-stack';

let cached: Template | undefined;
function synth(): Template {
  if (!cached) {
    const app = new App();
    cached = Template.fromStack(new LocationStack(app, 'LocationStack'));
  }
  return cached;
}

describe('location-stack (lld.md §6, task 3.1)', () => {
  it('isolated VPC: no NAT gateways, no internet gateway, free DynamoDB gateway endpoint', () => {
    const template = synth();
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      ServiceName: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
      VpcEndpointType: 'Gateway',
    });
  });

  it('single-node Redis on the lab instance class', () => {
    synth().hasResourceProperties('AWS::ElastiCache::CacheCluster', {
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      NumCacheNodes: 1,
    });
  });

  it('Redis reachable only from the Lambda security group on 6379', () => {
    synth().hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          FromPort: 6379,
          ToPort: 6379,
          IpProtocol: 'tcp',
          SourceSecurityGroupId: Match.anyValue(),
        }),
      ]),
    });
  });

  it('location handler and sweeper run in the VPC with the config-matrix env', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ REDIS_ENDPOINT: Match.anyValue(), CITY_BBOX: '52.35,13.20,52.60,13.55' }),
      },
      VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ REDIS_ENDPOINT: Match.anyValue(), STALE_DRIVER_S: '30' }),
      },
    });
  });

  it('sweeper fires on a 1-minute schedule', () => {
    synth().hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
      State: 'ENABLED',
    });
  });
});
