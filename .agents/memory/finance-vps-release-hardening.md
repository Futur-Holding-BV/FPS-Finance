---
name: Finance VPS release hardening
description: Non-obvious shell and systemd rules that keep Finance VPS releases fail-closed without deleting or corrupting staged credentials.
---

Systemd `EnvironmentFile` syntax is data, not a shell program. Never `source` one
to validate or copy values; parse its assignments without shell expansion.

**Why:** Secrets may legitimately contain `$`, backticks, spaces, or other shell
metacharacters. Sourcing the file can mutate a value before the service sees it.

**How to apply:** Generate quoted assignments deliberately, let systemd load the
file, and use a non-evaluating parser when a deploy-time validation needs values.

Pass release identifiers into remote scripts as positional arguments rather than
depending on nested heredoc expansion.

**Why:** Mixed local/remote quoting can turn a release identifier into literal
placeholder text or expand it in the wrong shell, invalidating the release guard.

**How to apply:** Use a quoted heredoc for remote code and pass selected values
after `bash -s --`; compare the resulting remote positional variables.

When replacing an active `RemainAfterExit` oneshot with a unit whose
`ExecStopPost` removes a staged credential, stop/reset the stale unit before
creating the new credential and use `start`, not `restart`.

**Why:** After `daemon-reload`, the new cleanup definition applies while stopping
the old active state. A restart can therefore delete the newly staged env file
before the start half reads it.

**How to apply:** Install the unit, reload systemd, stop/reset it, stage the
credential, then start the oneshot. Always verify the transient file is absent
after completion.

For a oneshot running under a different OS account, verify ordinary filesystem
traversal permissions on every parent of `WorkingDirectory` and `ExecStart`.

**Why:** Systemd reports `status=200/CHDIR` before application code runs when the
service account cannot traverse a parent, even if sandbox read paths are correct.

**How to apply:** Keep deploy code non-secret and traversable, while retaining
runtime secrets in a separate root-owned configuration path with narrow group
access.