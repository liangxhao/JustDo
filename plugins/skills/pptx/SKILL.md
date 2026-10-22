---
name: pptx
license: MIT-0
description: 'Create, inspect, and edit local Microsoft PowerPoint `.pptx` decks while preserving templates, layouts, placeholders, notes, charts, media, and visual consistency. Use when presentation structure or rendered quality matters.'
metadata:
  { 'openclaw': { 'emoji': '📊', 'requires': { 'bins': [] }, 'os': ['win32'] } }
---

## Runtime Boundary

This is an offline Windows skill. Do not access ClawHub, public package registries, image-search services, cloud presentation services, or external URLs. Do not run `pip install`, `npm install`, or download missing fonts, images, libraries, or converters. Use only presentation libraries and local applications already available in the runtime.

This skill is guidance only and does not bundle `python-pptx`, `pptxgenjs`, MarkItDown, LibreOffice, or Poppler. Never claim that a deck was generated, rendered, or visually verified unless an available local tool actually completed that operation.

## When to Use

Use when the main artifact is a `.pptx` deck and layouts, templates, placeholders, speaker notes, comments, charts, media, or final visual quality matter.

## Core Rules

### Choose the workflow before editing

- Reading, editing, rebuilding from a template, and creating from scratch have different failure modes.
- Inventory the deck before changing it: slides, layouts, masters, placeholders, notes, comments, charts, media, theme fonts, colors, and aspect ratio.
- Prefer an approved company template when one is provided.
- For template-driven work, reuse suitable layouts or duplicate a compatible slide instead of rebuilding the visual language.

### Preserve layout and content semantics

- Placeholder and layout indexes are template-specific; inspect the actual deck before targeting them.
- Match the amount of content to the selected layout. Do not leave unused template placeholders or force dense content into an unsuitable design.
- Keep one primary message per slide and use concise supporting text.
- Preserve notes, comments, chart labels, linked assets, slide order, masters, and theme behavior unless the task explicitly changes them.
- Use fonts already approved and installed on target Windows PCs. Do not fetch external fonts or images.

### Edit conservatively

- Work on a new output path unless the user explicitly asks to overwrite the source.
- Preserve existing aspect ratio, theme, alignment, spacing, and visual hierarchy.
- Avoid replacing an entire text frame when a smaller edit can preserve runs and formatting.
- Treat embedded objects, linked media, macros, and unknown extension parts as higher risk; do not execute embedded code.
- Combining decks can introduce conflicting masters and themes; normalize only when requested and verify the result.

### Run separate QA passes

- Content QA: confirm slide order, titles, body text, notes, comments, labels, tables, chart data, and absence of placeholder text.
- Visual QA: inspect overflow, clipping, overlap, alignment, contrast, font substitution, image cropping, and slide-edge margins.
- Re-check every changed slide after a fix.
- Report whether QA was structural, visual, or both, and identify anything the local runtime could not verify.

## Common Traps

- Master or layout settings can override local slide edits.
- Text extraction can succeed while the rendered slide is visibly broken.
- Font substitution changes line wrapping and element positions.
- Notes, comments, linked media, and chart semantics can remain broken while the slide surface looks correct.
- Mixing 16:9 and 4:3 source decks shifts layout and placement decisions.
