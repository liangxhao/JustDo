# Style Guide

**The default source for colors, typography, and tokens.** Resolve semantic roles from the effective project style guide or profile selected by [`profiles.md`](profiles.md), then use this guide for defaults. Keep this installed file unchanged; customization belongs in the project working copy and task output.

Default skin is a cool editorial palette — white-smoke paper, jet-black ink, burnt-tangerine accent, blue-slate muted. Override the selected output tokens (or follow [`onboarding.md`](onboarding.md)) to customize a diagram without changing the installed references.

To extract task tokens from local materials or an internal website, see [`onboarding.md`](onboarding.md).

---

## Tokens

### Semantic roles

Every token is referred to by **semantic role**, not by its hex value. Type references (`type-*.md`) and SKILL.md say `accent`, not `#f7591f`.

| Role | Purpose | Default (light) | Default (dark) |
|---|---|---|---|
| `paper` | Page background, default node fill | `#f5f5f5` (white-smoke) | `#2d3142` (jet-black) |
| `paper-2` | Diagram container bg, secondary fill | `#ececec` | `#393e53` |
| `ink` | Primary text, primary stroke | `#2d3142` (jet-black) | `#f5f5f5` (white-smoke) |
| `ink-strong` | High-contrast text on warm accent fills | `#111111` | `#111111` |
| `muted` | Secondary text, default arrow stroke | `#4f5d75` (blue-slate) | `#bfc0c0` (silver) |
| `soft` | Sublabels, boundary labels | `#5a6580` | `#949eb2` |
| `rule` | Hairline borders | `rgba(45,49,66,0.12)` | `rgba(245,245,245,0.12)` |
| `rule-solid` | Stronger borders, baselines | `#bfc0c0` (silver) | `rgba(191,192,192,0.25)` |
| `accent` | Focal / 1–2 max per diagram | `#bf4520` (burnt-tangerine) | `#f08a59` |
| `accent-tint` | Fill for accent-bordered boxes | `rgba(191,69,32,0.08)` | `rgba(240,138,89,0.10)` |
| `link` | HTTP/API calls, external arrows | `#2e5aa8` | `#739fdf` |

> **Brand palette source:** this skin maps to a five-color brand palette: `jet-black #2d3142`, `silver #bfc0c0`, `white-smoke #f5f5f5`, `atomic-tangerine`, `blue-slate #4f5d75`. The light `accent` is not the raw brand tangerine. Raw atomic-tangerine reads 2.86:1 on `paper`, too faint for an arrow or a label, so the skin uses `#bf4520`, the same hue darkened until it clears 4.5:1 as text. The `soft`, `rule`, and `link` tokens are derived (a darker slate, ink at opacity, and a saturated variant in the blue-slate hue family) to cover roles the brand palette doesn't name directly. Every derived value is held to the contrast contract below.

> **Note:** The pre-baked example HTML files in `assets/` were built under an earlier skin. Regenerating them against the current `style-guide.md` is a v5.1 task. New diagrams the skill produces will use the tokens above.

### Contrast contract

Every token must clear the threshold for each role it plays, against the background it actually sits on, in both skins.

| Use | Minimum vs. its actual background |
|---|---|
| Regular text, including any `soft`, `link`, or `accent` used as text | 4.5:1 |
| Large text (24px+, or 18.7px+ at weight 600+) | 3:1 |
| Essential non-text marks: lines, arrows, borders, focus outlines, data points | 3:1 against the adjacent color |
| Decorative rules and translucent tints (`rule`, `rule-solid`, `paper-2`, `accent-tint`, fills at opacity) | No minimum, but never the only carrier of meaning |

- **A token used in several roles must pass each one.** `accent` is a stroke in one place and a label in another, so it is held to 4.5:1, not the 3:1 its strokes alone would need. Don't assume a token is non-text because it usually is.
- **Translucent colors are composited first.** An `rgba()` fill or stroke is blended over `paper` before its ratio is measured. A value that clears the bar at full strength can fail at 0.5 opacity.
- **Surfaces other than `paper` cost contrast.** Inside an `accent-tint` box or on `paper-2` every ratio drops. Measure text placed there against that surface, not against `paper`.
- **Current defaults:** light `accent` 4.71:1, `soft` 5.34:1, `link` 6.13:1, `muted` 6.11:1 on `#f5f5f5`; dark `accent` 5.21:1, `soft` 4.78:1, `link` 4.76:1 on `#2d3142`.

### Inversion rule (light → dark)

Any `rgba(28,25,23, X)` in light becomes `rgba(250,247,242, X)` in dark. Same opacities, RGB flipped. The accent gets a slight hue-shift brighter to read on dark paper.

### Series palette (multi-series chart types only)

A small set of desaturated, editorial-tone colors for chart types that genuinely need to distinguish multiple overlapping entities (currently: **radar**). The "1-focal" rule still holds — `accent` is reserved for the focal series; the palette below covers the rest.

