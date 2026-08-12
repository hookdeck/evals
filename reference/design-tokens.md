# Hookdeck design tokens

Extracted from the Claude Design project "Hookdeck Design System", which derives them
from the website's `global.scss`, `type.scss`, `global.site.scss`, the pricing table and
the docs Tabs component. This is the vocabulary the published evals page is built in,
and the local results app should match it so it is a real preview rather than an
approximation.

Source: claude.ai design project `4cde400a-4aa2-4688-af40-11bef9b7a520`.

## Colour

| Token | Hex | |
|---|---|---|
| `--tan-bg` | `#fafaf8` | page background |
| `--bg-0` | `#ffffff` | cards |
| `--bg-1` | `#fafafa` | |
| `--bg-2` | `#f5f5f5` | secondary hover |
| `--bg-3` | `#ebebeb` | minimal hover, hairlines |
| `--bg-contrast` | `#141412` | |
| `--neutral-fg-1` | `#141412` | primary text |
| `--neutral-fg-2` | `#52504a` | secondary text |
| `--neutral-fg-3` | `#7a786e` | muted text |
| `--disabled-fg` | `#a3a093` | |
| `--neutral-outline-1` | `#ebebeb` | row dividers |
| `--neutral-outline-3` | `#cccccc` | |
| `--primary-blue-bg` | `#0044cc` | |
| `--primary-blue-bg-hover` | `#0036a3` | |
| `--blue-badge-bg` | `#e5ecfa` | |
| `--primary-badge-outline` | `#ccdaf5` | |
| `--focused-outline` | `#668fe0` | |

Status, as text / outline / surface:

| | text | outline | surface |
|---|---|---|---|
| success | `#006633` | `#cce6d9` | `#e5f2ec` |
| danger | `#cc2314` | `#f5d3d0` | `#fae9e7` |
| warning | `#997a00` | `#ffe066` | `#fff5cc` |

**Success green, not primary blue, is the pass colour.** The site reserves blue for
actions and links.

## Type

Figtree throughout (docs use Inter, but the evals page lives on the marketing site).
JetBrains Mono for code, identifiers and `badge--mono`. Titles 600, subtitles 500,
body 400.

| Spec | Size / line-height / tracking |
|---|---|
| `title-4xl` | 60 / 72 / -1.8 |
| `title-3xl` | 48 / 56 / -1.44 |
| `title-2xl` | 40 / 48 / -1.2 |
| `title-xl` | 32 / 40 / -0.64 |
| `subtitle-l` | 24 / 32 / -0.24 (weight 500) |
| `body-m` | 20 / 28 / +0.08 |
| `body-s` | 16 / 24 / +0.08 |
| `body-xs` | 14 / 20 / +0.07 |
| `mono-s` | 16 / 24, JetBrains Mono |

## Spacing, radius, elevation

4px base scale, `--s1` (4px) through `--s18` (72px). Content max-width 1128px.

Radius 4 / 6 / 10. Cards carry **no border**: a 1px ring inside the shadow stack, with
a `-2px` inset lip for the "puffy" variant. Body sits on tan, cards on white.

## Tables

The pricing-table pattern: no zebra stripes, no cell borders, no header fill. Hairline
row dividers (`#ebebeb`) only, 16px row padding, first column wide with muted
500-weight labels, section headers as bold in-table rows.

## Result states

The design system proposes these, and they cover the states that had no treatment:

| State | Rendering |
|---|---|
| pass | success badge |
| fail | danger badge, with checks passed: "Fail · 3/4" |
| pass, self-installed skill | success badge with a warning-amber asterisk |
| not run | dashed muted outline, `#a3a093` on `#fafafa` |

The asterisk on a self-installed pass is the right call: the run passed, the baseline
claim did not. That state had no design anywhere and it matters, because a `-no-skills`
row that installed a product skill is not a baseline.

Benchmark and regression never share a table or an aggregate number; regression renders
as its own quieter block. That matches the suite design, where the regression suite is
deliberately excluded from the published scoreboard.

## One mismatch to resolve

The design proposes a three-rung ladder rendered as escalating blue: **baseline → +MCP →
+skills**. There is no `+MCP` rung. The Event Gateway MCP server is read-only, eleven
analysis tools that cannot create or mutate, so it should lift investigate and resolve
while leaving build flat, and it was deliberately excluded as a launch row. The
published axis is two rungs: `-no-skills` and `+skills`.

Either the ladder becomes two rungs, or `+MCP` gets measured first and earns a third.
The second is a real option but it is not the current plan, and a three-rung visual
would imply data that does not exist.
