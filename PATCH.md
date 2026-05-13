# Patch Record

## Branch

- `custom/changed-files-widget-behavior`

## Feature Intent

Hide the active-turn Changed files timeline card while an agent turn is still in progress. The card should appear only after that turn settles and changed files are present, while Changed files cards for older completed turns remain visible.

## Commits

- Feature branch commit: Hide active turn changed files widget.
- Final commit hashes should be recorded on `custom/base` after this branch is merged.

## Implementation Notes

- Gating happens in timeline row derivation, not in diff fetching, checkpoint storage, git status polling, or the Changed files tree renderer.
- `MessagesTimeline.logic.ts` suppresses `assistantTurnDiffSummary` only for the active assistant turn when `activeTurnInProgress` is true.
- Focused logic tests cover hiding the active in-progress turn while preserving older completed turn summaries, and showing the same active turn summary after the turn settles.

## Upstream Merge Context

- Use this record to preserve the product intent and implementation context when resolving conflicts from upstream changes.
- After this feature branch is merged back into the custom base branch, keep editing and maintaining this `PATCH.md` file on `custom/base` so the full patch record is available from the custom branch itself.
