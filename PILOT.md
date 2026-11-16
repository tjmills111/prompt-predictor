# Prompt Predictor V2 — first pilot: checks and limits

Snapshot `review-09`, release `v0.1.0-pilot.1`. Windows Codex app
`26.1111.2228.0`, full generalized prompt, Sol 6.1/High, 120-second allowance.
This is a first pilot; a successful teammate run has not yet been observed.

## Before starting

The installing AI follows the [repository installation request](README.md#start-here),
downloads/verifies the pinned release and checks Windows/app build, actual native-prediction
eligibility and Sol access, default file-based ChatGPT sign-in, managed-PC restrictions and
previous helper installations. Do not ask the person to classify their subscription; preserve
all account/configuration guards and explain a specific access failure. The AI handles Node/uv. The person handles
sign-in, necessary security approvals, timing of reopening Codex and normal interaction.
No separate OpenAI API key is used. Existing conflicting installations are preserved.

## Pilot acceptance

1. AI follows `package/INSTALL-WITH-AI.md`, verifies package integrity, handles dependencies
   and runs the supplied native Check/Install. Inspect the operation receipt; file presence
   or installer success alone does not establish working predictions.
2. Through the maintained launcher, verify fresh recorder heartbeat, all four capture hooks,
   active generator, helper health and monitoring. Require a tagged, modified **CodexBrowser**
   configuration receipt matching the normalized full installed prompt hash. A direct helper
   verifier receipt is insufficient. A missing acknowledgement must fail explicitly.
3. Person confirms visible grey text during a normal exchange and chooses whether to accept,
   edit and send. AI verifies delivered original and exact immediate saved continuation/pairing
   belong to that person. Retain completed row IDs/text hashes for the preservation check.
4. Verify another normal maintained-launcher reopen. Check Windows sign-in later when
   convenient; mark it unverified until observed rather than forcing a logoff.
5. Perform agreed Remove. Confirm owned task/startup/shortcut and certificate trust are removed,
   prior routing restored and recorder/guard/renderer integration stopped. Retain records/files.
   If renderer cleanup cannot be verified while Codex is open, quit normally when safe and retry.
6. Unless the person asks to stay removed, use installed `Manage.ps1 -Action Restore`.
   Only an unchanged owned completed installation after successful removal is accepted.
   Repeat full-prompt receipt, active/visible-use and tracker checks: old completed rows remain,
   a new own record appends. Counts/file bytes may grow through normal recording. Never use
   fresh Install, folder deletion, account rebinding or package migration to force restoration.

The final report must identify the end state and each missing check. Return only a concise
diagnostic summary with secrets and conversation content omitted; do not upload tracker data.

## What prior testing establishes

- **70 JavaScript tests, 18 Python test methods passed.** Engine/store/history/monitor tests,
  actual exported adapter/presentation tests, reproducible export and manifest integrity.
- Real isolated proxy with local HTTP upstream verified native → tagged → native responses,
  full prompt equality and route acknowledgement. No production account/model was contacted.
- Actual PowerShell/Node execution and a harmless real WMI worker exercised runtime/dispatch
  boundaries. The WMI worker only wrote a temporary receipt, not a real installation.
- Real temporary Node inspector exercised disposal and read-only restore guards. The app's
  native module/cache service was stubbed; this is not a live Codex renderer result.
- Windows install/remove/restore registrations, trust and external tools were **mocked**.
  A real SQLite fixture and baseline/CA files survived unchanged; invalid restore states and
  rollback failures were exercised. This is not proof on a clean Windows user profile.

Real dependency acquisition by another AI, first trust prompt, account/model access,
authenticated/TLS/cache delivery, displayed suggestions, sign-in and full remove/restore
remain pilot gates. Custom fork usage accounting is unknown. No general update, other IDE
composer integration, cross-platform install or automatic scoring is claimed.
