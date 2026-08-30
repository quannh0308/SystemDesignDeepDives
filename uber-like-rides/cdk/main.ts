import { App } from 'aws-cdk-lib';
import { applyProjectTags } from './tags';
import { ApiStack } from './stacks/api-stack';
import { DataStack } from './stacks/data-stack';
import { LocationStack } from './stacks/location-stack';
import { MatchingStack } from './stacks/matching-stack';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1',
};

new DataStack(app, 'DataStack', { env, stackName: 'uber-rides-data-stack' });
new LocationStack(app, 'LocationStack', { env, stackName: 'uber-rides-location-stack' });
new ApiStack(app, 'ApiStack', { env, stackName: 'uber-rides-api-stack' });
new MatchingStack(app, 'MatchingStack', { env, stackName: 'uber-rides-matching-stack' });

applyProjectTags(app);
