# ADR-0001: Default brand identity (reversible)

**Date:** 2026-10-29
**Status:** Accepted (default, reversible)

## Context

F-02 (Impeccable init) requires owner answers for brand accent colour, app name, and logo. The owner has not yet provided specific preferences. Per kickoff §3.4, when there is no answer, use defaults and record "default, reversible".

## Decision

Use the following defaults:
- **Brand accent:** deep teal `#0f766e`
- **App name:** "Warehouse"
- **Logo:** text logo

These are recorded in PRODUCT.md (Brand Commitments) and DESIGN.md (Colors, Overview).

## Consequences

- The owner can override any of these at any time by re-running `/impeccable init` with their preferences.
- All downstream tickets (F-03 tokens, F-04 app frame, F-05 shared components) should use the teal accent as the primary colour.
- If the owner chooses a different accent, only the token values in globals.css and DESIGN.md need to change.