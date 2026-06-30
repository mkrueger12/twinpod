---
name: implement-plan
description: phased implementation of a structured plan you must use this skill when asked to implement a plan file in .twinpod/*
---

# Phased Implementation Orchestrator

You are responsible for orchestrating the phased implementation of technical plans from `.twinpod/`. You will work through each phase systematically using a specialized implementer agent.

This skill is the final phase of the research → plan → implement flow: **create-research-questions → create-research → create-plan → implement-plan**. Its input is the implementation plan written by `create-plan`.

## Workflow

For each phase in the implementation plan:

### 0. Locate Plan File
If you were provided with a path to a plan file, proceed with the plan.
If you were provided with a task artifact directory like `.twinpod/<task slug>` you should list the contents with `ls -La` to locate the plan file inside of it, e.g. `ls -La .twinpod/<task slug>`.

### 1. Launch Implementer Agent
Use the Task tool with `subagent_type=implementer-agent` to implement the current phase. Provide clear instructions about which phase to implement.

Example:
```
Implement Phase [N] of the plan at .twinpod/ENG-XXXX-description/NN-plan-DESCRIPTION.md
Focus only on Phase [N] and stop after completing automated verification.
```

IMPORTANT - keep your prompt short, do not duplicate details that are already in the plan, because the implementer agent will read the plan.

### 2. Review Output
Carefully review the implementer agent's output:
- Check what was accomplished
- Note any issues or mismatches reported
- Identify manual verification steps requested

### 3. Perform Automated Checks
Run any automated verification that the implementer agent may have missed or that you can perform:
- Build commands
- Test suites
- Linting/formatting checks
- Any other automated verification mentioned in the plan

### 4. Report Progress
Record a clear summary of the phase completion:
```
## Phase [N] Implementation Summary

**Completed by implementer agent:**
- [List of completed tasks]

**Automated verification results:**
- [Results of automated checks you performed]

**Manual verification noted for PR review (not blocking):**
- [List manual checks a human reviewer should perform]
```

### 5. Proceed Automatically
You run unattended — no human is present mid-run. Automated verification (step 3) is the only gate. If it passes, move straight to the next phase. If it fails and isn't fixable, treat it as an andon condition (see below) and stop.

### 6. Commit the changes
- Create a new commit for the changes
- remember - the `.twinpod/` directory is gitignored and should not be committed; it holds working artifacts only

### 7. Repeat for Next Phase
Repeat this workflow for the next phase immediately, without waiting to be prompted.

## Special Instructions

### Resuming Work
If resuming work on a partially completed plan:
- First check the plan file for existing checkmarks (- [x])
- Instruct the implementer agent to resume from the first unchecked item
- Trust that completed work is done unless something seems off

### Handling Issues
If the implementer agent reports a mismatch or gets stuck, that's an andon condition: stop, explain clearly why the plan can't be followed as written, and end the run rather than guessing or shipping broken work. There is no human to ask mid-run.

### Multiple Phases
Twinpod always runs implement-plan unattended across the full plan:
- Launch a separate implementer agent for each phase
- Perform verification between phases
- Do not pause between phases — proceed straight from one phase to the next
- Report a summary after all phases complete

Workflow checklist:

- [ ] get plan path
- [ ] launch implementer subagent
- [ ] review its work
- [ ] perform automated checks
- [ ] commit the changes
- [ ] launch implementer subagent for next phase

## After Final Phase Completion

When ALL phases are complete and verified (all checkboxes marked, all automated tests pass):

1. Commit the final changes
2. Read the final output template:

`Read({SKILLBASE}/references/implement_plan_final_answer.md)`

3. Respond following the template exactly. Do not include a summary or other information.

## Getting Started

When invoked:
1. Locate the plan path if not provided directly (see step 0 above)
2. Read the plan to understand the phases
3. Begin with Phase 1 (or first unchecked phase if resuming)
4. Follow the workflow above

Remember: Your role is orchestration and verification. The implementer agent does the actual implementation work. Your job is to ensure quality and perform additional checks — this run is unattended, so don't wait on a human at any point; an andon condition is the only thing that should stop you short of completion.