| Token | Light | Dark | Notes |
|---|---|---|---|
| `series-1` | `#7c8f6f` (sage) | `#9caf8f` | Non-focal series |
| `series-2` | `#5e7a9b` (dusty-blue) | `#82a0c0` | Non-focal series |
| `series-3` | `#b8915a` (mustard) | `#d3ad7a` | Non-focal series |
| `series-4` | `#9c6b50` (rust-brown) | `#b88670` | Non-focal series |
| `series-5` | `#6e6479` (slate) | `#8d8298` | Non-focal series |

Fills sit at `0.18` opacity light, `0.22` dark; strokes use the full color. **Don't backfill these tokens to non-chart types** — architecture, swimlane, etc. continue to use muted-ink variants. The series palette is opt-in for diagrams where overlapping shapes demand distinguishable color, not a license to add color elsewhere.

### Terminal skin (opt-in alternate)

A self-contained palette for the terminal-window primitive (see [primitive-terminal.md](primitive-terminal.md)) — a CLI-chrome register for dev-tool posts and technical social cards. It does not replace the default skin above and isn't affected by onboarding; it's a second, fixed skin you opt into per-diagram.

| Token | Hex | Purpose |
|---|---|---|
| `terminal-page` | `#0a0a0a` | Page background behind the window |
| `terminal-paper` | `#141414` | Window body, node fill |
| `terminal-bar` | `#1b1b1b` | Titlebar strip |
| `terminal-border` | `#2b2b2b` | Window border, hairlines |
| `terminal-ink` | `#f5f5f5` | Primary text, primary stroke (same white-smoke as default `ink`) |
| `terminal-muted` | `#9a9a9a` | Secondary text, sublabels, ring stroke |
| `terminal-soft` | `#5c5c5c` | Tertiary — inactive dots, spokes |
| `terminal-accent` | `#ff5a36` | The one accent — focal station, prompt sign, active dot |
| `terminal-accent-tint` | `rgba(255,90,54,0.12)` | Fill for accent-bordered boxes |

**1-accent rule still holds.** Everything that isn't `terminal-ink` or `terminal-muted`/`terminal-soft` should be `terminal-accent` — never introduce a second hue.

---

## Typography

| Role | Family | Size | Weight | Usage |
|---|---|---|---|---|
| `title` | Georgia | 1.75rem | 400 | Page H1 |
| `node-name` | Segoe UI (sans) | 12px | 600 | Human-readable labels |
| `sublabel` | Consolas | 9px | 400 | Port, protocol, URL, field type |
| `eyebrow` | Consolas | 7–8px | 500, tracked 0.18em, uppercase | Type tags, axis labels |
| `arrow-label` | Consolas | 8px | 400, tracked 0.06em | Arrow annotations |
| `callout` | Georgia *italic* | 14px | 400 | Editorial asides only |

### Font stack

```css
font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
/* display: Georgia, "SimSun", serif; technical labels: Consolas, monospace */
```

### Font source

Font source: `system`

Use installed fonts and include Windows CJK fallbacks: `"Segoe UI", "Microsoft YaHei", sans-serif` for body/node text, `Georgia, "SimSun", serif` for display text, and `Consolas, "Microsoft YaHei", monospace` for labels. Do not add font links, CSS imports, or remote `@font-face` URLs. Recheck wrapping and labels after font substitution; the size tables below still apply.

SVG export uses system fonts by default. Run `python scripts/self_check.py --offline <file>` to verify the single-file output.

### Korean labels

Segoe UI and Georgia carry no Hangul. A Korean `<text>` element extends its own family — never swap the skin:

```svg
<text font-family="'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif">결제 서비스</text>
```

Use the installed script-specific Windows fallback shown above. No webfont is loaded; check line breaks after substitution. For page titles use the corresponding installed serif fallback.

**Width budget.** Measure per character, not per script: **every Unicode wide or full-width character costs 1em, every other character costs its face's Latin advance** (0.60em sans, 0.62em mono), and nonspacing/enclosing marks cost nothing. Sum over the string and multiply by the font size for the text width, then add padding and round the box up to the next multiple of 4.

Counting by script is the trap. `주문 v2.1` is two full-width syllables and five narrow characters; a formula that tallies Hangul, Latin letters, and spaces silently drops `2`, `.`, and `1` and sizes the box for four of its seven characters. Every rendered character costs something — measure per character, never per script.

Three rules follow from Hangul metrics:

- **Sublabels stay Latin.** Ports, protocols, field types, and URLs are Latin anyway — keep `Consolas` there and don't translate them. Hangul in a 9px mono sublabel is unreadable and has no mono face to fall back to.
- **Floor of 12px.** Hangul goes muddy below 12px. If a Korean name doesn't fit at 12px, cut the name — don't shrink the type.
- **Arrow labels, eyebrows, and legend text switch register.** Those slots are 7–8px Consolas, uppercase and tracked, which Hangul has neither a face nor legibility for. A Korean label in one of those slots becomes 12px sans at weight 500 with no tracking and no uppercase transform, and its mask rect grows to match (16px tall, width from the budget above, still rounded to a multiple of 4). Latin labels in the same diagram keep the mono treatment.

**Load-bearing rule:** Mono is for *technical* content (ports, commands, URLs, field types). Names go in Segoe UI sans. Page title is Georgia. Italic Georgia is reserved for annotation callouts (see [primitive-annotation.md](primitive-annotation.md)). **Never JetBrains Mono** as a blanket "dev" font.

