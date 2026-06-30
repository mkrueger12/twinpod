---
agent: ship-agent
---
Read {{reads}} for Linear issue {{issue_id}} in worktree {{worktree_path}}.

Confirm the full suite is green, commit the finished work, push branch, and open a pull request. The PR must include what changed, why, test evidence, and risk notes. If CI is not green or a PR cannot be opened, stop and report the blocker instead of shipping.
