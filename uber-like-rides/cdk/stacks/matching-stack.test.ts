import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DataStack } from './data-stack';
import { LocationStack } from './location-stack';
import { MatchingStack } from './matching-stack';

let cached: Template | undefined;
function synth(): Template {
  if (!cached) {
    const app = new App();
    const data = new DataStack(app, 'DataStack');
    const location = new LocationStack(app, 'LocationStack');
    cached = Template.fromStack(
      new MatchingStack(app, 'MatchingStack', {
        ridesTable: data.rides,
        offersTable: data.offers,
        vpc: location.vpc,
        lambdaSecurityGroup: location.lambdaSecurityGroup,
        redisEndpoint: location.redisEndpoint,
      }),
    );
  }
  return cached;
}

describe('matching-stack (lld.md §5, §6)', () => {
  it('match queue redrives to the DLQ after 3 receives (poison isolation)', () => {
    synth().hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  it('state machine exists with the 120 s backstop (budget itself travels as deadlineMs)', () => {
    const template = synth();
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const definition = JSON.stringify(Object.values(machines)[0]!.Properties).replaceAll('\\', '');
    expect(definition).toContain('"TimeoutSeconds":120');
    expect(definition).toContain('waitForTaskToken'); // the offer state waits for accept/decline
    expect(definition).toContain('"TimeoutSeconds":10'); // the 10 s offer window
  });

  it('two event source mappings: SQS→pump and offers-stream→audit', () => {
    synth().resourceCountIs('AWS::Lambda::EventSourceMapping', 2);
  });

  it('offer-audit table: per-driver append log (PK driverId, SK sk), on-demand, DESTROY', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'driverId', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('Redis-touching matcher Lambdas run in the VPC; pump/fail/audit stay outside', () => {
    const functions = Object.values(synth().findResources('AWS::Lambda::Function'));
    const inVpc = functions.filter((f) => f.Properties.VpcConfig !== undefined);
    expect(inVpc.length).toBe(3); // candidates, offer, release
  });

  it('the three paging alarms exist: match p99, oldest message age, DLQ non-empty', () => {
    synth().resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });

  it('exports queue url + state machine arn + audit table for deploy/outputs.json', () => {
    const template = synth();
    for (const name of ['MatchQueueUrl', 'StateMachineArn', 'AuditTableName']) {
      template.hasOutput(name, {});
    }
  });
});
