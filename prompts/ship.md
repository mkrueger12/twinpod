---
agent: ship-pr-agent
---
Read {{reads}} for Linear issue {{issue_id}} in worktree {{worktree_path}}.

Confirm the full suite is green, then run the `ce-code-review` skill against the branch diff. Fix every P0/P1 finding, re-running the full suite after each round of fixes until it's green again. If a P0/P1 finding can't be resolved autonomously, stop and report it as a blocker instead of shipping.

Once the suite is green and the review is clean, commit the finished work, push branch, and open a pull request. The PR must include what changed, why, test evidence, risk notes, and a brief note on the code review pass (reviewers run, findings fixed). If CI is not green or a PR cannot be opened, stop and report the blocker instead of shipping.
