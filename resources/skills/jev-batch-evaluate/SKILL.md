---
name: jev-batch-evaluate
description: 'Classify or score batches of records with Jev using explicit labels and rubrics, then export traceable results and review flags. Use for semantic classification or rubric evaluation of CSV/JSON records when the user requests Jev or an external decision model. Ordinary statistics and spreadsheet calculations belong to data-analysis.'
metadata:
  {
    'openclaw':
      {
        'requires':
          { 'anyBins': ['python', 'python3'], 'config': ['plugins.entries.typesafe.enabled'] },
        'os': ['linux', 'darwin', 'win32'],
      },
  }
---

# Batch classification and scoring

Turn user-supplied records into a reproducible evaluation with the native
`typesafe_evaluate` tool. Keep the chat model responsible for interpreting the
task and explaining results. The bundled Python helper only prepares requests
and assembles artifacts; it performs no inference or network access.

## Prepare the task

- Identify the source records, the fields needed as evidence, and the user's
  classification labels or ordered scoring rubric. Preserve supplied standards.
  If none are supplied, propose a concise rubric and make the assumption explicit;
  ask only when the ambiguity would materially change the requested result.
- Use this workflow only when the user has requested Jev/external evaluation.
  Enabling a plugin alone is not a reason to send unrelated task data. Send the
  selected evidence fields, not the full conversation or unrelated columns.
- Use user-supplied record IDs when present. Otherwise the helper generates
  stable source-row IDs. It rejects duplicate or empty explicit IDs.
- Keep any supplied review thresholds. Do not invent an accuracy threshold or
  interpret the provider's `confidence` metric as correctness probability.

Read [the rubric and artifact contract](references/workflow.md) when preparing
the first request. A runnable [feedback rubric](references/feedback-rubric.json)
and [sample records](references/feedback.csv) illustrate classification and
urgency scoring; adapt them to the user's task rather than applying them blindly.

Run the helper using the path of this skill and an available Python 3.10+
interpreter (`python` or `python3`), and keep task files in the user's working
directory. Replace `python` below with `python3` when that is the available
Python 3 command. Choose a new output directory for each prepared run:

```sh
python <skill-dir>/scripts/batch_evaluate.py prepare --input feedback.csv --field text --id-column id --rubric rubric.json --output-dir evaluation-plan
```

The plan lists the request and response filenames. Each request batches
independent questions against a bounded set of records. Instructions explicitly
identify the record for each question; question IDs alone have no semantic
meaning to Jev. Oversized requests are split between records without truncating
evidence. An individual record that cannot fit is rejected.

## Evaluate

Call `typesafe_evaluate` with each generated request JSON unchanged. Preserve
question IDs and all criteria. Save the tool's exact `details` object
(`{"evaluation": ...}`) to that batch's response filename. Do not reconstruct
answers from a prose summary. Existing response files represent completed calls;
resume missing batches instead of calling completed batches again.

If the tool is unavailable, identify the missing TypeSafe setup and stop the
evaluation. Do not substitute chat-model guesses, shell HTTP calls, or credentials
in chat. On a tool failure, write `{"reason":"authentication"}` (or another
documented failure code) to the batch's error filename. Stop further calls for
credential, rate-limit, or service failures and report the remaining work. A
cancelled task must not start retries or new batches. Corrected, explicitly
retried batches must have only one outcome file; archive the old outcome first.

## Assemble and deliver

```sh
python <skill-dir>/scripts/batch_evaluate.py merge --plan-dir evaluation-plan --output-dir evaluation-results
```

The helper checks request integrity and exact answer correspondence before
producing `results.json`, `results.csv`, and `summary.json`. Exit code 2 means
the artifacts are incomplete: missing, failed, or invalid batches remain clearly
marked. Never describe that run as fully evaluated. The helper refuses to
overwrite an existing output directory.

Summarize coverage, category counts or score distribution, records flagged for
review, and any failures. Link the artifacts and explain that scores are
zero-based rubric positions. Preserve the returned label and distributions even
when the reported label differs from the highest probability. Identify review
flags as workflow rules, not proven model error rates. With no review rule,
otherwise unflagged records are `not_assessed`, not automatically approved.

Keep the dataset, rubric, plan, and results as ordinary task artifacts. Do not
write them to application transcript storage, automatically assign assistants,
send messages, or change source records as a consequence of a classification.
