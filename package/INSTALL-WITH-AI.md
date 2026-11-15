# Install with a local coding AI

Give the extracted folder to Codex, Claude Code, or another local coding agent and paste
the request below. The agent handles dependencies and commands; the person handles only
necessary sign-in/security prompts and the timing of reopening Codex. This package targets
the **Windows Codex app**, regardless of which AI installs it. It is not a Claude/VS Code
composer plugin. Keep this setup chat for the pilot checks and removal.

```text
Install Prompt Predictor from this extracted folder, using its supplied scripts and
manifest. Complete setup and verification as far as this machine/account permits.
Read README.md and this file. Do not rebuild the implementation or copy my personal
context into it. This is a fresh-install pilot; preserve existing installations and work.
For the agreed removal test, finish with the tool working again unless I explicitly ask
to leave it removed. That return uses the narrow Restore action below, not a fresh reinstall.
Before obtaining dependencies, check the target OS, installed Codex build and sign-in
requirements. Explain any unsupported machine/account requirement before spending effort
on setup. The full tool targets Windows Codex; the AI doing installation may be different.

Handle technical setup yourself. Detect compatible Node (22.20+ APIs, preferably the
maintained 22.x line) and uv. Reuse compatible existing tools. If absent, install official
per-user copies without replacing global tools: Node's official Windows ZIP with its
matching published checksum, and Astral's official uv installer or release. Use a stable
user-owned dependency folder outside the extracted ZIP. For uv's standalone installer,
UV_UNMANAGED_INSTALL can select a stable folder without editing shell profiles/PATH.
Resolve the full node.exe/uv.exe paths and verify the binaries. Don't make me manage PATH
or install dependencies by hand. Follow local policy; ask only for unavailable credentials,
physical/security approval, or an actual scope/ownership conflict.

Run Manage.ps1 using normal Windows PowerShell, -NoProfile -ExecutionPolicy Bypass:
  -Action Check -NodePath <absolute node.exe> -UvPath <absolute uv.exe>
Then, if preflight permits:
  -Action Install -NodePath <absolute node.exe> -UvPath <absolute uv.exe>
Do NOT pass -NativeWorker yourself: the coordinator dispatches outside packaged-app
redirection and returns an operation receipt. Keep absolute paths across dispatch so a
new dependency works immediately even if the Windows session still has an old PATH.
Check requires no app/proxy/trust/startup changes; it writes only an operation receipt.
Install obtains isolated Python/dependencies, new local account baseline and certificate,
and registers the supplied full-workflow helper, recorder, coloring, monitor and launcher.
Briefly explain per-user certificate trust, chatgpt.com proxy routing and local recording.
Do not collect credentials in logs, disable eligibility/policy guards, restart Codex,
rewrite existing shortcuts, or toggle predictions to troubleshoot. Never run prepare again
just to clear an error. On failure inspect the receipt and stop/recover only owned effects;
don't rerun blindly, delete retained data or promise success from installed files alone.

Check the installed app build against manifest.json, file-based ChatGPT sign-in, native
prediction eligibility and selected model access. A work-plan subscription is not proof
of native access. Explain a real unsupported requirement directly; do not buy/switch plans.
If native sign-in startup conflicts, explain the exact setting. Ask me to quit/reopen
Codex through the new Prompt Predictor Start-menu entry when I am ready; don't close work.
If possible perform the launch when the app is already closed and I have selected that
step. Keep sign-in and later normal startup as separate verification steps.

After reopening, run installed Manage.ps1 -Action Status. Confirm all four capture hooks,
active Sol/High generator, fresh recorder heartbeat, helper health and monitor state.
Hash normalized installed prompt.txt. Require an app-owned configuration receipt in
evidence.jsonl with owned_route=true, modified=true, matching prompt hash and CodexBrowser
user agent. A direct helper verifier receipt is insufficient. If the tag/acknowledgement
is missing, the adapter must fail clearly; never substitute the stock or shortened prompt.
Use the package's existing background fetch helper on a completed local thread only if
needed for a bounded receipt check; it does not establish visible grey text.

Have me complete a normal exchange, observe a suggestion and accept/edit it if useful.
Never send a message for me. Export the local tracker through the supplied recorder and
confirm that delivered original, interaction and exact immediate saved message/pairing
belong to my conversation. An unsent suggestion is not rejection. Do not upload records,
run automated scoring or claim model learning. Test another maintained-launcher reopen;
sign-in monitoring remains unverified until actually observed. End with what is proven
and any missing evidence, not a generic installed-success claim.

For the agreed removal check, run installed Manage.ps1 -Action Remove. Verify its receipt,
removal of owned startup/shortcut/monitor, restored routing and removed certificate trust,
and retained tracker data. Before removal, note IDs and text hashes of completed tracker
pairs so preservation can be checked later without expecting live database bytes/counts
to remain fixed. If Codex is open but renderer cleanup is unavailable, ask me to
quit normally when safe and retry removal. Changed ownership must be preserved/reported.
Don't kill the app or recursively delete runtime/data. Node/uv, Python runtime and files
may be retained; no active package-owned system controls should remain after success.

If finishing installed, run the retained installed Manage.ps1 -Action Restore (do not pass
-NativeWorker). Do not call fresh Check/Install against the retained runtime. Restore
requires a recorded completed install and successful removal of this same unchanged
package, matching retained certificate/runtime, unchanged signed-in account/stock baseline
and no conflicting controls. It must reuse files, CA and tracker, not run prepare, pip/uv
or database initialization. It can run from the still-open Codex setup chat if its read-only
renderer check confirms the removed adapter/coloring is absent. Human certificate approval
may be required again. If a guard fails, explain it and preserve state; do not refresh
baselines, overwrite edited files, migrate another package or clean folders to force it.

After a successful Restore receipt, verify active generation, all four hooks, helper/monitor
health and matching tagged CodexBrowser full-prompt receipt again. Confirm visible use,
preservation of the earlier tracker pairs and append of a new own record. Use the maintained
launcher when a normal reopen is needed, with my timing. Finish the pilot reporting whether
the tool is working or deliberately removed and any unverified checks, not merely that
Restore registered controls. No general updater or active-install repair is authorized.
```

Official dependency instructions: [Node downloads](https://nodejs.org/en/download/),
[uv installation](https://docs.astral.sh/uv/getting-started/installation/), and
[uv unmanaged installation](https://docs.astral.sh/uv/reference/installer/#unmanaged-installations).
Use current official download metadata/checksums, not an unverified third-party script.
Downloading dependencies and completing a clean-PC installation remain pilot checks;
this instruction block is not proof that an arbitrary AI agent executed it successfully.
