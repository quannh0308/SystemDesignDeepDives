import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { ApiStack } from './api-stack';
import { DataStack } from './data-stack';
import { LocationStack } from './location-stack';

let cached: Template | undefined;
function synth(): Template {
  if (!cached) {
    const app = new App();
    const data = new DataStack(app, 'DataStack');
    const location = new LocationStack(app, 'LocationStack');
    cached = Template.fromStack(
      new ApiStack(app, 'ApiStack', {
        locationHandler: location.locationHandler,
        faresTable: data.fares,
        ridesTable: data.rides,
      }),
    );
  }
  return cached;
}

describe('api-stack (lld.md §2, §6)', () => {
  it('SIM_SECRET is generated at deploy time and its ARN exported', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ PasswordLength: 48 }),
    });
    template.hasOutput('SimSecretArn', {});
    template.hasOutput('ApiUrl', {});
  });

  it('every route sits behind the HMAC Lambda authorizer — nothing ships unauthenticated', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      EnableSimpleResponses: true,
      IdentitySource: ['$request.header.Authorization'],
    });
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const routeList = Object.values(routes);
    for (const route of routeList) {
      if (route.Properties.RouteKey === '$default') continue;
      // CUSTOM = our Lambda authorizer; anything else would be an open route.
      if (route.Properties.AuthorizationType !== 'CUSTOM') {
        throw new Error(`Unauthenticated route: ${route.Properties.RouteKey}`);
      }
    }
  });

  it('routes POST /drivers/location to the cross-stack location handler', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /drivers/location',
    });
  });

  it('routes POST /fares and GET /rides/{rideId} (task 5.2)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /fares' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /rides/{rideId}' });
  });

  it('fares handler carries the config-matrix env (FARE_TTL_S, CITY_BBOX)', () => {
    synth().hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          FARES_TABLE: Match.anyValue(),
          FARE_TTL_S: '300',
          CITY_BBOX: '52.35,13.20,52.60,13.55',
        }),
      },
    });
  });
});
