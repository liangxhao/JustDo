---
name: xlsx
license: MIT-0
description: 'Create, inspect, and edit local Excel workbooks and spreadsheet files while preserving formulas, dates, identifiers, formatting, and workbook structure. Use when the primary input or output is `.xlsx`, `.xlsm`, `.csv`, or `.tsv`.'
metadata:
  { 'openclaw': { 'emoji': '📗', 'requires': { 'bins': [] }, 'os': ['win32'] } }
---

## Runtime Boundary

This is an offline Windows skill. Do not access ClawHub, public package registries, cloud spreadsheet services, or external URLs. Do not run `pip install`, `npm install`, or download a missing dependency. Use only tools already available in the runtime; if a required capability is unavailable, explain the limitation instead of claiming success.

The bundled runtime provides Python and `openpyxl`. Do not assume `pandas`, `markitdown`, LibreOffice, Microsoft Excel automation, or legacy `.xls` support is available. `openpyxl` writes formulas but does not calculate them, so never claim that formula results were recalculated unless an available local calculation engine actually performed that step.

## When to Use

Use when the main artifact is a workbook or spreadsheet file and formulas, dates, formatting, merged cells, identifiers, or template preservation matter.

## Core Rules

### Choose the workflow by artifact

- Use `openpyxl` for `.xlsx` and `.xlsm` formulas, styles, sheets, comments, merged cells, validation, and workbook structure.
- Treat CSV and TSV as plain data exchange formats without workbook formatting or formulas.
- Do not treat legacy `.xls` as `.xlsx`; report that conversion requires an approved local converter.
- Open `.xlsm` with `keep_vba=True` when macros must be preserved. Never execute macros.

### Protect values and formulas

- Store long identifiers, employee numbers, phone numbers, postal codes, and leading-zero values as text when their digits are identifiers rather than quantities.
- Excel truncates numeric precision beyond 15 digits; do not allow silent conversion of identifiers to numbers.
- Write formulas when the workbook must remain live instead of hardcoding derived results.
- Test representative formulas before filling a large range. Check relative and absolute references, denominators, sheet names, and off-by-one ranges.
- Never save a workbook loaded with `data_only=True`; doing so can replace formulas with cached values.
- Cached formula values may be stale. State whether formulas were written, inspected, or genuinely recalculated.

### Preserve existing workbooks

- Work on a new output path unless the user explicitly asks to overwrite the source.
- Match the existing workbook's styles and conventions rather than imposing a generic design.
- Preserve sheet order, hidden sheets, named ranges, widths, freezes, filters, print settings, validations, merged ranges, and conditional formatting unless the task changes them.
- Only the top-left cell of a merged range stores a value.
- Preserve external links cautiously; warn when an edit may remove or invalidate them.

### Verify before delivery

- Reopen the output with `openpyxl` and verify expected sheets, dimensions, formulas, merges, styles, and representative values.
- Scan formula strings for broken references that can be detected statically, but do not present that scan as a calculation-engine result.
- Check for clipped headers, missing wrapping, unsuitable column widths, and damaged number formats.
- Report any unverified calculation, macro, external-link, or visual-layout behavior.

## Common Traps

- Date values depend on workbook epoch and number format.
- Newlines require wrapped text to display correctly.
- Formula copy operations can remain syntactically valid while referencing the wrong row or sheet.
- Saving macro-enabled workbooks without `keep_vba=True` can discard macros.
- Password protection in old spreadsheet formats is not strong security.
