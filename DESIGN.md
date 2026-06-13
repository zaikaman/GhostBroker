---
name: GhostBroker Design System
description: Institutional Cryptographic Dark Pool Design System
colors:
  primary: "#5ed29c"
  neutral-bg: "#070b0a"
  neutral-text: "#ffffff"
  border: "rgba(255, 255, 255, 0.05)"
typography:
  display:
    fontFamily: "Cinzel, serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.1em"
  body:
    fontFamily: "Plus Jakarta Sans, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: "normal"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "24px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#070b0a"
    rounded: "9999px"
    padding: "1.1rem 2.2rem"
  button-primary-hover:
    backgroundColor: "#4ec28c"
  card:
    backgroundColor: "rgba(255, 255, 255, 0.01)"
    rounded: "{rounded.xl}"
    padding: "2.5rem"
---

# Design System: GhostBroker

## 1. Overview

**Creative North Star: "The Attested Enclave"**

GhostBroker is an institutional dark pool observatory interface. The design system is constructed to convey absolute security, confidentiality, and machine-attested authority. It rejects typical neon-slop consumer crypto widgets, SaaS-blue layouts, and multi-colored grid cards in favor of a clean, highly structured, dark glassmorphic design.

The key visual drivers are the HLS-streamed vertical light movements operating at very low opacity to give the canvas a responsive feel, coupled with an SVG radial blur glow that simulates the attested enclave boundary.

**Key Characteristics:**
- Dark, monochromatic foundations with clean emerald green (`#5ed29c`) indicators.
- Double-mask composited glassmorphic border elements providing depth.
- Clear typographic separation of displays (Cinzel), body copy (Plus Jakarta Sans), and cryptographic data (Share Tech Mono).

## 2. Colors

A highly restrained dark institutional palette optimized for dark room operations.

### Primary
- **Enclave Emerald** (#5ed29c): Used for system attestation status badges, primary action highlights, and active enclave session counts.

### Neutral
- **Deep Black-Tint** (#070b0a): The default background of the entire platform, providing high contrast for glowing enclaves.
- **Pure White** (#ffffff): Text primary and headers.
- **Faded White** (rgba(255, 255, 255, 0.75)): Secondary copy and system descriptions.
- **Muted White** (rgba(255, 255, 255, 0.45)): Subtext and captions.

### Named Rules
**The Rarity Rule.** Emerald green is used strictly for successful cryptographic attestation or key CTA states. It must never exceed 10% of any visible screen surface.

## 3. Typography

**Display Font:** Cinzel (with serif fallback)
**Body Font:** Plus Jakarta Sans (with sans-serif fallback)
**Label/Mono Font:** Share Tech Mono
**Serif Highlight:** Instrument Serif (italic style)

**Character:** A pairing of classical, authoritative Display font with high-legibility sans-serif copy, accented by a tech-mono font for cryptographic telemetry.

### Hierarchy
- **Display** (800, 1.5rem / 24px, 1.2): Used for primary brand markers.
- **Headline** (700, 1.75rem / 28px, 1.25): Main page headers and section titles.
- **Title** (700, 0.95rem / 15px, 1.3): Card-level headers.
- **Body** (500, 14px, 1.6): Standard user reading text. Max line length is 75ch.
- **Label** (700, 10px, 0.25em, uppercase): Eyebrows, status badges, and action tags.

## 4. Elevation

The system uses flat glassmorphism to show depth. Layering is conveyed through subtle backdrop blurs and double-mask borders.

### Named Rules
**The Flat-By-Default Rule.** All layouts rest flat on the background with 12px backdrop blur. Elevation is shown only via high-contrast border states on hover, rather than traditional drop shadows.

## 5. Components

### Buttons
- **Shape:** Pill-shaped (9999px radius)
- **Primary:** Background color is Enclave Emerald (`#5ed29c`), text is Deep Black-Tint (`#070b0a`), padding is `1.1rem 2.2rem`.
- **Hover / Focus:** Emerald background transitions to `#4ec28c` with translateY(-2px) and subtle outer glow.

### Cards / Containers
- **Corner Style:** Rounded (24px radius for outer components, 12px for nested boxes)
- **Background:** `rgba(255, 255, 255, 0.01)` with `backdrop-filter: blur(12px)`
- **Border:** Styled via `::before` pseudo-element with `inset: 0` and double-mask compositing to yield a sharp 1.2px gradient line.
- **Internal Padding:** Large (`2.5rem` to `3rem`) for main cards, moderate (`1rem`) for list boxes.

### Inputs / Fields
- **Style:** Background is `rgba(255, 255, 255, 0.02)`, border is `1px solid rgba(255, 255, 255, 0.05)`, radius is `8px`.
- **Focus:** Accent border turns to Enclave Emerald (`#5ed29c`) with a subtle glow.

## 6. Do's and Don'ts

### Do:
- **Do** wrap primary blocks in glassmorphic `.card` selectors to ensure unified backdrop blurs.
- **Do** format all cryptographically secure/sensitive data columns using the monospace `Share Tech Mono` font.
- **Do** preserve the "Zero Human Access" TEE secure enclave disclaimer in compliance boundaries.

### Don't:
- **Don't** add colored left-stripe or right-stripe borders as card accents.
- **Don't** use neon gradient text for numbers or telemetry fields.
- **Don't** use standard SaaS-blue grids or cards.
