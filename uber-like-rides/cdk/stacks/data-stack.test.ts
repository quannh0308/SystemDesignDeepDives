import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { applyProjectTags } from '../tags';
import { DataStack } from './data-stack';

function synth(): Template {
  const app = new App();
  const stack = new DataStack(app, 'DataStack');
  applyProjectTags(app);
  return Template.fromStack(stack);
}

describe('data-stack (lld.md §3)', () => {
  it('creates exactly the three tables, all on-demand', () => {
    const template = synth();
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const table of Object.values(tables)) {
      expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    }
  });

  it('every table is DESTROY — cdk destroy must leave the account clean', () => {
    const template = synth();
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const table of Object.values(tables)) {
      expect(table.DeletionPolicy).toBe('Delete');
      expect(table.UpdateReplacePolicy).toBe('Delete');
    }
  });

  it('fares: PK fareId, TTL on expiresAt', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'fareId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('rides: PK rideId, driverId-status GSI (keys only) and riderId-createdAt GSI (all)', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'rideId', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'driverId-status',
          KeySchema: [
            { AttributeName: 'driverId', KeyType: 'HASH' },
            { AttributeName: 'status', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
        {
          IndexName: 'riderId-createdAt',
          KeySchema: [
            { AttributeName: 'riderId', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });
  });

  it('driver-offers: PK driverId, TTL on expiresAt, stream with new+old images for the offer audit', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'driverId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
  });

  it('exports table names and the offers stream ARN for deploy/outputs.json', () => {
    const template = synth();
    for (const name of ['FaresTableName', 'RidesTableName', 'OffersTableName', 'OffersStreamArn']) {
      template.hasOutput(name, {});
    }
  });

  it('tables carry the project/design tags', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([
        { Key: 'design', Value: 'uber-like-rides' },
        { Key: 'project', Value: 'SystemDesignDeepDives' },
      ]),
    });
  });
});
