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
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  // Import-boundary rules (MAP.md §1, ticket F-01)
  {
    files: ['src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/modules/*/server', '@/modules/*/server/*'],
              message:
                "Import another module only via its index.ts (e.g. '@/modules/ledger/index'), never its server/ internals.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/modules/*/domain/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'next', message: 'domain/ must not import next' },
            { name: 'pg', message: 'domain/ must not import pg' },
            { name: 'react', message: 'domain/ must not import React' },
            { name: 'react-dom', message: 'domain/ must not import React DOM' },
          ],
          patterns: [
            { group: ['next/*'], message: 'domain/ must not import next/*' },
            { group: ['react/*', 'react-dom/*'], message: 'domain/ must not import React' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/modules/*/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/modules/*/server', '@/modules/*/server/*'],
              message:
                'ui/ must not import server/ directly — receive data via props or call a server action.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/components/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/modules/**'],
              message: 'src/components/ui/* (shadcn primitives) must not import from modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'src/app/* must not run SQL directly (call the module)' },
          ],
        },
      ],
    },
  },
];

export default config;
