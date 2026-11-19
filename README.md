# Prompt Predictor for Windows Codex

Open this repository in local Codex and ask: **“Install Prompt Predictor from this repository and verify that it works.”** Keep the repository in a local folder outside cloud sync. Codex handles dependencies, preflight, installation and checks. You handle sign-in, necessary security approvals, a convenient time to reopen Codex, and confirming a suggestion during normal use.

## Supported setup

Windows 11, Codex build `26.1111.2228.0`, default file-based ChatGPT authentication, native predictions enabled and access to `gpt-6.1-sol`. The reviewed path uses an eligible personal Pro account. Check actual feature and model access. A subscription label alone cannot establish compatibility. No separate API key is needed. This is a fresh installer. Existing or partial installations require separate handling.

## Instructions for Codex

1. Read [the installation request](package/INSTALL-WITH-AI.md) and [package requirements](package/README.md). Check OS, app build, account eligibility and existing installation before changing the machine. Explain any specific blocker. Use the supplied Check and Install actions.
2. Use the included `package/` directory. Verify its `manifest.json` SHA-256 is `20878ad58e291d714212df0be3bc2532eac8cf3ae3eda32f497fe23386aa956f` and verify every listed file against the manifest before running any package code. Preserve the exact bytes. If verification fails, stop. For a link-only install, obtain [the tagged release](https://github.com/tjmills111/prompt-predictor/releases/tag/v0.1.0-pilot.4), verify the ZIP against SHA256SUMS.txt and the pinned hash in [RELEASE.json](RELEASE.json), and apply the same manifest checks after extraction.
3. Follow the package instructions through [working-use verification](PILOT.md). Explain the per-user certificate, local proxy, recorder and startup changes before requesting access. Leave the verified installation running.

The predictor keeps recent finished suggestions available when moving among chats. A suggestion remains an editable preview. Tab accepts it and you decide whether to send. The tracker stores evidence locally. This release has passed package tests and personal runtime checks. A fresh teammate installation is still unobserved.
