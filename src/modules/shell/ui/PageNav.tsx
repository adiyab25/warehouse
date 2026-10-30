'use client';

import { useRouter } from 'next/navigation';

const PAGES = [
  { href: '/', label: 'Home' },
  { href: '/stock', label: 'Stock (On-Hand)' },
  { href: '/stock/usage', label: 'Stock Usage' },
  { href: '/requisitions', label: 'Requisitions' },
  { href: '/intake', label: 'Goods Intake' },
  { href: '/items', label: 'Items & Variants' },
  { href: '/locations', label: 'Locations' },
  { href: '/returns', label: 'Returns' },
  { href: '/counts', label: 'Stock Counts' },
  { href: '/usage', label: 'Branch Usage' },
  { href: '/reports', label: 'Reports' },
  { href: '/roles', label: 'Roles' },
  { href: '/users', label: 'Users' },
  { href: '/api-keys', label: 'API Keys' },
  { href: '/audit-log', label: 'Audit Log' },
];

export function PageNav() {
  const router = useRouter();
  return (
    <select
      onChange={(e) => {
        if (e.target.value) router.push(e.target.value);
      }}
      defaultValue=""
      style={{ padding: '4px 8px', border: '1px solid #0f766e', borderRadius: 6, fontSize: 14, color: '#0f766e', backgroundColor: 'white', cursor: 'pointer' }}
    >
      <option value="" disabled>Pages</option>
      {PAGES.map((p) => (
        <option key={p.href} value={p.href} style={{ color: '#1a1a1a' }}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
