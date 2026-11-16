# Prompt Predictor V2 — first teammate pilot

Custom next-message suggestions in **Windows Codex**, with the full generalized prompt,
your own local tracker, prediction coloring and reliability monitoring.

**For Windows 11 and Codex app build `26.1111.2228.0`. Predictions run in Codex.**
The configured default is **Sol (`gpt-6.1-sol`) / High reasoning effort**. This release
has no supported user setting for changing that profile and no Claude prediction integration.

## Start here

Give a local coding AI this repository link and the request below. The AI needs internet,
local file and terminal access; it handles the download, verification and technical setup.
A chat without access to your PC cannot perform the installation.

```text
Install Prompt Predictor V2 from https://github.com/tjmills111/prompt-predictor.
Follow its Start here instructions, handling the release download, checksum verification,
extraction and setup. Check my Windows/Codex compatibility and actual account/model access;
explain any blocker without asking me to work out subscription names or bypassing guards.
Use the supplied detailed instructions, including verification and removal/restoration
with tracker history preserved. Finish working unless I ask to leave it removed.
Involve me for sign-in, approvals, normal-use checks and restart timing.
Give me a brief results summary to send back, including anything unverified.
```

### Instructions for the installing AI

1. Read this README and [PILOT.md](PILOT.md). Check Windows 11 and the exact Codex build
   before obtaining dependencies. Explain an unsupported build; do not downgrade the app.
2. Download **both attached assets** from [release `v0.1.0-pilot.2`](https://github.com/tjmills111/prompt-predictor/releases/tag/v0.1.0-pilot.2):
   `prompt-predictor-prototype.zip` and `SHA256SUMS.txt`. Verify the ZIP's SHA-256 against
   the checksum file and this pinned value before extracting:
   `fe0b3dd45788cdf1d6b24c2e4e9a85a6f74f2d8b0b7ae44ddf9badc6276b4b4a`.
   Use local storage outside cloud-synced folders and a fresh destination; do not overwrite
   an existing installation. GitHub's automatic source ZIP is not the tested release asset.
3. Read the extracted `prompt-predictor/README.md` and `INSTALL-WITH-AI.md` in full;
   follow their supplied scripts and verification/removal/Restore procedure. Handle official
   per-user dependencies yourself. Preserve unrelated work and all installation guards.
4. **Account preflight:** check the signed-in account's actual native-prediction eligibility
   and access to the configured Sol model. Default file-based Codex sign-in is still required.
   The bundled personal-Pro wording describes the original supported pilot; for this handoff,
   use actual access checks rather than requiring the person to identify a subscription tier.
   This does not establish support for every plan: the stock configuration must report
   `is_enabled=true`, and the installer, generator and Restore checks remain authoritative.
   Explain an unavailable account/configuration/model; never force-enable it or log credentials.
5. Leave sign-in, necessary security/IT approvals, normal-use confirmation and restart timing
   with the person. Use the detailed pilot checks, preserve tracker history through Remove
   and Restore, and report what passed, anything unverified and the final working/removed state.

This release adds the three-sentence selection/testing refinement to the full generalized
prompt. The ZIP and manifest include it on the installation path; executable code is unchanged
from pilot.1. Existing installations stop safely; this is not an updater.

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

Source and release correspond to snapshot **`prompt-balance-2026-11-15`**. The exact tested ZIP and
checksum are attached to the release; GitHub's automatic source archive is a different ZIP.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
