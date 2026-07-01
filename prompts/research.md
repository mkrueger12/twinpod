---
agent: create-research-agent
---
Use the create-research skill for Linear issue {{issue_id}}.

Locate the research-questions document the previous phase wrote under `.twinpod/{{issue_id}}-*/` and use it as your research query. Spawn the codebase-locator, codebase-analyzer, codebase-pattern-finder, and web-search-researcher subagents as needed, but keep no more than 2 subagents running in parallel at any time; queue additional research tasks until one finishes. Then write the research document per the skill's conventions. This is an unattended run — there is no human to consult, so make your own judgment calls instead of pausing.
