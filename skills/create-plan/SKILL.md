---
name: create-plan
description: convert research findings into a detailed implementation plan
---

# Create Plan

You are in the final Plan Writing phase. Convert the research document into a complete, detailed implementation plan.

This skill is the third phase of the research → plan → implement flow: **create-research-questions → create-research → create-plan → implement-plan**. Its input is the research document written by `create-research`; its output (the implementation plan) is read by `implement-plan`.

## Steps

1. **Read all input files FULLY**:
   - Use Read tool WITHOUT limit/offset to read all provided file paths
   - `ls -La .twinpod/TASKNAME` to find all related documents in the task directory.
   - Read everything in the task directory to build full context, excluding research questions documents
   - **DO NOT read research questions documents** - research questions are inputs to the research phase only. Use the completed research document instead.

2. **Read relevant code files**:
   - Read any source files mentioned in the research document
   - Build context for writing specific code examples

3. **Read the plan template**:

`Read({SKILLBASE}/references/plan_template.md)`

4. **Write the implementation plan**:
   - First, ensure the artifact directory exists: `mkdir -p .twinpod` (create it at the repo root if it isn't there yet)
   - Write to `.twinpod/ENG-XXXX-description/NN-plan-DESCRIPTION.md`
   - **Chronological indexing**: `ls` the task directory, find the highest existing NN- prefix, and use the next number (e.g. `06-plan-add-billing.md`)
   - Convert the research findings into detailed implementation steps, organized into phases
   - Include specific code examples for each change
   - Add both automated and manual success criteria

## Plan Writing Guidelines

- Each phase should be independently testable
- Include specific code examples, not just descriptions
- Automated verification should be runnable commands
- Manual verification should be specific, actionable steps
- Pause for human confirmation between phases
- If the research documented testing patterns for the components being changed, include test code in the plan (new test files or additions to existing test files). Follow the existing test patterns found in the research.

## Document Precedence

When documents conflict, the most recent document wins: **plan > research > ticket**.

The plan is the final authority. Follow the plan's decisions over the original ticket when they differ.

## Output

1. **Read the final output template**:

`Read({SKILLBASE}/references/plan_final_answer.md)`

2. Respond following the template exactly. Do not include a summary or other information.

<guidance>
## Markdown Formatting

When writing markdown files that contain code blocks showing other markdown (like README examples or SKILL.md templates), use 4 backticks (````) for the outer fence so inner 3-backtick code blocks don't prematurely close it:

````markdown
# Example README
## Installation
```bash
npm install example
```
````

## Validation Design

Not every phase requires manual validation, don't put steps for manual validation just to have them. 
</guidance>
