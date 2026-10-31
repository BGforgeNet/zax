# GitHub captures for the indexer fixture test

Read-only captures of GitHub's answers for the four followed repositories, trimmed to the fields the
indexer reads. `crates/indexer/tests/fixtures.rs` serves them in place of GitHub.

| URL | File |
| --- | --- |
| `https://api.github.com/repositories/<id>` | `repository-<id>.json` |
| `https://api.github.com/repos/<owner>/<name>/releases?per_page=100` | `releases-<owner>-<name>.json` |
| `https://raw.githubusercontent.com/<owner>/<name>/<tag>/f2mod.yml` | none: answers 404 (no repository publishes one) |

Each listing keeps every release GitHub states digests for, plus a few older undigested ones (and
Fo1in2's prereleases); the Restoration Project and Unofficial Patch listings keep only the newest
undigested releases of each line. The pinned result is `../v1/index.json`; re-pin it with
`ZAX_PIN_INDEX=1 cargo test -p zax-indexer --test fixtures`.
