import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import type { StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import { CONFIG } from '../config';
import { nodeFn } from '../lambda';

export interface ApiStackProps extends StackProps {
  /** Location handler from location-stack — routed here, deployed there. */
  locationHandler: IFunction;
  faresTable: ITable;
  ridesTable: ITable;
  offersTable: ITable;
  matchQueue: IQueue;
  stateMachine: StateMachine;
}

/**
 * Front door (lld.md §2, §6): HTTP API with the HMAC Lambda authorizer as the
 * default on every route — no route ships unauthenticated. `SIM_SECRET` is
 * generated at deploy time in Secrets Manager; its ARN is exported for the
 * harness (which mints tokens with the same secret). Fare/ride routes arrive
 * with tasks 4–5.
 */
export class ApiStack extends Stack {
  readonly httpApi: HttpApi;
  readonly simSecret: Secret;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    this.simSecret = new Secret(this, 'SimSecret', {
      description: 'Lab HMAC secret for identity tokens (lld.md §2.1)',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
    });

    const authorizerFn = nodeFn(this, 'AuthorizerFn', {
      entry: 'auth/authorizer.ts',
      environment: { SIM_SECRET_ARN: this.simSecret.secretArn },
    });
    this.simSecret.grantRead(authorizerFn);

    this.httpApi = new HttpApi(this, 'HttpApi', {
      apiName: 'uber-rides-api',
      defaultAuthorizer: new HttpLambdaAuthorizer('HmacAuthorizer', authorizerFn, {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        identitySource: ['$request.header.Authorization'],
      }),
    });

    this.httpApi.addRoutes({
      path: '/drivers/location',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('LocationIntegration', props.locationHandler),
    });

    const faresFn = nodeFn(this, 'FaresFn', {
      entry: 'fares/handler.ts',
      environment: {
        FARES_TABLE: props.faresTable.tableName,
        FARE_TTL_S: CONFIG.FARE_TTL_S,
        CITY_BBOX: CONFIG.CITY_BBOX,
      },
    });
    props.faresTable.grantWriteData(faresFn);
    this.httpApi.addRoutes({
      path: '/fares',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('FaresIntegration', faresFn),
    });

    const ridesFn = nodeFn(this, 'RidesFn', {
      entry: 'rides/handler.ts',
      environment: {
        RIDES_TABLE: props.ridesTable.tableName,
        FARES_TABLE: props.faresTable.tableName,
        OFFERS_TABLE: props.offersTable.tableName,
        MATCH_QUEUE_URL: props.matchQueue.queueUrl,
      },
    });
    props.ridesTable.grantReadWriteData(ridesFn); // getRide + createRide + acceptRide guard
    props.faresTable.grantReadWriteData(ridesFn); // getFare + useFare guard
    props.offersTable.grantReadWriteData(ridesFn); // offer row lookup + conditional delete
    props.matchQueue.grantSendMessages(ridesFn);
    props.stateMachine.grantTaskResponse(ridesFn); // SendTaskSuccess / SendTaskFailure
    this.httpApi.addRoutes({
      path: '/rides',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('RidesCreateIntegration', ridesFn),
    });
    this.httpApi.addRoutes({
      path: '/rides/{rideId}',
      methods: [HttpMethod.GET, HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('RidesIntegration', ridesFn),
    });

    const offerPollFn = nodeFn(this, 'OfferPollFn', {
      entry: 'matching/offer-poll.ts',
      environment: { OFFERS_TABLE: props.offersTable.tableName },
    });
    props.offersTable.grantReadData(offerPollFn);
    this.httpApi.addRoutes({
      path: '/drivers/offer',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('OfferPollIntegration', offerPollFn),
    });

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'SimSecretArn', { value: this.simSecret.secretArn });
  }
}
