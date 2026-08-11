# Change fragments

Add one short Markdown fragment for each user-visible change. Name it:

```text
short-description.added.md
short-description.changed.md
short-description.fixed.md
short-description.security.md
```

The file contains one user-facing bullet without a heading. Describe the
observable result, not the implementation. Internal refactors, tests, and
documentation-only changes do not need a fragment.

During an explicitly authorized release, group fragments under the matching
Keep a Changelog headings in `CHANGELOG.md`, then remove the consumed files.
