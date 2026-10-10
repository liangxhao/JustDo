---
name: scenario-explorer
description: Show an interactive team investment and delivery comparison through the native scenario-explorer widget when the user wants to explore team size, focus hours, budget or delivery time.
---

# Scenario explorer

Use the registered `scenario-explorer` kind only when the actual `show_widget`
tool schema advertises it. Prefer a short explanation alongside the widget.
The widget is a fixed illustrative calculator; distinguish supplied facts from
assumptions and do not present it as a validated project forecast.

Call the native tool with `kind: "scenario-explorer"` and `widget_code` containing
a JSON **string** with this shape:

```json
{
  "version": 1,
  "language": "zh",
  "summary": "Explore team investment and delivery time",
  "tasks": [{ "label": "Implementation and verification", "hours": 448 }],
  "dailyRate": 700,
  "budget": 80000,
  "deadline": 21,
  "people": 6,
  "focus": 6
}
```

Choose `zh` or `en` for the user's language. Use 1–12 task entries; summary
and task labels are plain text, at most 400 and 80 characters. All numeric
values are integers: task hours 1–2000, daily rate 100–5000 CNY per person per
workday, budget 5000–1000000 CNY, deadline 1–365 workdays, people 2–12 and focus
2–8 hours per workday. No additional fields, URLs, scripts or expressions.
The entire JSON source is limited to 32 KiB UTF-8.

The calculator sums task hours and divides by
`people * focus * 0.82 * (1 - 0.025 * (people - 1))`, rounded up to workdays.
Cost is workdays × people × daily rate. It omits holidays, dependencies and
parallelism constraints. Avoid repeating unverified numbers in prose; the
widget calculates its own values.

Use the descriptor returned by the actual tool. Do not invent Canvas IDs,
`[embed]` URLs, Gateway paths or manifests, and do not write Gateway state
files. The host controls display and follow-up drafts; no button is proof that
an agent task ran.

If the native tool or kind is unavailable, explain the limitation briefly.
For a requested interactive deliverable, create a normal HTML artifact under
the project's `.agent-tasks/interactive-ui/` and return its file link for the
existing preview. For a simple comparison, a text table is enough.
