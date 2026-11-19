# Prompt Predictor — local prototype

Full custom prediction generation, local comparison tracking, red authorship coloring,
reliability monitoring and guarded Windows startup. This is an unofficial prototype,
not a published or clean-machine-verified installer. No automatic sending or data upload.

**Start here:** open the extracted package folder in Codex and ask it to follow the request in
[INSTALL-WITH-AI.md](INSTALL-WITH-AI.md). The AI can obtain dependencies, run setup and check
the results. You should only need to handle sign-in, required local approvals and when
to reopen Codex. Claude Code or another IDE agent can install it, but the target is the
Windows Codex composer; this package does not add predictions to other IDEs.

## Before setup

- Windows 11, app build listed in `manifest.json`, a signed-in eligible personal ChatGPT
  Pro account, native predictions enabled, and access to the configured Sol model.
- Default file-based `.codex/auth.json` authentication. Custom homes and other auth
  stores are not supported yet. A work subscription alone does not establish eligibility.
- Node with SQLite, WebSocket and Zstandard APIs (tested with 22.20.0), and Astral uv
  available locally. The installing AI can obtain official user-scoped copies and pass
  their absolute paths; no manual PATH work is needed. The coordinator does not itself
  download Node/uv. uv obtains isolated Python 3.14 and pinned mitmproxy. Internet is required.
- No competing prediction helper, proxy, monitor task or occupied helper/debug ports.
  Managed PCs may need IT permission. Setup refuses existing installations, including
  partial ones. `Install` is fresh-only; the narrow `Restore` path below accepts a completed,
  successfully removed installation of this identical package. It is not an updater.

## Install and use

Extract the ZIP onto local storage and use the AI installation request above. For direct
operation, `Check.cmd` checks preflight and `Setup.cmd` installs when tools are on PATH.
Check makes no installation/configuration changes; it writes an operation receipt. All
coordinator actions dispatch into native Windows and return a receipt to the calling AI.
Do not run it on a PC with an existing Prompt Predictor installation.

Setup trusts a new per-user local certificate and sets a Windows user proxy/PAC.
Applications honoring it route chatgpt.com through a loopback helper; only matching
prediction configuration is changed. The custom adapter tags its fetch to receive the
full generalized `prompt.txt` plus an acknowledgement the adapter requires. A missing
acknowledgement is an explicit error, never silent stock-prompt use. Native fetches retain the stock prompt, avoiding native
capacity failures if the custom adapter is absent. Eligibility/moderation remain intact.

Setup installs a dedicated **Prompt Predictor** Start-menu entry and sign-in entry, plus
a quiet monitor every two minutes. Turn off a competing native app sign-in entry in
Windows Startup settings when requested. No existing taskbar/Start-menu shortcut is
rewritten. You can pin the dedicated shortcut yourself. Native app/update launch routes
can bypass the debugger; use this maintained launcher for the custom workflow.

When safe, quit Codex normally and reopen through **Prompt Predictor**. Setup never quits,
restarts or launches Codex. Check `Status.cmd`; then complete a normal conversation and
observe a suggestion. Tab accepts an editable draft; you decide whether to send it.
An installer success means files/system controls were installed, not verified app receipt
or grey-text display. The custom fork's usage/billing exemption has not been established.

Each user gets a fresh local tracker in `%LOCALAPPDATA%/GreyPredictionComposer/capture`.
It records delivered predictions, interactions and corresponding saved messages. It can
read earlier local source context to reconcile a newly captured prediction. It neither
trains a model nor imports another person's history. No repository push or network upload
of tracker records is implemented. Existing Codex instructions/context remain the user's.

## Status and removal

Stable files are in `%LOCALAPPDATA%/PromptPredictorPrototype/app`; mutable state and
isolated Python are in `%LOCALAPPDATA%/GreyPredictionComposer`. Keep Node at the path
recorded during setup. Run installed `Status.cmd` or `Remove.cmd` (also available in the
download). Removal verifies ownership, removes the monitor, requests recorder/guard stop,
disposes owned renderer adapter/coloring, removes its startup/shortcut, restores prior
proxy settings through the existing helper and removes trust for its own certificate.

If renderer cleanup cannot be confirmed while Codex is open, removal stops with a clear
failure; quit normally when safe and retry. Unrelated changed controls are preserved and
reported. Files, local records and untrusted certificate/key files are retained; no data
directory is recursively deleted.

To keep the tool after a removal test, the installing AI runs installed `Manage.ps1
-Action Restore` through the same native dispatcher. Restore verifies a recorded completed
install and successful removal, identical manifest and unchanged installed files, retained
runtime/certificate identity, unchanged account/baseline and absent conflicting controls.
It reuses the existing runtime, CA and tracker; it does not copy files, run `prepare`,
download dependencies or rebuild the database. Codex may stay open if a read-only check
confirms no old adapter/coloring remains. Otherwise stop and finish removal when safe.

After Restore, repeat Status, the app-owned full-prompt receipt, visible suggestion and
tracker checks. Previous tracker rows must remain and new records should append. This
allows the pilot to finish working without folder cleanup. Active/partial/foreign installs,
older records without the completion/fingerprint fields, edited files, changed accounts
or a different package are rejected without overwriting them. Automatic upgrades/prompt
overrides remain unimplemented; never delete retained data or use Install to bypass this.

## Reviewing your own results

Use the installed `maintenance/Recorder.ps1 -Action Export` for local JSON evidence.
Compare original suggestion and the immediate actual message, using exported `pairing`
selection. Changed wording is not automatically dissatisfaction; unsent is not rejection.
Record capture gaps separately from usefulness. Review examples manually before choosing
prompt changes; there is no automatic scorer, trend dashboard or training loop here.

## Development

This tree is generated from a private source through an explicit allowlist and checked
transforms. Do not maintain a second edited implementation here. Send proposed changes
upstream; regenerate, compare file hashes, run tests, review both repository diffs, then
obtain the owner's approval for publication. Credentials, databases, logs, settings
snapshots, historical evaluations and personal instructions are excluded from this tree.

Run the included fixture suites with `node --no-warnings --test recorder/*.test.mjs
generation/*.test.mjs maintenance/*.test.mjs` in a shell that expands those patterns.
Tests use temporary data/mock services. Test passage is not live installation evidence.
