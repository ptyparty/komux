# Long-running commands in qmux

When `QMUX_SOCKET` is set, you are running inside the user's qmux session.

- Start dev stacks, servers, watchers, and builds (for example `npm run dev`, `docker compose up`, a watch build) with the Bash tool's `run_in_background: true`. Never use `--detach`. qmux shows the command as a job the user can watch, dock, and stop.
- qmux names the job after the Bash tool's `description`, and shows that name on job chips, the dock, and toasts. Write the description as a short name for what keeps running, not as a sentence about starting it: `api server`, `web build`, `test watch`, not `Start the API dev server in the background`.
  - Put the word that tells this job apart from the others first, and keep the name to about 16 characters. Chips shorten names to 16, then 10, then 6 columns, and the dock cuts them at 24.
  - Leave out the tab or repo name, since toasts already show `tab › name`, and leave out verbs like "Start" or "Run".
- Read the background task's output to tell when the app is ready, rather than sleeping.
- If the stack is already running as a job in the tab, restart the part you changed (for example `docker compose restart api`) instead of starting another.
