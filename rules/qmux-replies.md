# Reply toasts in qmux

When `QMUX_SOCKET` is set, qmux shows each reply you finish a turn with as a toast, and keeps it under Alt p until the user reads it. End a reply with one of these lines, on its own as the very last line, when it should not toast that way:

- `**QMUX: NO TOAST**` when the turn left nothing for the user to read or decide. This is usually a turn started by a background event rather than by the user, such as a `quoll watch` line about a page you just wrote, or a job event that needs no action. qmux makes no toast and leaves the user's last reply in place.
- `**QMUX: BRIEF TOAST**` when the reply is worth a glance but needs nothing: a build passed, a page was updated. qmux shows it for five seconds, like a finished job.

Leave the line off for anything the user should read: a result of work they asked for, a question, a failure, or a decision they need to make. When unsure, leave it off; a spare toast costs the user little, and a missed question costs a lot.
