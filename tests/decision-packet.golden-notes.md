# Job C golden additions

The compatibility harness explicitly sets `autoVerify: false` to preserve its manual verification sequence. Verification now includes a reviewer even in that sequence.

- Starts and subsequent results expose the effective `autoVerify` flag.
- Running and verification results expose `livePhase`; checks and review provide phase-specific progress.
- Verification initialization clears `decisionPacket` and `decisionPacketPath`.
- Completed verification includes `reviewer`, `reviewerThreadId`, `reviewerStartedAt`, `decisionReadyAt`, `decisionPacket`, and its artifact path.
- The packet binds the assignment hash and verified fingerprint and includes checks, verdicts, risks, exact hunks, hunk availability/omissions, blockers, and sandbox limitation count.
- Every command check includes attempts, coverage error, and parsed test counts. Unknown counts remain null.
- Exec history gains the reviewer record with its distinct thread and usage. The latest child role and model timestamp now identify that reviewer; the original implementation exec and verification-child timestamp remain recorded.
- Reviewer/decision timestamps and assignment hashes are normalized as volatile values. UUIDs and artifact roots use the existing normalization.

The golden retains version normalization for 1.1.5. Baseline bytes remain internal artifacts and do not appear in full tool summaries. The reviewed semantic delta adds the above fields and updates phase progress/child ownership; it does not remove the previous assignment, result, check, review, or integration evidence.

Lead-review corrections add `cancelled: false` and `autoVerifySkipped: null` when verification starts, clear `livePhase` after implementation with auto verification disabled, and add strict reviewer `failingCheckIds` arrays. Packet-derived acceptance evidence has `source: "reviewer"`; explicit lead evidence is unchanged.
