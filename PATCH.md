# Custom Patch Record

This file records the product patches carried on `custom/base`.

## Features

### Changed Files Widget Behavior

- Source branch: `custom/changed-files-widget-behavior`
- Status: Finalized and merged into `custom/base`
- Finalized at: 2026-05-13 20:49:53 +0500

#### Feature Intent

Hide the active-turn Changed files timeline card while an agent turn is still in progress. The card should appear only after that turn settles and changed files are present, while Changed files cards for older completed turns remain visible.

#### Commits

- `fd22bdd3` - Hide active turn changed files widget.
- `d341c894` - Merge changed files widget behavior into custom.

#### Implementation Notes

- Gating happens in timeline row derivation, not in diff fetching, checkpoint storage, git status polling, or the Changed files tree renderer.
- `MessagesTimeline.logic.ts` suppresses `assistantTurnDiffSummary` only for the active assistant turn when `activeTurnInProgress` is true.
- Focused logic tests cover hiding the active in-progress turn while preserving older completed turn summaries, and showing the same active turn summary after the turn settles.

#### Upstream Merge Context

- Preserve the timeline row-derivation gate when resolving upstream conflicts around `MessagesTimeline.logic.ts`.
- If upstream changes the Changed files UI, keep the product behavior: no active-turn Changed files card while an agent turn is ongoing; completed-turn cards remain visible.
