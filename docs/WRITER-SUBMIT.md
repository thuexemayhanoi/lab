# WRITER SUBMIT — GitHub-only writer submission channel (canonical)

This is the canonical contract for the **GitHub-only writer submission
channel**: an external AI writer with ONLY the GitHub connector (no local
git, no local Node 22, no local `_drafts/`) can still submit exactly one
production pair (2 articles) per turn, and the deterministic factory inside
GitHub Actions performs claim → research → wrap → QA → atomic publish → one
clean production commit on main. `AGENTS.md` and `docs/PROC-PUBLISH.md`
reference this document. Local tooling (git + Node 22 + the writer direct
CLI) stays a valid OPTIONAL expert/recovery path — it is no longer a
REQUIREMENT for a writer session.

## Why this channel exists

`/lab` serves GitHub Pages from the repository ROOT, so drafts must never be
committed (`_drafts/` is gitignored forever). Until now `qa`/`publish` were
writer-direct-CLI only, which made local git + Node a hard prerequisite for
publishing. This channel closes that gap the `/vanchinh` way — like
`vanchinh/docs/CONTINUOUS-WRITER.md`, the writer pushes candidate INPUT files
to GitHub and an event-driven workflow IS the writer's execution environment
(Actions never writes prose; it only runs the deterministic engine).

## The submission contract (the ONLY files a writer ever pushes)

One ephemeral branch per pair, `writer/<pair>` (e.g. `writer/A00015-A00016`),
created from FRESH main. Exactly 5 files:

```
writer-inbox/A00015.body.html    semantic body fragment (ONE <h1>; no shell/html boilerplate)
writer-inbox/A00016.body.html
writer-inbox/submission.json     { "base_main_sha": "<40-hex main HEAD>", "ids": ["A00015", "A00016"] }
data/research/A00015.json        research packet (engine research op policy applies)
data/research/A00016.json
```

Hard rules (enforced by `scripts/factory/writer-submission.js
validate-submission` + the workflow):

- `base_main_sha` MUST equal the main HEAD at branch creation — a moved main
  ⇒ `STALE_WRITER_BASE` (never auto-rebase prose; recreate the branch from
  fresh main and resubmit).
- `ids` must be EXACTLY the next claimable contiguous pair from repository
  truth (`prepare-next` truth assert); a mismatch ⇒ `CLAIM_MISMATCH` with
  byte-exact truth restore (a different pair is never published).
- The inbox must contain EXACTLY the pair bodies + `submission.json` — flat,
  non-empty, no extra files.
- The branch diff may touch ONLY `writer-inbox/**` and
  `data/research/<pair-id>.json` (`WRITER_BRANCH_SCOPE`).
- `writer-inbox/` is NOT gitignored (it must be committable on `writer/**`
  branches) but can NEVER reach main (see "main receives only a clean
  production commit" below + the `ci-validate.yml` inbox-leak guard).

## What the workflow does (`.github/workflows/factory-writer-submit.yml`)

Triggered by push to `writer/**` (paths `writer-inbox/**` + `data/research/**`),
same global production concurrency group `lab-factory-production`,
`cancel-in-progress: false`:

1. `validate-submission` — branch contract + strict manifest + inbox fileset +
   packets; exports `SUBMISSION_IDS` / `SUBMISSION_BASE`.
2. Base freshness — `origin/main == base_main_sha` (`STALE_WRITER_BASE`) +
   ancestry check; branch scope diff check.
3. `recover` (idempotent hygiene) → `claim` — canonical
   `operator.js prepare-next --count 2 --scope fast` + repository-truth assert
   (claimed == submitted, else byte-exact restore + `CLAIM_MISMATCH`).
4. `materialize` — copy `writer-inbox/<ID>.body.html` into `_drafts/` INSIDE
   THE RUNNER ONLY (gitignored, never git-added) → `wrap-drafts.js`.
5. Canonical `operator.js research/qa/publish --scope fast` — default writer
   channel (`cli`), NEVER the Actions command-file channel. The rubric stays
   the single authority: this channel never scores, never redefines thresholds.
6. `assert-pass` — both rows PASS (≥ 75) or the submission fails SAFELY
   (`WRITER_QA_NOT_PASS`; nothing pushed, branch preserved for repair).
   REVIEW 70–74 is never publishable.
7. `assert-published` — post-publish invariants (archives, public pages,
   sitemap, tx inactive, lock free, exactly-one ledger publish event).
8. Clean production tree: temp index seeded at the submission base,
   `writer-inbox/**` + `_drafts/**` excluded, `git ls-files` leak guard
   (`PRODUCTION_TREE_LEAK`), canonical-path allowlist
   (`production-tree-check`), then `git commit-tree <tree> -p <base>` — the
   writer branch is NEVER merged into main.
9. Final FAST verify in a detached worktree on the EXACT production commit
   (status/consistency/grounding/assert-published/`test ! -d writer-inbox`/
   `test ! -d _drafts`).
10. Push — plain fast-forward `git push origin <commit>:refs/heads/main`;
    a main that moved mid-run ⇒ `MAIN_MOVED_DURING_PUBLISH` (no force push,
    no merge, no guess). The ephemeral writer branch is then deleted
    (non-fatal cleanup).

## Writer loop (GitHub-only session)

```
FETCH FRESH MAIN (repo state: checkpoint last_completed / next_claimable)
→ CHOOSE NEXT 2 (the next claimable contiguous pair)
→ RESEARCH 2 (packets data/research/<ID>.json per docs/RESEARCH-BEFORE-WRITE.md)
→ WRITE 2 BODIES (writer-inbox/<ID>.body.html — one <h1>, semantic fragment only)
→ CREATE BRANCH writer/<pair> FROM MAIN (record base_main_sha = exact main HEAD)
→ PUSH THE 5 FILES (one commit)
→ WATCH factory-writer-submit.yml GREEN (it claims/QA/publishes/commits to main)
→ VERIFY (main has the ONE clean production commit; branch self-deleted)
→ FETCH FRESH MAIN → NEXT 2 → REPEAT
```

If the workflow fails (QA, gates, races), the branch is preserved: fix the
bodies/packets ON THE SAME PAIR and push again. Never edit matrix/state by
hand; never push anything outside `writer-inbox/**` + `data/research/**`.

## Safety invariants (nothing here weakens /lab safety)

- Thresholds PASS ≥ 75 / REVIEW 70–74 unchanged; critical gates unchanged;
  QA evidence stays hash-bound; grounding gate stays.
- Atomic publish + `publishRollback` reused from the canonical engine; lock +
  transaction + checkpoint discipline reused; `CLAIM_MISMATCH` restores truth
  byte-exact.
- No force push anywhere; main moves ONLY by a plain fast-forward commit
  whose parent is the submission base; the writer branch is never merged.
- `_drafts/` stays gitignored FOREVER; `writer-inbox/**` can never reach main.
- Actions never writes prose and holds no API keys; `factory-writer-submit.yml`
  has `contents: write` only (no Pages permissions — Pages serves main only).
- Engine/workflow changes to this channel are Tier-4 surface:
  `factory-validate.yml`, `factory-capacity-validate.yml` and
  `factory-soak.yml` all trigger on `factory-writer-submit.yml`,
  `tests/writer-submit-tests.js` and this doc; regressions run in
  `node --test tests/test-suite.js tests/writer-submit-tests.js`.
  Normal writer submissions (writer branches) do NOT trigger the deep
  batteries — the published main commit runs exactly ONE lightweight content
  validation (`ci-validate.yml`).
