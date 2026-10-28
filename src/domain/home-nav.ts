import { canApproveOrIssue } from './requisition-ui';

/**
 * A signed-in user's home-page navigation, as a pure list of links.
 *
 * Kept here (not inline in `src/app/page.tsx`) so the role-aware behaviour is
 * testable: the home page is the front door, and a dead-end front door is the
 * "white page after login" defect — the screens existed but nothing linked to
 * them. Least privilege by default: a role we do not recognise sees only the
 * screens everyone shares, never the warehouse-only ones.
 */
export interface HomeNavLink {
  href: string;
  /** The i18n key for the link's label. */
  key: string;
}

/** The screens every signed-in role may reach. Stock and requisitions are the
 * two things both the warehouse and a branch participate in. */
const EVERYONE: HomeNavLink[] = [
  { href: '/stock', key: 'stock.title' },
  { href: '/requisitions', key: 'requisitions.title' },
];

/** The screens only the warehouse side may reach. `canApproveOrIssue` is the
 * warehouse function (`owner` / `warehouse_manager`) and is disjoint from the
 * branch's `canRequest` — the owner of a request can never approve it. */
const WAREHOUSE_ONLY: HomeNavLink[] = [
  { href: '/intake', key: 'intake.title' },
  { href: '/stock/usage', key: 'stock.usage.heading' },
  { href: '/reports', key: 'reports.heading' },
];

export function navLinksForRole(role: string | null | undefined): HomeNavLink[] {
  return canApproveOrIssue(role) ? [...EVERYONE, ...WAREHOUSE_ONLY] : [...EVERYONE];
}