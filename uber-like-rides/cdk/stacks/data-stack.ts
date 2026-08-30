import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  StreamViewType,
  Table,
} from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

/**
 * Stateful stores (lld.md §3, §6). All tables on-demand and DESTROY — the lab
 * is built to be torn down; durability of the system of record is a
 * production-shape concern (design.md §5), not a lab one.
 */
export class DataStack extends Stack {
  readonly fares: Table;
  readonly rides: Table;
  readonly offers: Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.fares = new Table(this, 'Fares', {
      partitionKey: { name: 'fareId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.rides = new Table(this, 'Rides', {
      partitionKey: { name: 'rideId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Active-ride filter for the candidate finder: keys are all it needs.
    this.rides.addGlobalSecondaryIndex({
      indexName: 'driverId-status',
      partitionKey: { name: 'driverId', type: AttributeType.STRING },
      sortKey: { name: 'status', type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
    // Rider history listing wants full rows.
    this.rides.addGlobalSecondaryIndex({
      indexName: 'riderId-createdAt',
      partitionKey: { name: 'riderId', type: AttributeType.STRING },
      sortKey: { name: 'createdAt', type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    });

    // TTL (offeredAt + 10 s) garbage-collects expired offers; the stream is
    // the offer-audit source for the invariant auditor (lld.md §3).
    this.offers = new Table(this, 'DriverOffers', {
      partitionKey: { name: 'driverId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new CfnOutput(this, 'FaresTableName', { value: this.fares.tableName });
    new CfnOutput(this, 'RidesTableName', { value: this.rides.tableName });
    new CfnOutput(this, 'OffersTableName', { value: this.offers.tableName });
    new CfnOutput(this, 'OffersStreamArn', { value: this.offers.tableStreamArn ?? '' });
  }
}
