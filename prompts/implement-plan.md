---
agent: plan-manager-agent
---
Use the implement-plan skill in worktree {{worktree_path}} for Linear issue {{issue_id}}.

Locate the plan the previous phase wrote under `.twinpod/{{issue_id}}-*/` and implement every phase of it consecutively, back to back, without pausing between phases. Treat each phase's automated verification as the completion gate; note any manual-verification steps from the plan for the eventual PR reviewer, but do not block on them. Keep iterating until the full suite is green. If you hit a true andon condition (ambiguity, broken plan, broken infrastructure), stop and explain it.
