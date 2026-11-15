# Prompt Predictor — first teammate pilot

Custom next-message suggestions in **Windows Codex**, with the full generalized prompt,
your own local tracker, prediction coloring and reliability monitoring.

**Requirements:** Windows 11; **Codex app build `26.1111.2228.0`**; an eligible personal
**ChatGPT Pro** account with native predictions available in your region and access to the
selected Sol model. A Business/Team subscription alone does not establish access.
Default file-based Codex sign-in is required. An unsupported build/account is a stop,
not a reason to bypass checks or downgrade your app.

**Codex, Claude Code or another local coding AI can install it. Predictions run in Codex.**
The installing AI needs local file and terminal access. It should handle dependencies;
you do not need to configure Node, Python or PATH manually.

## Start here

1. [Download the pilot ZIP](https://github.com/tjmills111/prompt-predictor/releases/download/v0.1.0-pilot.1/prompt-predictor-prototype.zip)
   from release **`v0.1.0-pilot.1`** and extract it to local storage.
2. Give the extracted folder to your local AI and paste this request:

```text
Install Prompt Predictor from this folder using its README.md and INSTALL-WITH-AI.md
in full. If this is a repository checkout, the supplied package is under package/.
First check the exact supported Windows Codex build, account eligibility and conflicts.
Handle official per-user dependencies and the supplied native Windows scripts yourself.
Preserve unrelated work and settings; don't rebuild the tool or bypass its guards.

Verify app receipt of the complete installed prompt, active generation/monitoring and my
own tracker records through normal use. Perform the documented removal test, then use
the bounded Restore action to finish working again unless I ask to leave it removed.
Preserve my history and repeat the prompt, visible-use and tracker checks after Restore.
Ask only for necessary sign-in, security approvals, normal-use confirmation or when to
reopen Codex. Never send messages for me, upload my records or delete retained data.
Report what actually passed, what remains unverified and the final installed/removed state.
```

3. Follow the AI through sign-in/security approvals, a normal Codex exchange and the agreed
   removal/restore test. Keep the same setup chat. You choose when to quit/reopen Codex
   and whether to send any suggested message.

The full [AI installation instructions](package/INSTALL-WITH-AI.md) and
[package operation guide](package/README.md) are included in the ZIP. If you already have
the repository locally, give the AI its `package/` folder instead; no Git expertise is
needed to install the release ZIP.

## What to expect

This is an unofficial **first pilot**, not a proven one-click installer on every PC.
The package includes the full prompt, custom Sol/High generation, local comparison tracker,
red prediction attribution, monitor, launcher, removal and narrow same-package Restore.
It starts without another person's conversations or records. Tracker data stays local;
there is no automatic training, grading, sending or tracker upload.

Installation uses a per-user trusted local certificate, chatgpt.com proxy routing and
Windows startup/monitor registrations. Your AI should explain those before activation;
managed PCs may need IT approval. Existing installations/conflicting controls stop safely.
Removal retains records/files; Restore reuses the identical owned completed installation
after successful removal. It is not an updater, migration or partial-install repair.

**Evidence:** 70 JavaScript tests and 18 Python test methods passed, including isolated
proxy/process/inspector checks and mocked Windows lifecycle/history-preservation scenarios.
Actual teammate installation, authenticated app receipt, visible suggestions, sign-in and
remove/restore behavior still need this pilot. Custom fork usage/billing treatment remains
unestablished. See [pilot checks and evidence limits](PILOT.md).

Source and release correspond to snapshot **`review-09`**. The exact tested ZIP and
checksum are attached to the release; GitHub's automatic source archive is a different ZIP.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
