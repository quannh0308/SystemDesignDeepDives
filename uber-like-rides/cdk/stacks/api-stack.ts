import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { nodeFn } from '../lambda';

export interface ApiStackProps extends StackProps {
  /** Location handler from location-stack — routed here, deployed there. */
  locationHandler: IFunction;
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

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'SimSecretArn', { value: this.simSecret.secretArn });
  }
}
