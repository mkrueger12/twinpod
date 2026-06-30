---
date: [Current date and time with timezone in ISO format]
git_commit: [Current commit hash]
branch: [Current branch name]
repository: [Repository name]
topic: "[User's Question/Topic]"
type: research
tags: [research, codebase, relevant-component-names]
status: complete
---

# Research: [User's Question/Topic]

**Date**: [Current date and time with timezone from step 4]
**Git Commit**: [Current commit hash from step 4]
**Branch**: [Current branch name from step 4]
**Repository**: [Repository name]

## Research Question

[List of original research questions from the research-questions document or user query.
Present as a numbered list if multiple questions were provided.]

## Research Methodology (verbatim)

This document will remain objective and factual. It does not contain any recommendations or implementation suggestions.
Open questions will not ask Why things haven't been built or what should be built in the future.

There is no "implementation" section - that is intentional.

## Summary

[2-4 focused paragraphs synthesizing what was found. Cover key architectural patterns, data flows,
and relationships. Synthesize, don't compress every detail.]

## Detailed Findings

[Organize by concept/feature, not by file location. Number top-level sections. Write as a
technical explainer with citations woven in, not a file index. Use tables, mermaid diagrams,
code examples, and pseudocode where they aid understanding.]

### 1. [Concept/Feature Name]

[Prose explanation of what this is and how it works. Cite file locations inline using ranges
for adjacent lines — e.g. (`src/app.ts:57-80`). Use tables for comparisons, code blocks for
key type signatures, mermaid for architectural relationships.]

#### Testing patterns

[Test file locations, testing approach (unit/integration/e2e), mocking patterns, fixtures
and utilities. If no tests exist, say so explicitly.]

### 2. [Concept/Feature Name]
...

## Code References

[Very comprehensive list of key files and directories, grouped by area. Indicate when the list
is exhaustive for a given area vs. when it covers key files but others may exist.]

### [Group name]
- `path/to/file.ts:28-36` — Description of what's there
- `path/to/directory/` — Description of directory contents (key files listed, others exist)

## Architecture Documentation

[Narrative paragraphs describing architectural patterns, conventions, and design decisions.
How components compose, how data flows, what conventions are followed.]

## Open Questions

[Genuine investigative questions about things not fully traced or understood. Focus on
"How does X reach Y?" not "Should Z be refactored?" If truly none, say "None."]
