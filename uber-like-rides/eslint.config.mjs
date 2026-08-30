import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'cdk.out/**', 'coverage/**', 'deploy/**', 'fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
