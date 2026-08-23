## Description: <br>
Data analysis and visualization. Query databases, generate reports, automate spreadsheets, and turn raw data into clear, actionable insights. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[ivangdavila](https://clawhub.ai/user/ivangdavila) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
Employees, external users, developers, analysts, and operators use this skill to analyze, explain, and visualize SQL, spreadsheet, notebook, dashboard, export, or ad hoc table data. It is intended for KPI debugging, experiment readouts, funnel and cohort analysis, anomaly reviews, executive reporting, and decision-ready metric quality checks. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The agent may receive sensitive databases, spreadsheets, exports, or business data while applying the analysis workflow. <br>
Mitigation: Grant access only to data needed for the specific task and avoid sharing credentials or unrelated raw exports. <br>
Risk: Weak samples, ambiguous metric definitions, source drift, or unresolved confounding can produce misleading conclusions. <br>
Mitigation: Lock the metric contract before calculation, quantify uncertainty, state caveats, and downgrade or block conclusions when the data cannot support the claim. <br>
Risk: Stakeholders may over-trust polished charts or reports that omit baselines, denominators, or robustness checks. <br>
Mitigation: Use decision briefs that separate evidence from recommendations, show counts with percentages, compare against the right baseline, and include confidence and next actions. <br>


## Reference(s): <br>
- [ClawHub Skill Page](https://clawhub.ai/ivangdavila/data-analysis) <br>
- [Publisher Profile](https://clawhub.ai/user/ivangdavila) <br>
- [Skill Homepage](https://clawic.com/skills/data-analysis) <br>
- [Metric Contracts](metric-contracts.md) <br>
- [Chart Selection](chart-selection.md) <br>
- [Decision Briefs](decision-briefs.md) <br>
- [Analytical Pitfalls](pitfalls.md) <br>
- [Analysis Techniques](techniques.md) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, code, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown or text with optional SQL, Python, spreadsheet formulas, shell commands, and configuration snippets] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May include decision briefs, chart recommendations, metric contracts, caveats, uncertainty ranges, and recommended next actions] <br>

## Skill Version(s): <br>
1.0.2 (source: frontmatter and server release evidence) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
