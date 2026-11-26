# DESIGN.md — Investment Diary design tokens

Source of truth: `src/app/globals.css` (CSS variables, mapped to Tailwind in `@theme inline`).
Changes here are presentation only — no logic, API or schema changes.

## Colour tokens (dark = `dim`, light; same names in both)
| Token | Use |
|---|---|
| `primary` / `primary-ink` | main button, links, active tab; text on primary |
| `bg`, `surface`, `border` | page, card, dividers (`surface` keeps a slight transparency) |
| `text`, `text-muted` | main / secondary text |
| `positive`, `negative` | **only** up/down, profit/loss — never decoration |
| `warning` | Yellow threshold status |
| `chart-1..6` | chart series; independent of positive/negative |
| `cat-stock / fund / bond / valuation / notes / metrics / event` | category icon chips (Phase 3.5): blue / purple / teal / orange / amber / pink / red-orange |

### Legacy aliases (kept until each page is migrated in Phase 4)
`--accent→primary`, `--panel→surface`, `--muted→text-muted`, `--pos→positive`, `--neg→negative`, `--warn→warning`, `--series-N→chart-N`, `--accent-ink→primary-ink`.

### Contrast (WCAG AA ≥ 4.5:1, text tokens)
Dim on surface: text 15.1, text-muted 8.1, primary 10.2, positive 10.3, negative 6.7, warning 11.1.
Light on white: text 17.3, text-muted 6.4, primary 5.6, positive 5.7, negative 5.1, warning 5.2. Light `cat-*` colours are all ≥ 4.5 (teal darkened to `#0b7a6e`).

## Typography
Fonts: `Inter` (Latin, digits) then `IBM Plex Sans Thai`. Sizes only: **12 / 14 / 16 / 20 / 28 px** → `text-xs / sm / base / lg|xl / 2xl|3xl`. Weights only **400 / 500 / 600**. Body = 14px. Numbers use `tabular-nums` (`.num`).

## Spacing, shape, depth
- Spacing scale: **4, 8, 12, 16, 24, 32, 48 px** (Tailwind 1, 2, 3, 4, 6, 8, 12). Off-scale classes (0.5, 1.5, 2.5, 3.5, 5, 7, 9…) are removed page by page in Phase 4.
- Radius: **6px** input/button (`rounded-md`), **12px** card (`rounded-xl`); `rounded-full` only for pills/dots.
- Shadow: one light level (`--shadow`); every Tailwind shadow maps to it.
- Glass: slight transparency + 12px blur; disabled by `prefers-reduced-transparency`.

## Rules
1. No hard-coded hex / off-scale px in components — use tokens.
2. positive/negative only for direction of change.
3. Colour is never the only signal (arrow/label too).
4. Every phase: tests unchanged and passing, before/after screenshots in both themes.
