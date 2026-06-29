# Typography Refinement Design

## Summary

Adopt the approved **Crisp compact** typography direction across the application UI. Reduce the visual heaviness caused by widespread 700/800 weights while preserving the dense, efficient layout expected from a subtitle editor.

## Design System

- Keep a local/system sans-serif stack; do not introduce web-font downloads or new runtime dependencies.
- Define reusable typography tokens for the UI font stack, the 11/12/13/15/17px scale, and regular/medium/semibold weights.
- Use 600 for headings, buttons, compact labels, and emphasized UI text; use 400–500 for descriptions, metadata, notices, and ordinary controls.
- Apply subtle negative tracking only to headings. Retain tabular numerals for timestamps, durations, and progress values.
- Keep body and helper line heights around 1.4–1.5 so compact text remains readable.

## Scope and Boundaries

- Refine global UI typography and the dense editor surfaces: header, panels, toolbars, forms, timeline labels, player editor, status cards, subtitle rows, dialogs, and notices.
- Preserve the bold video subtitle overlay because it needs strong contrast against moving imagery.
- Do not change colors, spacing, component structure, control behavior, or responsive breakpoints except where a typography rule requires a small readability correction.
- Preserve light/dark theme behavior and all existing accessibility semantics.

## Verification

- Add deterministic CSS assertions for the typography tokens and the reduced button/label weights.
- Run the full test suite, lint, typecheck, and production build.
- Review representative desktop and narrow layouts for wrapping, clipping, hierarchy, and unchanged control sizing.
- Update `README.md` and `docs/project-state.md` to describe the local/system typography scale and the intentional bold-caption exception.
