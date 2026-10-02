# Project profiles in 1.1.2

Claude Code remains the host. Claude leads and accepts work; Codex implements it. The six new tools add policy, delivery and continuity to the eight existing tools.

## Start with a profile

Place a reviewed profile at .codex-team/profile.json. See [the schema](../schemas/profile.schema.json) and the [Node example](../examples/node/profile.json). The standard and strict templates are built into the runtime and also exported under templates/.

Call codex_profile read with cwd and, for a lane project, its target branch or lane/topic. Inspect the resolved policy, referenced resource hashes and command templates. Call approve with its exact expectedHash. Approval is specific to the common Git repository, lane and policy hash. It is Claude's technical approval within existing authorization, not permission to install, publish or make business decisions.

A local .codex-team/profile.local.json must already be ignored. It can tighten limits/prohibitions or configure an approved machine-specific tool path. It cannot turn an enforced check off, replace its command, lower coverage, broaden ownership or bypass a browser requirement. Policy changes require another technical approval. Invalid profiles stop new profile work; existing jobs remain readable.

No profile preserves the old workflow. The tool inventory is additive (14 tools); version metadata changes separately from legacy behavior.

## Assignment, checks and evidence

codex_start retains structured assignments and stable requestId. New optional fields are branch, topic, lane, contextPacks, criteriaTemplates, criteriaOmissions and batchId. Use literal file/directory scopes; patterns belong in the profile. Criteria can remain strings, or become objects with text, optional id and tags.

Profile checks are combined with assignment checks. includeProfileChecks=false cannot omit enforce checks. Commands are argv arrays with variable expansion and no implicit shell. A files variable occupying a complete argument expands to several arguments. Reserved variables cannot be overridden.

repoRoot is the job's policy checkout; worktree is its execution checkout. A batch child has its own policy checkout. Shared tools stored in ignored directories must therefore use an approved absolute path, for example through a profile variable. Child worktrees do not inherit ignored toolchain installations.

Affected tests are selected by changed tests, explicit name maps and a bounded relative-import graph. Dynamic/unknown dependencies conservatively include the affected test. Exceeding the scan bound fails with a diagnostic. Per-file processes remain isolated. A genuine timeout gets at most one isolated retry; failed assertions do not.

Each selected coverage test must write its own LCOV report into its designated scratch/fileId directory. Lines are combined by source line; named functions by identity. Bun reports without identities use a conservative lower bound from FNF/FNH, not summed hit counts. Missing instrumentation fails. Test totals are unknown when output cannot be recognized; unknown is not zero.

Owner exceptions are separate records: codex_profile approve can receive ownerApprovals entries with an exact path, the existing owner's quote and its date. They apply only to that profile hash and branch. A configured approvalLane limits who can record them. This records the lead's attestation of existing authorization. It does not generate authorization, waive another lane's ownership or make an unowned path owned.

For browser criteria, codex_review accepts leadObservation with kind=browser, tool, URL without access tokens, viewports, consoleErrors, failedRequests and relative attachment paths. For an owner decision use kind=ownerDecision, quote and date. Supply a criterionIndex and an independent observation in either case. The plugin copies bounded attachments and records hashes. Missing required evidence produces pending_lead_evidence. It never substitutes a different browser controller or treats worker claims as independent proof.

## Code acceptance and branch delivery

With branchMode enabled, start creates a named, ignored worktree and records its ownership. It preserves the main checkout and other sessions' work. Existing dirty worktrees are not silently adopted. Profile branch pushes must require a lead call and the own branch.

The sequence is:

1. Wait for implementation_finished and inspect the changes.
2. Run codex_verify, then accept each criterion with codex_review.
3. Run codex_integrate to commit the accepted code on the recorded branch.
4. Run codex_report render; complete the owner summary, requests, decisions and deviations. Empty arrays explicitly mean none.
5. Run write with expectedTargetHash returned by render when there is a target. The target uses SHA-256 of current bytes; an absent file uses SHA-256 of empty bytes. The report has its own commit.
6. If already authorized, call codex_push with the exact expectedCommit. A permitted forceWithLease additionally requires expectedRemoteCommit. No implicit force, tags, trunk push, rebase, deployment or trunk integration occurs.

Custom report templates contain {{body}}. Additional leader fields include lessonSummary, requirementIds, schemaNotes, operatorView and securityNotes. A profile may require them. Reports distinguish recorded results from leader observations, use the configured timezone, and emit the final queue commit after creating the report commit.

Commit/report intents are retained in the job directory. A retry can recognize its own completed operation or staged files after interruption. Unrelated edits/history stop recovery; the plugin never resets or deletes them. A successful code acceptance alone does not mean delivery or push happened.

## Parallel work

codex_batch start requires a stable requestId, a reference to the user's existing authorization for multiple workers, and named child assignments. Repository instructions still apply. Having the feature installed is not permission to spawn agents.

Scopes must be disjoint, and shared files must be prepared before the children. If prewire is required, provide a currently accepted prewireJobId from the parent worktree. In named-branch mode use the recorded parent worktree as cwd; each child gets its own branch. Without branchMode, children use detached worktrees and reviewed file deltas.

Review and accept every child. In branch mode, call codex_integrate for each child to commit it. Then codex_batch integrate applies them sequentially to the parent, stops on conflict and returns a unionJobId. The union still needs independent verification and review. Resume an existing child or union job for corrections; the batch tracks its latest attempt.

Integration intents/checkpoints survive a server interruption. For a recorded conflict, the lead directs resolution in the parent and commits it within the affected child's scope. Supply resolution.commit and resolution.summary on the next integrate call. The plugin validates the exact commit and clean state; later children are not applied while a conflict remains.

Worker and verification limits coordinate processes sharing the plugin state. They do not govern unrelated Claude, Bun or other external processes. Cancellation is requested through codex_cancel for each active child; preserve the batch for inspection/revision.

## Usage, secrets, text and handoff

Usage is reported in tokens, with cached input separated without double counting. Budget enforcement acts on observed CLI events and can stop subsequent work or cancel after an overrun is reported. It is not a hard provider billing limit. The documented CLI stream reports usage at turn.completed; see [OpenAI's non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode). A price estimate exists only with a supplied model price table. Claude usage and external charges are outside this ledger.

Secret patterns are scanned with a bounded execution time. Matching persisted text is redacted at ingestion, including stdout, stderr, result text and state fields. The CLI's last-message file is temporarily written to a dedicated user temporary directory, then scanned before copying into managed state and removed on normal cleanup. An abrupt OS/process failure can leave that temporary file; do not claim universal disk erasure. Historical state, Codex's own history, filenames and binary screenshots are not retrospectively scrubbed by this release.

Forbidden paths and command evidence support detection, not a read sandbox. A suspicious access/secret result blocks acceptance in enforce. No sandbox/ACL/hook weakening is part of recovery.

codex_hygiene check reports the current fingerprint and format differences. fix requires that fingerprint and preserves an unambiguous working baseline; it invalidates prior verification. Mixed baseline endings, unknown encodings and contradictory format rules require investigation rather than guessed conversion.

With continuity enabled, contexts are keyed by common repository and branch and use expectedVersion. codex_handoff export returns readable notes and a bounded data block. import merges notes for the same repository/branch; it never imports approvals, acceptance or executable actions. File exports require an authorized destination, an expected byte hash and an existing ignore rule when untracked. In branch mode files live in the recorded own worktree.
