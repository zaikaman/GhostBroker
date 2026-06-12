<!--
Sync Impact Report:
- Version Change: None -> 1.0.0 (Initial adoption)
- Modified Principles: None
- Added Sections: Core Principles (I. Code Quality, II. Testing Standards, III. User Experience Consistency, IV. Performance & Responsiveness, V. Security & ZK Compliance), Additional Constraints, Development Workflow & Quality Gates, Governance
- Removed Sections: None
- Templates requiring updates:
  - ✅ Updated: .specify/templates/tasks-template.md (aligned tests from optional to mandatory)
  - ✅ Updated: .specify/templates/spec-template.md (no actions needed, aligned with testing/quality requirements)
  - ✅ Updated: .specify/templates/plan-template.md (no actions needed, aligned with checks)
- Follow-up TODOs: None
-->
# GhostBroker Constitution

## Core Principles

### I. Code Quality & Maintainability
All code MUST be clean, well-structured, self-documenting, and strictly typed. TypeScript is mandatory, and the use of `any` or loose typing is forbidden. Components MUST be small, focused, and single-purpose. Inline styling is prohibited; instead, leverage centralized design tokens and the project's core CSS custom properties to ensure consistency and prevent styling duplication.

### II. Testing Discipline (NON-NEGOTIABLE)
Every new feature, component, and utility MUST have corresponding automated tests. Unit tests are required for helpers, custom hooks, and utilities. React components MUST have unit or integration tests verifying core behavior and accessibility landmarks (using Vitest, React Testing Library, and `@testing-library/jest-dom`). Tests MUST run automatically in the CI pipeline and pass completely before any code merge.

### III. User Experience & Design Consistency
User interfaces MUST adhere strictly to the established design system (defined in `theme.css`) to maintain design coherence across all dashboards (patient, clinic, insurer). Developers MUST use curated, harmonious color palettes, modern typography, and glassmorphism. Standardize loading indicators, error boundaries, empty states, hover interactions, and transitions. Ad-hoc custom layouts that break the design grid are prohibited.

### IV. Performance & Responsiveness
Web applications MUST load quickly and maintain low latency. Bundle sizes must be kept to a minimum, and heavy resources/assets optimized. Redundant state re-renders and unnecessary network requests are strictly forbidden; developers MUST use optimized state management and hooks (such as `useRef` for tracking auth states and memoizing expensive computations) to avoid performance degradation. The target is a page load time of under 2 seconds and 60fps animations.

### V. Zero-Knowledge & Security Compliance
Zero-knowledge credential verification workflows and user data privacy MUST be protected with highest priority. Sensitive health data, personal identifying information (PII), and keys/credentials must never be leaked, logged in plain text, or exposed to third parties. All blockchain, smart contract, and backend API interactions MUST be securely authenticated, audited, and encrypted.

## Technical Constraints & Standards

All code MUST be implemented in React (using Vite as the build tool), TypeScript, Vitest for testing, and Vanilla CSS for layout and styling (avoiding utility-first CSS frameworks like Tailwind CSS unless explicitly required). Project organization follows a clean mono-repo or multi-project structure separating frontend and backend codebases.

## Development Workflow & Quality Gates

1. **Plan & Specify**: Features must have a spec file and an approved implementation plan before writing any code.
2. **Test-First Philosophy**: Write contract and integration tests first to verify they fail, then implement the logic to make them pass.
3. **Continuous Integration**: Code quality checks, TypeScript compiler diagnostics, ESLint rules, and Vitest test suites must run and pass on all pull requests.

## Governance

This Constitution serves as the ultimate authority for development quality and standards. Amendments to this document must be proposed via a branch change to `.specify/memory/constitution.md`, with version updates incremented according to semantic versioning (Major/Minor/Patch). All pull requests must verify compliance with this Constitution.

**Version**: 1.0.0 | **Ratified**: 2026-06-12 | **Last Amended**: 2026-06-12
