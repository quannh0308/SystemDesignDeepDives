import { App } from 'aws-cdk-lib';
import { applyProjectTags } from './tags';
import { ApiStack } from './stacks/api-stack';
import { DataStack } from './stacks/data-stack';
import { LocationStack } from './stacks/location-stack';
import { MatchingStack } from './stacks/matching-stack';

const app = new App();

// Region pinned (tasks.md 1.3); account deliberately unset — synth stays
// fully local (no credential/context lookups, local-first rule) and the
// account binds at deploy time (task 7).
const env = {
  region: process.env.CDK_DEFAULT_REGION ?? 'eu-central-1',
};

const data = new DataStack(app, 'DataStack', { env, stackName: 'uber-rides-data-stack' });
const location = new LocationStack(app, 'LocationStack', { env, stackName: 'uber-rides-location-stack' });
new ApiStack(app, 'ApiStack', {
  env,
  stackName: 'uber-rides-api-stack',
  locationHandler: location.locationHandler,
  faresTable: data.fares,
  ridesTable: data.rides,
});
new MatchingStack(app, 'MatchingStack', { env, stackName: 'uber-rides-matching-stack' });

applyProjectTags(app);
