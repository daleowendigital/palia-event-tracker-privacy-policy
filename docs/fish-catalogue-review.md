# Fish catalogue candidate review

The update workflow generates **review artifacts only**. It has read-only repository
permission, does not retain checkout credentials, and cannot commit, push, open a
pull request or deploy Pages. A successful validation is not publication approval.

## Generate and inspect a candidate

1. Obtain separate Owner approval before executing the workflow or live generation.
   The scheduled/manual workflow copies generation scripts to a new canonical
   temporary directory outside the checkout. Do not run generation in the checkout.
2. The runner reads root `fish.json` as the root baseline and fetches the currently
   published Pages catalogue as the public baseline. Checked-in `docs/fish.json`
   must agree with the public baseline; otherwise the run stops for review.
3. Review the diagnostic report, including additions, missing IDs, unknown schedules,
   changed fields and failed requests. Valid candidates include root/public JSON,
   referenced mirrored images and `src/fishVersion.ts`. Failed runs expose a failure
   report where possible, not a candidate artifact. Workflow logs are the fallback.
4. Review both baseline comparisons. Check names, Wiki page identities, schedules,
   locations, bait, values, descriptions and image mappings. Compare field values
   in the candidate JSON, not just the report's list of changed field names.

For a read-only report of current checked-in baseline differences, run:

```text
node tools/validateFishCatalogue.mjs --compare-baselines fish.json docs/fish.json
```

This diagnostic reports actual differences dynamically; it does not approve them.
The safety tests use fixed fixtures rather than today's catalogue counts.

## Review blocked changes and establish a new baseline

Unexpected removals, established Wiki page identity changes, renames and loss of
known schedules are intentionally blocked against **both** baselines. Failed Wiki
requests are not evidence that a Fish should be removed. Unknown schedules may stay
unknown; do not manufacture a time window or Fish record to make validation pass.

Today's root catalogue is not automatically an approved replacement: it records
failed fetches and omits Kilima Catfish and Kilima Grayling from the public baseline.
This procedure does not approve either removal.

There is no automatic exception mechanism. For an intentional blocked correction:

1. Stop generation/publication and obtain explicit Owner approval of the exact IDs,
   old/new identities, removals or schedule changes, supported by source evidence.
2. Prepare the exact corrected catalogue files in isolation for manual review.
   Review the failed report/logs and isolated files; do not relabel them as validated.
3. Under separate implementation and commit authorisation, incorporate only the
   approved root/public catalogue pair, required images and matching version output.
   This is a deliberate manual baseline transition, outside automatic candidate
   generation. Do not weaken validation, add a general bypass or silently rebase
   against an unapproved candidate. Correct failed retrievals before claiming a
   complete baseline.
4. Publication still requires explicit separate approval. A normal approved push
   can trigger the existing Pages deployment. Wait until live Pages serves the
   approved public file before resuming candidate runs; until then the baseline
   equality check should fail safely. Future runs read the newly approved baseline
   files at their checked-out commit and the corresponding live public catalogue.

Routine additions and valid schedule changes can pass validation, but still require
review and explicit approval before incorporation or publication. Re-run validation
if either baseline changes after the candidate was generated.

## Temporary Heather Manta editorial hold

`buildFishCandidate.mjs` applies a Heather Manta-only hold immediately after Wiki
extraction, before image enrichment, public mirroring and version generation. It
requires the unique ID `heather_manta` and Wiki page ID `268814`; a mismatch stops
generation. Conflicting source claims are an editorial reason to use `bestBait: []`
and `appears: null`, not proof that the source values are incorrect. A neutral
description removes those claims. Location, biome, rarity and all other fields stay
intact. BUG-017 displays Unconfirmed and suppresses timed countdowns/notifications.

The existing report's `heatherMantaEditorialOverride` contains raw and effective
bait, availability and description, page/revision IDs, held fields and proposed
differences. Raw fields are also compared with the checked-in root baseline where
available. That baseline may already be editorially corrected; this comparison is
not a persistent source history. A changed revision alone proves no gameplay fact.

Review new raw evidence and obtain explicit Owner approval before changing either
`holdBait` or `holdAvailability` in the helper. Each can be restored independently;
the description remains neutral rather than copying unreviewed prose. Review the
resulting candidate and separately approve incorporation and publication.

The validator remains unchanged. Against the current known root schedule, this
hold deliberately fails with `lost known schedule: heather_manta`: the failure
report retains the editorial evidence, but no validated review candidate is exported.
Use the manual baseline-transition procedure above for the initial approved
incorporation. Do not bypass the failure or call it validated. Once the approved
root/public baseline and live Pages agree on the unknown schedule, normal future
validation can proceed while the hold remains active.

## Verify a separately authorised publication

- Confirm Pages deployed the intended commit and `/fish.json` matches approved
  `docs/fish.json`, including IDs, count, metadata and schedules. Check image URLs.
- On Android, verify the loaded source, count and expected Fish membership. The app
  prefers Pages, then raw main/master; a valid stale Pages response prevents fallback.
- Account for the versioned cache and six-hour refresh interval. Do not clear saved
  progress or preferences as a diagnostic shortcut.
- Check existing catch/star progress, visibility and bell preferences, availability
  labels, planning and countdowns. Missing Fish can affect marker preferences, so
  compare IDs before and after publication.

Local mocked tests do not prove Node 20, Wiki access or GitHub artifact delivery in
the live environment. Those need separately authorised controlled verification.
