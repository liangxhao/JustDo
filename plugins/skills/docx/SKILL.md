---
name: docx
license: MIT-0
description: 'Create, inspect, and edit local Microsoft Word `.docx` documents while preserving styles, numbering, sections, tables, fields, comments, and tracked changes. Use when Word document structure or round-trip compatibility matters.'
metadata:
  { 'openclaw': { 'emoji': '📘', 'requires': { 'bins': [] }, 'os': ['win32'] } }
---

## Runtime Boundary

This is an offline Windows skill. Do not access ClawHub, public package registries, cloud document services, or external URLs. Do not run `pip install`, `npm install`, or download missing converters. Use only document libraries and local applications already available in the runtime. If no safe writer or renderer is available for the requested operation, explain the limitation instead of constructing an unreliable file.

This skill is guidance only and does not bundle a DOCX generation library, Pandoc, LibreOffice, or Poppler. Never claim that a document was rendered or visually verified unless an available local tool actually opened or rendered it.

## When to Use

Use when the main artifact is a `.docx` document and styles, numbering, sections, headers, footers, tables, fields, comments, tracked changes, or layout preservation matter.

## Core Rules

### Treat DOCX as a structured package

- A DOCX file is a ZIP package of related OOXML parts, not plain text.
- Important content can live in `word/document.xml`, styles, numbering, headers, footers, comments, footnotes, relationships, and media parts.
- Visible phrases may be split across several runs, bookmarks, fields, or revision wrappers. Do not assume a sentence is one XML text node.
- Treat `.docm` as macro-bearing and never execute its macros. Legacy `.doc` requires an approved local converter before DOCX-specific processing.

### Preserve document structure

- Work on a new output path unless the user explicitly requests replacement.
- Prefer named styles and extend the document's existing style system.
- Preserve section properties, page size, margins, orientation, headers, footers, numbering definitions, relationships, bookmarks, fields, and table geometry unless the task changes them.
- Use real numbering definitions for lists, not pasted bullet characters.
- Make the smallest possible structural edit to existing documents; replacing a whole paragraph can destroy formatting, bookmarks, comments, or tracked-change context.

### Handle review data carefully

- Tracked changes and comments may contain deleted or non-visible sensitive text.
- Do not accept or reject revisions, delete comments, refresh fields, or remove metadata unless the user requests it.
- Keep comment anchors, revision IDs, authors, timestamps, and relationship IDs internally consistent.
- For legal or review-heavy documents, prefer narrow span-level edits over wholesale rewrites.

### Verify before delivery

- Reopen or reparse the output and confirm that the package, relationships, expected paragraphs, tables, styles, and media remain present.
- When a local Word renderer is available, inspect pagination, headers, footers, tables, wrapping, and page breaks.
- Report whether verification was structural, visual, or both.
- Call out stale fields, unrefreshed tables of contents, unresolved tracked changes, linked media, or compatibility risks.

## Common Traps

- Copying content between documents can import conflicting styles and numbering definitions.
- Header and footer images use part-specific relationships.
- Empty paragraphs used for spacing make templates fragile.
- Deleting visible text can leave an empty numbered paragraph behind.
- A document that passes text extraction can still fail on pagination, tables, fields, or review metadata.
