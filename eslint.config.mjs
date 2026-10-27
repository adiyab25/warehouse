import next from 'eslint-config-next';

const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'coverage/**',
      'supabase/.temp/**',
      'next-env.d.ts',
    ],
  },
  ...next,
  {
    rules: {
      // App Router only — there is no `pages/` directory, and the rule just
      // complains about that on every run.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
];

export default config;
