# Input, rubric, and result contract

`batch_evaluate.py` uses Python 3.10+ and the standard library. It never calls an
endpoint, reads credentials, or supplies model answers.

## Input

Inputs are UTF-8 CSV (a BOM is accepted) or a JSON array of objects. Select only
the evidence fields needed for the task with repeated `--field` arguments:

```sh
python <skill-dir>/scripts/batch_evaluate.py prepare --input feedback.csv --field title --field text --id-column id --rubric rubric.json --output-dir evaluation-plan --batch-size 8 --model jev-1.13.0
```

`--id-column` is optional. Without it, IDs are `row-000001`, `row-000002`, etc.
With it, every record must have a unique, nonempty string or integer ID. JSON
numeric IDs remain numeric in `results.json`. Source order is preserved.
The source IDs stay in the local plan; requests use generated record keys and
only the selected fields. A selected ID field is still sent like any other field.
Integers in selected evidence or rubric data must be within JavaScript's safe
integer range (−9,007,199,254,740,991 through 9,007,199,254,740,991). Represent
larger exact values as strings to avoid rounding in the native tool. Local-only
record IDs retain their original integer values.
The generated manifest also has a 16 MiB bound; very long local IDs can exceed
it even when the input fits. Preparation rejects such a plan before writing it.

The helper accepts up to 10,000 records and a 16 MiB input file. Batch size is
1–32, default 8. At most eight questions may be defined. Requests are bounded to
256 KiB by default (`--max-request-bytes`, maximum 4 MiB). It splits between
records when needed and never truncates a cell, rubric, or probability list.
The endpoint may have a lower token limit; report that failure instead of
silently changing the evidence. Omit `--model` to use the plugin's tool default.
Pinning a model labels the requested version; the vendor-reported model is also
retained in the output.

## Rubric

Supply `questions` using the native tool's `choice`, `score`, and `noul` question
shapes. Use short machine IDs for the question names (letters, digits, underscore).
Choice labels and descriptions can be in the user's language. Score criteria
are an ordered array of 2–10 levels. Choice has 2–255 alternatives. For Noul,
`criteria.true` and `criteria.false` describe the predicate outcomes.

An optional `review` map defines task-specific review rules. These example
thresholds illustrate syntax; they are not recommended accuracy cutoffs:

```json
{
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "Choose the matching category.",
      "criteria": { "Relevant": "Matches the stated topic", "Other": "Does not match" }
    },
    "quality": { "type": "score", "criteria": ["Incomplete", "Complete"] },
    "actionable": {
      "type": "noul",
      "criteria": { "true": "Requests an action", "false": "Informational only" }
    }
  },
  "review": {
    "category": { "min_probability": 0.8 },
    "quality": { "min_score": 0.5 },
    "actionable": { "uncertain_interval": [0.4, 0.6] }
  }
}
```

Choice review uses the probability of the **returned label**, without replacing
that label with an argmax. Reported ties or a label below another label's
probability are separately flagged. Score review uses the returned fractional
rubric position. Boolean review flags values inside the inclusive interval.
No rule uses the provider's `confidence` field as correctness probability.

## Plan and outcomes

The manifest records the rubric, source-row mapping, request checksums, and
generated filenames. Question IDs incorporate a digest of the selected evidence
and rubric, so replies from a different prepared dataset or rubric cannot be
silently merged. Request checksums catch edits after preparation. These checks
bind task artifacts together; they do not authenticate the remote service.

For each batch, save exactly one outcome:

- `batch-0001.response.json`: the exact native tool details, `{"evaluation": {...}}`.
- `batch-0001.error.json`: `{"reason":"authentication"}`, with no raw response,
  credential, or reflected error payload.

Supported failure codes: `authentication`, `credentials-unavailable`,
`rate-limited`, `transport`, `timeout`, `cancelled`, `unsupported-input`,
`invalid-response`, `tool-unavailable`, and `tool-error`.
An outcome absent from disk is `missing`, not a successful empty answer. Two
outcomes for the same batch are invalid. Invalid or incomplete replies reject
that entire batch; answers from valid batches remain usable.

## Output

- `results.json`: one record per source item, retaining its ID, source index,
  status, vendor model, original typed answers, review status, and reason codes.
- `results.csv`: a long table with one row per item and question; distributions
  are JSON cells. Text cells with spreadsheet formula prefixes are escaped with
  an apostrophe. The JSON artifact preserves original strings exactly.
- `summary.json`: completion/coverage counts, review counts, models, and rubric
  digest. Native token usage is counted once per valid batch, not per item.

`passed_rules` means only that supplied workflow review rules did not flag the
record. `not_assessed` means there was no applicable rule. Neither asserts that
the classification is correct or authorizes an action.

The CLI prints a machine-readable summary. `prepare` and complete `merge` exit
0; incomplete `merge` exits 2 after writing artifacts; invalid input or plan
exits 1 without publishing result artifacts. Choose a new output directory when
merging again after additional batches complete.
