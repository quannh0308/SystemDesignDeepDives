import { describe, expect, it } from 'vitest';
import { extractImports, isHarnessImport } from './check-deps';

describe('extractImports', () => {
  it('finds static, dynamic, type-only, and require specifiers', () => {
    const source = [
      `import { a } from './a';`,
      `import type { B } from '../rides/store';`,
      `export { c } from './c';`,
      `const d = await import('../sim/driver-sim');`,
      `const e = require('node:fs');`,
      `import '@aws-sdk/client-dynamodb';`, // side-effect import has no 'from' — not matched, and bare anyway
    ].join('\n');
    expect(extractImports(source)).toEqual([
      './a',
      '../rides/store',
      './c',
      '../sim/driver-sim',
      'node:fs',
    ]);
  });
});

describe('isHarnessImport', () => {
  const srcRoot = '/repo/src';

  it('flags a runtime file importing a harness dir', () => {
    expect(isHarnessImport('/repo/src/rides/handler.ts', '../sim/driver-sim', srcRoot)).toBe(true);
    expect(isHarnessImport('/repo/src/matching/offer.ts', '../testdata/fleet', srcRoot)).toBe(true);
    expect(isHarnessImport('/repo/src/location/handler.ts', '../e2e/invariants', srcRoot)).toBe(true);
  });

  it('allows runtime → runtime imports', () => {
    expect(isHarnessImport('/repo/src/rides/handler.ts', './store', srcRoot)).toBe(false);
    expect(isHarnessImport('/repo/src/matching/offer.ts', '../rides/store', srcRoot)).toBe(false);
  });

  it('allows bare specifiers (npm and node builtins)', () => {
    expect(isHarnessImport('/repo/src/rides/store.ts', '@aws-sdk/lib-dynamodb', srcRoot)).toBe(false);
    expect(isHarnessImport('/repo/src/rides/store.ts', 'node:crypto', srcRoot)).toBe(false);
  });

  it('allows relative imports that escape src/ (e.g. generated config)', () => {
    expect(isHarnessImport('/repo/src/rides/handler.ts', '../../deploy/outputs.json', srcRoot)).toBe(false);
  });
});
