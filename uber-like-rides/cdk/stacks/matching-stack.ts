import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Dashboard, GraphWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { AttributeType, BillingMode, Table, type ITable } from 'aws-cdk-lib/aws-dynamodb';
import { SubnetType, type ISecurityGroup, type IVpc } from 'aws-cdk-lib/aws-ec2';
import { StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import {
  Choice,
  Condition,
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  StateMachine,
  Succeed,
  TaskInput,
  Timeout,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import { CONFIG } from '../config';
import { nodeFn } from '../lambda';

export interface MatchingStackProps extends StackProps {
  ridesTable: ITable;
  offersTable: Table;
  vpc: IVpc;
  lambdaSecurityGroup: ISecurityGroup;
  redisEndpoint: string;
}

/**
 * Matching path (lld.md §5, §6): match queue + DLQ, SQS→SFN pump (execution
 * name = rideId), the candidates → offer(waitForTaskToken 10 s) → release →
 * loop state machine with the 60 s budget carried as a deadline in the
 * workflow context, offer-audit table fed by the driver-offers stream, and
 * the paging alarms (match p99, oldest message age, DLQ non-empty).
 */
export class MatchingStack extends Stack {
  readonly matchQueue: Queue;
  readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: MatchingStackProps) {
    super(scope, id, props);

    const dlq = new Queue(this, 'MatchDlq', { retentionPeriod: Duration.days(4) });
    this.matchQueue = new Queue(this, 'MatchQueue', {
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    const vpcPlacement = {
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSecurityGroup],
    };

    const candidatesFn = nodeFn(this, 'CandidatesFn', {
      entry: 'matching/candidates.ts',
      environment: {
        REDIS_ENDPOINT: props.redisEndpoint,
        RIDES_TABLE: props.ridesTable.tableName,
        SEARCH_RADIUS_KM: CONFIG.SEARCH_RADIUS_KM,
        CANDIDATE_LIMIT: CONFIG.CANDIDATE_LIMIT,
      },
      ...vpcPlacement,
    });
    props.ridesTable.grantReadWriteData(candidatesFn); // GSI query + idempotent markMatching

    const offerFn = nodeFn(this, 'OfferFn', {
      entry: 'matching/offer.ts',
      environment: {
        REDIS_ENDPOINT: props.redisEndpoint,
        RIDES_TABLE: props.ridesTable.tableName,
        OFFERS_TABLE: props.offersTable.tableName,
        LOCK_TTL_MS: CONFIG.LOCK_TTL_MS,
      },
      ...vpcPlacement,
    });
    props.ridesTable.grantWriteData(offerFn);
    props.offersTable.grantWriteData(offerFn);

    const releaseFn = nodeFn(this, 'ReleaseFn', {
      entry: 'matching/release.ts',
      environment: {
        REDIS_ENDPOINT: props.redisEndpoint,
        RIDES_TABLE: props.ridesTable.tableName,
        OFFERS_TABLE: props.offersTable.tableName,
      },
      ...vpcPlacement,
    });
    props.ridesTable.grantWriteData(releaseFn);
    props.offersTable.grantWriteData(releaseFn);

    const failFn = nodeFn(this, 'FailFn', {
      entry: 'matching/fail.ts',
      environment: { RIDES_TABLE: props.ridesTable.tableName },
    });
    props.ridesTable.grantWriteData(failFn);

    // --- state machine (lld.md §5) ---

    const getCandidates = new LambdaInvoke(this, 'GetCandidates', {
      lambdaFunction: candidatesFn,
      payload: TaskInput.fromObject({
        rideId: JsonPath.stringAt('$.rideId'),
        pickup: JsonPath.objectAt('$.pickup'),
        excluded: JsonPath.listAt('$.excluded'),
        deadlineMs: JsonPath.numberAt('$.deadlineMs'),
      }),
      resultSelector: { 'candidates.$': '$.Payload.candidates' },
      resultPath: '$.search',
    });

    const offerToDriver = new LambdaInvoke(this, 'OfferToDriver', {
      lambdaFunction: offerFn,
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      taskTimeout: Timeout.duration(Duration.millis(Number(CONFIG.LOCK_TTL_MS))),
      payload: TaskInput.fromObject({
        rideId: JsonPath.stringAt('$.rideId'),
        driverId: JsonPath.stringAt('$.search.candidates[0].driverId'),
        pickup: JsonPath.objectAt('$.pickup'),
        priceCents: JsonPath.numberAt('$.priceCents'),
        excluded: JsonPath.listAt('$.excluded'),
        taskToken: JsonPath.taskToken,
      }),
      resultPath: JsonPath.DISCARD,
    });

    const releaseOffer = new LambdaInvoke(this, 'ReleaseOffer', {
      lambdaFunction: releaseFn,
      payload: TaskInput.fromObject({
        rideId: JsonPath.stringAt('$.rideId'),
        driverId: JsonPath.stringAt('$.search.candidates[0].driverId'),
        pickup: JsonPath.objectAt('$.pickup'),
        priceCents: JsonPath.numberAt('$.priceCents'),
        excluded: JsonPath.listAt('$.excluded'),
        deadlineMs: JsonPath.numberAt('$.deadlineMs'),
      }),
      outputPath: '$.Payload', // release returns the full next context, driver now excluded
    });

    const markFailed = new LambdaInvoke(this, 'MarkFailed', {
      lambdaFunction: failFn,
      payload: TaskInput.fromObject({ rideId: JsonPath.stringAt('$.rideId') }),
      resultPath: JsonPath.DISCARD,
    });

    // Timeout (10 s), decline, and LOCK_BUSY all land on the same idempotent release path.
    offerToDriver.addCatch(releaseOffer, { errors: ['States.ALL'], resultPath: '$.offerError' });
    releaseOffer.next(getCandidates);

    const definition = getCandidates.next(
      new Choice(this, 'AnyCandidates')
        .when(Condition.isPresent('$.search.candidates[0]'), offerToDriver.next(new Succeed(this, 'Matched')))
        .otherwise(markFailed.next(new Succeed(this, 'NoMatch'))),
    );

    this.stateMachine = new StateMachine(this, 'MatchStateMachine', {
      definitionBody: DefinitionBody.fromChainable(definition),
      // Backstop only — the real 60 s budget travels as deadlineMs in the
      // context and is enforced in GetCandidates, so MarkFailed still runs.
      timeout: Duration.seconds(2 * Number(CONFIG.MATCH_BUDGET_S)),
    });

    const pumpFn = nodeFn(this, 'PumpFn', {
      entry: 'matching/pump.ts',
      environment: {
        STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
        MATCH_BUDGET_S: CONFIG.MATCH_BUDGET_S,
      },
    });
    this.stateMachine.grantStartExecution(pumpFn);
    pumpFn.addEventSource(new SqsEventSource(this.matchQueue, { batchSize: 10, reportBatchItemFailures: true }));

    // --- offer audit (lld.md §3): the invariant auditor's source of record ---

    const auditTable = new Table(this, 'OfferAudit', {
      partitionKey: { name: 'driverId', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const auditFn = nodeFn(this, 'OfferAuditFn', {
      entry: 'matching/offer-audit.ts',
      environment: { AUDIT_TABLE: auditTable.tableName },
    });
    auditTable.grantWriteData(auditFn);
    auditFn.addEventSource(
      new DynamoEventSource(props.offersTable, { startingPosition: StartingPosition.TRIM_HORIZON, batchSize: 100 }),
    );

    // --- observability (lld.md §6: paging alarms + dashboard) ---

    new Alarm(this, 'MatchP99Alarm', {
      metric: this.stateMachine.metricTime({ statistic: 'p99', period: Duration.minutes(1) }),
      threshold: Number(CONFIG.MATCH_BUDGET_S) * 1000,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Match p99 above the 60 s budget (hld.md NFR-1)',
    });
    new Alarm(this, 'QueueAgeAlarm', {
      metric: this.matchQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
      threshold: 60,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Ride requests waiting >60 s to start matching (hld.md §8)',
    });
    new Alarm(this, 'DlqAlarm', {
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: 'Poison ride request in the DLQ (hld.md §8, drill 10.3)',
    });

    new Dashboard(this, 'MatchingDashboard', {
      widgets: [
        [
          new GraphWidget({
            title: 'Match latency',
            left: [this.stateMachine.metricTime({ statistic: 'p50' }), this.stateMachine.metricTime({ statistic: 'p99' })],
          }),
          new GraphWidget({
            title: 'Queue',
            left: [
              this.matchQueue.metricApproximateNumberOfMessagesVisible(),
              this.matchQueue.metricApproximateAgeOfOldestMessage(),
            ],
          }),
          new GraphWidget({
            title: 'Executions',
            left: [
              this.stateMachine.metricSucceeded(),
              this.stateMachine.metricFailed(),
              this.stateMachine.metricTimedOut(),
            ],
          }),
        ],
      ],
    });

    new CfnOutput(this, 'MatchQueueUrl', { value: this.matchQueue.queueUrl });
    new CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn });
    new CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });
  }
}
