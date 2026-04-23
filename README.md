# spec-snapshot-scraper

AI-friendly docs/spec snapshot scraper for:

- normal websites (`web`)
- explicit URL sets (`url-list`)
- public GitHub documentation trees (`github-tree`)
- documentation indexes exposed via `llms.txt` (`llms-txt`)

It creates **versioned snapshots**, a **latest** mirror, **per-page metadata headers**, **URL inventories**, and **change summaries** so an agent can work against a reproducible local corpus instead of scraping ad hoc on every prompt.

## Why this exists

For a lot of protocol/spec work there still is **no trustworthy SDK** that gives you:

- the full docs set,
- stable local snapshots,
- content hashes,
- URL inventories,
- update detection,
- and a layout that is easy for LLMs/agents to consume.

This tool exists to fill that gap.

## Features

- **Spec/Docs snapshots** with `latest/` and `snapshots/<timestamp>/`
- **AI-oriented metadata headers** on every page:
  - source URL
  - canonical URL
  - title
  - fetch time
  - content type
  - HTTP status
  - SHA-256 of the fetched body
- **Change tracking** across runs:
  - added URLs
  - changed URLs
  - removed URLs
  - unchanged URLs
- **Automatic folder organization** by source name
- **Website crawling** with host restriction and include/exclude regex filters
- **`llms.txt` index ingestion** for docs sites that publish one
- **GitHub tree ingestion** for public repos using the GitHub tree API plus raw file fetches
- **Explicit URL-list mode** for targeted snapshots
- **URL inventory files** in both JSON and TXT formats

## Install

```bash
npm install
```

## Usage

```bash
node src/cli.mjs run --config examples/ircv3-web.json
```

or, once installed globally / linked:

```bash
spec-snapshot-scraper run --config examples/ircv3-web.json
```

## Output layout

Every run writes to the configured `outputDir`:

> `outputDir` is resolved **relative to the config file location**, so example configs inside `examples/` can intentionally target `../output/...` in the repository root.

```text
outputDir/
  latest/
    _run.json
    <source-name>/
      _manifest.json
      _changes.json
      _urls.json
      _urls.txt
      pages/**
  snapshots/
    <timestamp>/
      _run.json
      <source-name>/
        _manifest.json
        _changes.json
        _urls.json
        _urls.txt
        pages/**
  latest.json
```

### What each file is for

- `latest/` — current snapshot for agents/tools
- `snapshots/<timestamp>/` — immutable historical snapshots
- `_manifest.json` — all pages + metadata + fetch errors for one source
- `_changes.json` — what changed since the previous `latest` run
- `_urls.json` / `_urls.txt` — quick URL inventory
- `_run.json` — run summary across all configured sources
- `latest.json` — pointer to the newest snapshot

## Supported source types

### 1) `web`

Use this when the source is a normal documentation/spec website.

Example:

```json
{
  "outputDir": "./output/ircv3-web",
  "sources": [
    {
      "name": "ircv3-web",
      "type": "web",
      "rootUrl": "https://ircv3.net/",
      "seedUrls": [
        "https://ircv3.net/specs",
        "https://ircv3.net/registry",
        "https://ircv3.net/support-tables"
      ],
      "allowHosts": ["ircv3.net"],
      "includeUrlPatterns": [
        "^https://ircv3\\.net(?:/(?:specs(?:/.*)?|registry(?:/.*)?|support-tables(?:/.*)?)?)?/?$"
      ],
      "excludeUrlPatterns": [
        "^https://ircv3\\.net/rss/?$"
      ],
      "maxPages": 300
    }
  ]
}
```

### 2) `url-list`

Use this when you want a small curated set of exact URLs.

This is useful when you do not want the crawler to discover links.

### 3) `github-tree`

Use this for public GitHub documentation repos.

The tool fetches the public tree via GitHub's tree API and then downloads matching files from `raw.githubusercontent.com`.

This is better than manually maintaining large raw URL lists when the upstream docs repo changes often.

Example:

```json
{
  "outputDir": "./output/ircv3-github-tree",
  "sources": [
    {
      "name": "ircv3-github-tree",
      "type": "github-tree",
      "owner": "ircv3",
      "repo": "ircv3-specifications",
      "ref": "master",
      "includePathPatterns": [
        "^(?:README\\.md|specs/.+\\.md|extensions/.+\\.md|registry.+\\.md)$"
      ]
    }
  ]
}
```

### 4) `llms-txt`

Use this when the upstream docs site publishes a machine-readable documentation index at `llms.txt`.

This is ideal for projects like Iroh where the docs explicitly recommend discovering the full page set from that file first.

Example:

```json
{
  "outputDir": "./output/iroh-llms",
  "sources": [
    {
      "name": "iroh-llms",
      "type": "llms-txt",
      "llmsUrl": "https://docs.iroh.computer/llms.txt",
      "allowHosts": ["docs.iroh.computer"],
      "includeUrlPatterns": [
        "^https://docs\\.iroh\\.computer(?:/.*)?$"
      ]
    }
  ]
}
```

## Updating when upstream changes

Just rerun the same config:

```bash
node src/cli.mjs run --config examples/ircv3-web.json
```

The tool will:

- rebuild `latest/`
- create a new immutable timestamped snapshot
- compare the new pages against the previous `latest` manifest
- emit `_changes.json` with added/changed/removed/unchanged counts and URLs

That gives you a reproducible audit trail for spec drift.

## Ready-made configs

- `examples/iroh-llms.json` — snapshots docs discovered from `https://docs.iroh.computer/llms.txt`
- `examples/rust-stable-web.json` — crawls the stable Rust docs surface (`book`, `reference`, `rustdoc`, `cargo`, `std`) with a bounded page budget
- `examples/docsrs-about.json` — snapshots the stable docs.rs about/build/metadata pages without touching arbitrary crate docs
- `examples/quinn-docs.json` — snapshots the key Quinn docs.rs pages plus the Quinn guide for QUIC transport tuning work

## How metadata is stored for AI consumption

Every stored page begins with a YAML-style metadata header, for example:

```yaml
---
snapshotTool: spec-snapshot-scraper
snapshotVersion: 0.1.0
sourceName: ircv3-web
sourceType: web
sourceUrl: https://ircv3.net/specs/extensions/message-tags
canonicalUrl: https://ircv3.net/specs/extensions/message-tags
title: "Message Tags"
fetchedAt: 2026-04-22T00:00:00.000Z
contentType: "text/html; charset=utf-8"
status: 200
sha256: deadbeef...
---
```

This is meant to be trivial for agents to parse before consuming the page body.

## Notes on licensing

- **This repository/tool code** is MIT licensed.
- **The content you scrape is not automatically relicensed by this tool.**
- Upstream documentation/spec pages keep their own licenses.
- If you publish or redistribute snapshots, you are responsible for respecting upstream licenses and terms.

## Why not just use a docs SDK?

Because in many protocol/spec ecosystems there is no single maintained SDK that gives you all of:

- site crawl coverage,
- GitHub docs coverage,
- snapshotting,
- hashes,
- change tracking,
- and an agent-friendly on-disk format.

This tool is meant to be a simple, inspectable OSS answer to that.

## Roadmap ideas

- sitemap.xml ingestion
- robots.txt policy modes
- ETag / Last-Modified incremental fetch optimization
- frontmatter-only / comment-header output modes
- Markdown AST-aware normalization
- authenticated GitHub API support for larger private/internal docs sets
