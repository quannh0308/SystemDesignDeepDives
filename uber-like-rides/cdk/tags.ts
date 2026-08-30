import { Tags } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** Every deployed resource carries these two tags (tasks.md 1.3). */
export function applyProjectTags(scope: IConstruct): void {
  Tags.of(scope).add('project', 'SystemDesignDeepDives');
  Tags.of(scope).add('design', 'uber-like-rides');
}
