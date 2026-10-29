---
name: Warehouse
description: Stock operations console for small clothing brands — Arabic-first, phone-first, teal accent.
colors:
  primary: "#0f766e"
  primary-foreground: "#ffffff"
  neutral-bg: "#ffffff"
  neutral-text: "#1b1b1b"
  muted: "#f4f4f5"
  muted-foreground: "#71717a"
  destructive: "#b3261e"
  border: "#e4e4e7"
  ring: "#0f766e"
typography:
  body:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  display:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.2
  mono:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
spacing:
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0.6rem 1.1rem"
---

# Design System: Warehouse

## Overview

**Creative North Star: "The Quiet Ledger"**

A restrained, phone-first operations interface. The design serves warehouse staff working standing up, one-handed, on 390px screens. Typography is legible Arabic at small sizes; color is used sparingly — teal for the single primary action, red for problems, everything else neutral. No decoration; every pixel earns its place through clarity.

**Key Characteristics:**
- Arabic-first RTL, Latin digits, codes in LTR via `.ltr-value`
- 44px minimum tap targets, generous spacing
- Single accent (teal) used on ≤10% of any screen
- Flat surfaces, 1px borders, no shadows at rest
- System font stack with IBM Plex Sans Arabic

## Colors

Deep teal as the single accent; everything else is neutral gray.

### Primary
- **Deep Teal** (#0f766e): The one accent — primary buttons, focus rings, success states. Used on ≤10% of any screen. Its rarity is the point.

### Neutral
- **Ink** (#1b1b1b): Body text, headings.
- **Muted** (#71717a): Secondary text, hints, captions.
- **Surface** (#ffffff): Card and field backgrounds.
- **Border** (#e4e4e7): 1px borders on cards, inputs, dividers.
- **Muted Surface** (#f4f4f5): Secondary buttons, hover states, chips.

### Destructive
- **Danger Red** (#b3261e): Errors, problems, variance, secondary (outlined) actions on destructive items.

**The One Voice Rule.** The primary accent is used on ≤10% of any given screen. Its rarity is the point.

## Typography

**Display Font:** IBM Plex Sans Arabic (with system-ui, sans-serif fallback)
**Body Font:** IBM Plex Sans Arabic (with system-ui, sans-serif fallback)
**Label/Mono Font:** IBM Plex Mono (for codes, SKUs, barcodes)

**Character:** A single Arabic-capable family for both scripts, keeping the interface unified. Mono only for machine-read values.

### Hierarchy
- **Display** (700, 2rem, 1.2): Page titles, section headers.
- **Body** (400, 1rem, 1.6): All body text, labels, form fields. Max line length ~65ch.
- **Label** (500, 0.875rem, 1.4): Captions, hints, metadata.

## Layout

Phone-first column: single column on mobile (390px), max-width container on wider screens. 1rem horizontal padding. Sections separated by 1.25rem vertical rhythm. Flexbox with `min-width: 0` and `overflow-wrap: anywhere` on all catalogue strings to prevent overflow.

## Elevation & Depth

Flat by default. Surfaces are white cards with 1px borders. No shadows at rest. Shadows appear only as a response to state (hover, focus). Depth is conveyed through borders and background tonal shifts, not drop shadows.

## Shapes

Rounded corners throughout: 0.5rem (8px) for cards, inputs, buttons. Slightly smaller (0.375rem) for chips and badges. Consistent radius across all interactive elements.

## Components

### Buttons
- **Shape:** 8px radius, 44px min height.
- **Primary:** teal background, white text, full-width on mobile.
- **Secondary:** outlined, danger-red for destructive secondary actions.
- **Hover / Focus:** 2px teal outline, 1px offset.

### Cards
- **Corner Style:** 8px radius.
- **Background:** white surface.
- **Border:** 1px solid border color.
- **Internal Padding:** 0.75rem.

### Inputs / Fields
- **Style:** white background, 1px border, 8px radius, 44px min height.
- **Focus:** 2px teal outline, border color shifts to teal.
- **Error:** red text for problem messages.

### Navigation
- **Style:** sidebar on desktop (role-filtered), bottom tab bar on mobile for branch role. Sidebar trigger, breadcrumb, language switch, user menu.

## Do's and Don'ts

### Do:
- **Do** use teal only for primary actions and focus rings.
- **Do** keep all catalogue strings (names, SKUs) in `.ltr-value` for LTR rendering.
- **Do** provide 44px minimum tap targets on all interactive elements.
- **Do** include empty, loading, and error states for every screen.
- **Do** put all field styling in globals.css, never per-screen.

### Don't:
- **Don't** use teal for decoration or non-interactive elements.
- **Don't** invent per-screen field styling — the shared rules paint every control.
- **Don't** use shadows at rest — flat surfaces with borders.
- **Don't** break the RTL document flow for layout (only codes/SKUs are LTR).