### Traditional Chinese labels

Segoe UI and Georgia carry no Han. A Traditional Chinese `<text>` element extends its own family — never swap the skin:

```svg
<text font-family="'Segoe UI', 'Microsoft JhengHei', 'PingFang TC', 'Microsoft JhengHei', sans-serif">請求項比對</text>
```

Use the installed script-specific Windows fallback shown above. No webfont is loaded; check line breaks after substitution. For page titles use the corresponding installed serif fallback.

**Width budget.** The per-character contract above is unchanged: every Unicode wide or full-width character costs 1em, every other character costs its face's Latin advance, and nonspacing marks cost nothing. Full-width punctuation — `（）「」，。：` — is wide and costs 1em as well, which is the part most often dropped.

Counting by script is the trap. `請求項 v2.1` is three full-width characters and five narrow ones; a formula that tallies Han and Latin letters silently drops `2`, `.`, and `1` and sizes the box for six of its nine characters.

Three rules follow from Han metrics, mirroring the Hangul ones:

- **Sublabels stay Latin.** Ports, protocols, field types, and URLs are Latin anyway — keep `Consolas` there and don't translate them. Han in a 9px mono sublabel is unreadable and has no mono face to fall back to. A sublabel that is prose rather than a value may be Chinese, but it then switches register by the third rule below.
- **Floor of 12px.** Han packs more strokes than Hangul into the same em box, so the 12px floor binds at least as hard here. If a Chinese name doesn't fit at 12px, cut the name — don't shrink the type.
- **Arrow labels, eyebrows, and legend text switch register.** Those slots are 7–8px Consolas, uppercase and tracked, which Han has neither a face nor legibility for. A Chinese label in one of those slots becomes 12px sans at weight 500 with no tracking and no uppercase transform, and its mask rect grows to match (16px tall, width from the budget above, still rounded to a multiple of 4). Latin labels in the same diagram keep the mono treatment.

Simplified Chinese takes the same three rules with `"Segoe UI", "Microsoft YaHei", sans-serif` for labels and `Georgia, "SimSun", serif` for titles.

### Cyrillic labels

Use installed Segoe UI or Georgia with an appropriate local fallback. Check the rendered text and width budget for the actual characters rather than assuming a downloaded face.

## Stroke, radius, spacing

| Token | Value | Use |
|---|---|---|
| `stroke-thin` | `0.8` | Tag-box outlines, leaf nodes |
| `stroke-default` | `1` | Most strokes |
| `stroke-strong` | `1.2` | Emphasis strokes |
| `radius-sm` | `4` | Small tags |
| `radius-md` | `6` | Node boxes |
| `radius-lg` | `8` | Containers, rings |
| `grid` | `4` | Every coord, size, and gap is divisible by 4 (hard rule) |

---

## Node type → treatment

Semantic role combinations — reference these by name in type specs.

| Type | Fill | Stroke |
|---|---|---|
| `focal` (1–2 max) | `accent-tint` | `accent` |
| `backend` | `#ffffff` (white) | `ink` |
| `store` | `ink @ 0.05` | `muted` |
| `external` | `ink @ 0.03` | `ink @ 0.30` |
| `input` | `muted @ 0.10` | `soft` |
| `optional` | `ink @ 0.02` | `ink @ 0.20` dashed `4,3` |
| `security` | `accent @ 0.05` | `accent @ 0.50` dashed `4,4` |

---

## Customizing the skin

Four options:

1. **Run onboarding** — see [`onboarding.md`](onboarding.md). Extract tokens from supplied local materials or an internal URL and apply them to the task output.
2. **Edit the output tokens** — change the selected values in the generated document, then run the pre-output taste gate.
3. **Brand handoff** — map supplied design-token JSON to the semantic roles above in the task output.
4. **Project profiles** — save or select a profile only when requested, using [`profiles.md`](profiles.md).

### Constraints (don't break these)

- **Contrast**: every text token (`ink`, `muted`, `soft`, `link`, and `accent`) must clear 4.5:1 on `paper`, in both skins. Two accents erases the focal signal.
- **No rainbow palette**: if your brand ships 8 colors, pick 3 (paper, ink, accent). The rest become `muted` variants.
- **Serif + sans + mono**: three families, not more. If brand typography is all sans, keep Georgia for `title` and `callout` anyway — the contrast is load-bearing.
- **Paper is warm-neutral, not pure white**: pure white turns the design sterile. Pick a cream, bone, or light grey with a hint of warmth.
- **Dot pattern is optional, not default**: the 22×22 dot pattern is an opt-in "dotted paper" variant (good for long-form editorial hero diagrams). The default background is a clean `paper` fill, no pattern. When the pattern is enabled, it should sit at ~10% opacity of `ink` on `paper` — visible but quiet.
- **Container is clean by default**: the diagram sits directly on the page paper, no secondary container background or border. A framed variant (`paper-2` bg + `rule` border + 8px radius + padding) is available as an opt-in for card-heavy layouts, but don't reach for it by default — the extra chrome fights the figure.
