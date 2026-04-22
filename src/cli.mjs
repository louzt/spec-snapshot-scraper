#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const VERSION = "0.1.0";
const DEFAULT_USER_AGENT = `spec-snapshot-scraper/${VERSION} (+https://github.com/louzt/spec-snapshot-scraper)`;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ACCEPT = "text/html, text/plain, text/markdown, application/xhtml+xml;q=0.9, */*;q=0.1";
const DEFAULT_SKIPPABLE_ASSET_RE = /\.(css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|pdf|xml|zip|gz|mp4|mp3|webm)$/i;

const blockSelectors = [
  "script",
  "style",
  "noscript",
  "svg",
  "img",
  "video",
  "audio",
  "form",
  "button",
  "iframe",
  "canvas",
  "header",
  "footer",
  "aside",
  "nav",
  "[role='navigation']",
].join(", ");

function usage() {
  return `spec-snapshot-scraper ${VERSION}\n\nUsage:\n  spec-snapshot-scraper run --config <path-to-json>\n\nConfig source types:\n  - web\n  - url-list\n  - github-tree\n`;
}

function parseArgs(argv) {
  const args = { command: "run", configPath: null };
  const rest = [...argv];

  if (rest[0] && !rest[0].startsWith("-")) {
    args.command = rest.shift();
  }

  while (rest.length > 0) {
    const token = rest.shift();
    if (token === "--config") {
      args.configPath = rest.shift() ?? null;
      continue;
    }
    if (token === "-h" || token === "--help") {
      args.command = "help";
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeWhitespace(text) {
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

function sanitizeSegment(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "index";
}

function safeFileNameFromUrl(urlString) {
  const url = new URL(urlString);
  const rawPath = url.pathname === "/" ? "home" : url.pathname.replace(/^\//, "");
  const cleanPath = rawPath
    .split("/")
    .map((segment) => sanitizeSegment(segment))
    .join("/");
  const querySuffix = url.search ? `--${sanitizeSegment(url.search.slice(1))}` : "";
  const candidate = `${cleanPath}${querySuffix}`;
  return candidate.endsWith(".md") ? candidate : `${candidate}.md`;
}

function deriveTitleFromUrl(urlString) {
  const url = new URL(urlString);
  const baseName = path.posix.basename(url.pathname);
  if (baseName && baseName !== "/") return baseName;
  if (url.pathname && url.pathname !== "/") return url.pathname.replace(/^\//, "");
  return url.host;
}

function ensureMarkdownExtension(relativePath) {
  return relativePath.endsWith(".md") ? relativePath : `${relativePath}.md`;
}

function regexList(patterns = []) {
  return patterns.map((pattern) => new RegExp(pattern));
}

function matchesAny(input, regexes) {
  return regexes.length > 0 && regexes.some((regex) => regex.test(input));
}

function shouldKeepByPatterns(input, includeRegexes, excludeRegexes) {
  if (excludeRegexes.length > 0 && matchesAny(input, excludeRegexes)) return false;
  if (includeRegexes.length === 0) return true;
  return matchesAny(input, includeRegexes);
}

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
    },
  };
}

async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = withTimeout(options.signal, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: DEFAULT_ACCEPT,
        "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
        ...(options.headers ?? {}),
      },
      signal: timeout.signal,
    });

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      text,
      contentType: response.headers.get("content-type") || "",
      etag: response.headers.get("etag") || "",
      lastModified: response.headers.get("last-modified") || "",
    };
  } finally {
    timeout.done();
  }
}

function normalizeWebUrl(href, currentUrl, source) {
  if (!href) return null;
  if (
    href.startsWith("#") ||
    href.startsWith("mailto:") ||
    href.startsWith("javascript:") ||
    href.startsWith("tel:")
  ) {
    return null;
  }

  let url;
  try {
    url = new URL(href, currentUrl);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.protocol === "http:") url.protocol = "https:";
  url.hash = "";

  const allowHosts = source.allowHosts?.length ? source.allowHosts : [new URL(source.rootUrl).host];
  if (!allowHosts.includes(url.host)) return null;
  if (DEFAULT_SKIPPABLE_ASSET_RE.test(url.pathname)) return null;

  const normalized = url.toString().replace(/\/$/, (match, offset, full) => {
    return new URL(full).pathname === "/" ? match : "";
  });

  const includeRegexes = regexList(source.includeUrlPatterns);
  const excludeRegexes = regexList(source.excludeUrlPatterns);
  if (!shouldKeepByPatterns(normalized, includeRegexes, excludeRegexes)) return null;

  return normalized;
}

function inlineText(node, baseUrl, source) {
  if (node.nodeType === 3) {
    return normalizeWhitespace(node.textContent || "");
  }

  if (node.nodeType !== 1) return "";

  const element = node;
  if (element.tagName === "BR") return "\n";

  if (element.tagName === "A") {
    const text = normalizeWhitespace(element.textContent || "");
    const href = element.getAttribute("href");
    const absolute = href ? normalizeWebUrl(href, baseUrl, source) ?? href : null;
    return text ? (absolute ? `${text} (${absolute})` : text) : absolute || "";
  }

  const parts = [];
  for (const child of element.childNodes) {
    const value = inlineText(child, baseUrl, source);
    if (value) parts.push(value);
  }

  return normalizeWhitespace(parts.join(" "));
}

function renderList(element, baseUrl, source, depth = 0) {
  const lines = [];
  const items = Array.from(element.children).filter((child) => child.tagName === "LI");

  items.forEach((item, index) => {
    const prefix = element.tagName === "OL" ? `${index + 1}.` : "-";
    const inlineParts = [];
    const nestedBlocks = [];

    for (const child of item.childNodes) {
      if (child.nodeType === 1 && ["UL", "OL"].includes(child.tagName)) {
        nestedBlocks.push(renderList(child, baseUrl, source, depth + 1));
      } else {
        const text = inlineText(child, baseUrl, source);
        if (text) inlineParts.push(text);
      }
    }

    const indent = "  ".repeat(depth);
    const line = `${indent}${prefix} ${normalizeWhitespace(inlineParts.join(" "))}`.trimEnd();
    if (line.trim()) lines.push(line);
    nestedBlocks.filter(Boolean).forEach((nested) => lines.push(nested));
  });

  return lines.join("\n");
}

function renderTable(element) {
  const rows = Array.from(element.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.children)
        .map((cell) => normalizeWhitespace(cell.textContent || ""))
        .filter(Boolean),
    )
    .filter((row) => row.length > 0);

  if (rows.length === 0) return "";
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function renderHtmlBlock(node, baseUrl, source) {
  if (node.nodeType === 3) return normalizeWhitespace(node.textContent || "");
  if (node.nodeType !== 1) return "";

  const element = node;
  const tag = element.tagName;

  if (/^H[1-6]$/.test(tag)) {
    const level = Number.parseInt(tag.slice(1), 10);
    const text = inlineText(element, baseUrl, source);
    return text ? `${"#".repeat(level)} ${text}` : "";
  }

  if (tag === "P") return inlineText(element, baseUrl, source);

  if (tag === "PRE") {
    const code = (element.textContent || "").trimEnd();
    return code ? `\`\`\`\n${code}\n\`\`\`` : "";
  }

  if (["UL", "OL"].includes(tag)) return renderList(element, baseUrl, source);
  if (tag === "TABLE") return renderTable(element);

  if (tag === "BLOCKQUOTE") {
    const text = inlineText(element, baseUrl, source);
    return text
      ? text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      : "";
  }

  const childBlocks = [];
  for (const child of element.childNodes) {
    const rendered = renderHtmlBlock(child, baseUrl, source);
    if (rendered) childBlocks.push(rendered);
  }

  return childBlocks.length > 0 ? childBlocks.join("\n\n") : inlineText(element, baseUrl, source);
}

function htmlToMarkdownish(html, sourceUrl, source) {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const root = document.querySelector(source.articleSelector || "article") || document.querySelector("main") || document.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll(blockSelectors).forEach((node) => node.remove());

  const body = renderHtmlBlock(clone, sourceUrl, source)
    .split(/\n{3,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n");

  const links = Array.from(document.querySelectorAll("a[href]"))
    .map((anchor) => normalizeWebUrl(anchor.getAttribute("href"), sourceUrl, source))
    .filter(Boolean);

  return {
    title: normalizeWhitespace(document.title || sourceUrl),
    body,
    links,
  };
}

function textToStoredBody(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function buildPageDocument(page) {
  const meta = [
    "---",
    `snapshotTool: spec-snapshot-scraper`,
    `snapshotVersion: ${VERSION}`,
    `sourceName: ${page.sourceName}`,
    `sourceType: ${page.sourceType}`,
    `sourceUrl: ${page.sourceUrl}`,
    `canonicalUrl: ${page.canonicalUrl}`,
    `title: ${JSON.stringify(page.title)}`,
    `fetchedAt: ${page.fetchedAt}`,
    `contentType: ${JSON.stringify(page.contentType)}`,
    `status: ${page.status}`,
    `sha256: ${page.sha256}`,
    ...(page.etag ? [`etag: ${JSON.stringify(page.etag)}`] : []),
    ...(page.lastModified ? [`lastModified: ${JSON.stringify(page.lastModified)}`] : []),
    ...(page.repoPath ? [`repoPath: ${JSON.stringify(page.repoPath)}`] : []),
    ...(page.githubRef ? [`githubRef: ${JSON.stringify(page.githubRef)}`] : []),
    "---",
    "",
  ];

  return `${meta.join("\n")}${page.body.endsWith("\n") ? page.body : `${page.body}\n`}`;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirFor(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function writeDualFile(latestRoot, snapshotRoot, relativePath, contents) {
  const targets = [path.join(latestRoot, relativePath), path.join(snapshotRoot, relativePath)];
  for (const target of targets) {
    await ensureDirFor(target);
    await writeFile(target, contents, "utf8");
  }
}

function computeChangeSet(previousManifest, currentPages) {
  const previousPages = previousManifest?.pages ?? [];
  const previousMap = new Map(previousPages.map((page) => [page.sourceUrl, page.sha256]));
  const currentMap = new Map(currentPages.map((page) => [page.sourceUrl, page.sha256]));

  const added = [];
  const changed = [];
  const unchanged = [];
  const removed = [];

  for (const page of currentPages) {
    const previousHash = previousMap.get(page.sourceUrl);
    if (previousHash === undefined) {
      added.push(page.sourceUrl);
    } else if (previousHash !== page.sha256) {
      changed.push(page.sourceUrl);
    } else {
      unchanged.push(page.sourceUrl);
    }
  }

  for (const previousPage of previousPages) {
    if (!currentMap.has(previousPage.sourceUrl)) {
      removed.push(previousPage.sourceUrl);
    }
  }

  return {
    added,
    changed,
    unchanged,
    removed,
    counts: {
      added: added.length,
      changed: changed.length,
      unchanged: unchanged.length,
      removed: removed.length,
    },
  };
}

async function loadPreviousSourceManifest(latestRoot, sourceName) {
  const manifestPath = path.join(latestRoot, sourceName, "_manifest.json");
  if (!(await pathExists(manifestPath))) return null;
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function runWebSource(source) {
  const maxPages = source.maxPages ?? 250;
  const queue = [...(source.seedUrls ?? [source.rootUrl])];
  const seen = new Set();
  const pages = [];
  const errors = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const currentUrl = queue.shift();
    if (!currentUrl || seen.has(currentUrl)) continue;
    seen.add(currentUrl);

    const response = await fetchText(currentUrl, {
      userAgent: source.userAgent,
      headers: source.headers,
      timeoutMs: source.timeoutMs,
    }).catch((error) => ({ ok: false, status: 0, url: currentUrl, text: "", contentType: "", etag: "", lastModified: "", error: String(error) }));

    if (!response.ok) {
      errors.push({ url: currentUrl, error: response.error || `HTTP ${response.status}` });
      continue;
    }

    if (!response.contentType.includes("text/html")) {
      errors.push({ url: currentUrl, error: `Skipped non-HTML content type: ${response.contentType}` });
      continue;
    }

    const fetchedAt = new Date().toISOString();
    const rendered = htmlToMarkdownish(response.text, response.url, source);
    const page = {
      sourceName: source.name,
      sourceType: source.type,
      sourceUrl: currentUrl,
      canonicalUrl: response.url,
      title: rendered.title,
      fetchedAt,
      contentType: response.contentType,
      status: response.status,
      sha256: sha256(response.text),
      etag: response.etag,
      lastModified: response.lastModified,
      outputPath: path.join("pages", safeFileNameFromUrl(currentUrl)),
      body: textToStoredBody(rendered.body),
    };

    pages.push(page);

    for (const link of rendered.links) {
      if (!seen.has(link) && !queue.includes(link)) queue.push(link);
    }
  }

  return { pages, errors };
}

async function runUrlListSource(source) {
  const pages = [];
  const errors = [];
  const urls = source.urls ?? [];

  for (const url of urls) {
    const response = await fetchText(url, {
      userAgent: source.userAgent,
      headers: source.headers,
      timeoutMs: source.timeoutMs,
    }).catch((error) => ({ ok: false, status: 0, url, text: "", contentType: "", etag: "", lastModified: "", error: String(error) }));

    if (!response.ok) {
      errors.push({ url, error: response.error || `HTTP ${response.status}` });
      continue;
    }

    const fetchedAt = new Date().toISOString();
    const isHtml = response.contentType.includes("text/html") || response.contentType.includes("application/xhtml+xml");
    const rendered = isHtml
      ? htmlToMarkdownish(response.text, response.url, { ...source, rootUrl: new URL(response.url).origin, allowHosts: [new URL(response.url).host] })
      : { title: deriveTitleFromUrl(response.url), body: response.text, links: [] };

    pages.push({
      sourceName: source.name,
      sourceType: source.type,
      sourceUrl: url,
      canonicalUrl: response.url,
      title: rendered.title,
      fetchedAt,
      contentType: response.contentType,
      status: response.status,
      sha256: sha256(response.text),
      etag: response.etag,
      lastModified: response.lastModified,
      outputPath: path.join("pages", safeFileNameFromUrl(url)),
      body: textToStoredBody(rendered.body),
    });
  }

  return { pages, errors };
}

function safeFileNameFromRepoPath(repoPath) {
  return ensureMarkdownExtension(path.join("pages", repoPath.split("/").map((segment) => sanitizeSegment(segment)).join("/")));
}

async function fetchGitHubTree(source) {
  const apiUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`;
  const response = await fetchText(apiUrl, {
    userAgent: source.userAgent,
    headers: {
      accept: "application/vnd.github+json",
      ...(source.headers ?? {}),
    },
    timeoutMs: source.timeoutMs,
  });

  if (!response.ok) {
    throw new Error(`GitHub tree fetch failed for ${source.owner}/${source.repo}@${source.ref}: HTTP ${response.status}`);
  }

  return JSON.parse(response.text);
}

async function runGitHubTreeSource(source) {
  const tree = await fetchGitHubTree(source);
  const includeRegexes = regexList(source.includePathPatterns);
  const excludeRegexes = regexList(source.excludePathPatterns);
  const pages = [];
  const errors = [];

  const items = (tree.tree ?? []).filter((item) => item.type === "blob");
  for (const item of items) {
    if (!shouldKeepByPatterns(item.path, includeRegexes, excludeRegexes)) continue;

    const rawUrl = source.rawBaseUrl
      ? `${source.rawBaseUrl.replace(/\/$/, "")}/${item.path}`
      : `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${item.path}`;

    const response = await fetchText(rawUrl, {
      userAgent: source.userAgent,
      headers: source.headers,
      timeoutMs: source.timeoutMs,
    }).catch((error) => ({ ok: false, status: 0, url: rawUrl, text: "", contentType: "", etag: "", lastModified: "", error: String(error) }));

    if (!response.ok) {
      errors.push({ url: rawUrl, error: response.error || `HTTP ${response.status}` });
      continue;
    }

    const fetchedAt = new Date().toISOString();
    const isHtml = response.contentType.includes("text/html") || response.contentType.includes("application/xhtml+xml");
    const rendered = isHtml
      ? htmlToMarkdownish(response.text, rawUrl, { rootUrl: new URL(rawUrl).origin, allowHosts: [new URL(rawUrl).host] })
      : { title: item.path, body: response.text, links: [] };

    pages.push({
      sourceName: source.name,
      sourceType: source.type,
      sourceUrl: rawUrl,
      canonicalUrl: rawUrl,
      title: rendered.title,
      fetchedAt,
      contentType: response.contentType,
      status: response.status,
      sha256: sha256(response.text),
      etag: response.etag,
      lastModified: response.lastModified,
      repoPath: item.path,
      githubRef: source.ref,
      outputPath: safeFileNameFromRepoPath(item.path),
      body: textToStoredBody(rendered.body),
    });
  }

  return { pages, errors };
}

async function runSource(source) {
  switch (source.type) {
    case "web":
      return runWebSource(source);
    case "url-list":
      return runUrlListSource(source);
    case "github-tree":
      return runGitHubTreeSource(source);
    default:
      throw new Error(`Unsupported source type: ${source.type}`);
  }
}

async function writeSourceOutputs({ latestRoot, snapshotRoot, source, runStartedAt, pages, errors, previousManifest }) {
  const sourceLatestRoot = path.join(latestRoot, source.name);
  const sourceSnapshotRoot = path.join(snapshotRoot, source.name);
  const changeSet = computeChangeSet(previousManifest, pages);

  for (const page of pages) {
    await writeDualFile(sourceLatestRoot, sourceSnapshotRoot, page.outputPath, buildPageDocument(page));
  }

  const manifest = {
    sourceName: source.name,
    sourceType: source.type,
    runStartedAt,
    completedAt: new Date().toISOString(),
    pageCount: pages.length,
    pages: pages.map((page) => ({
      sourceUrl: page.sourceUrl,
      canonicalUrl: page.canonicalUrl,
      title: page.title,
      fetchedAt: page.fetchedAt,
      contentType: page.contentType,
      status: page.status,
      sha256: page.sha256,
      outputPath: page.outputPath,
      ...(page.repoPath ? { repoPath: page.repoPath } : {}),
      ...(page.githubRef ? { githubRef: page.githubRef } : {}),
    })),
    errors,
  };

  const urls = pages.map((page) => ({ sourceUrl: page.sourceUrl, outputPath: page.outputPath, sha256: page.sha256 }));

  await writeDualFile(sourceLatestRoot, sourceSnapshotRoot, "_manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await writeDualFile(sourceLatestRoot, sourceSnapshotRoot, "_changes.json", `${JSON.stringify(changeSet, null, 2)}\n`);
  await writeDualFile(sourceLatestRoot, sourceSnapshotRoot, "_urls.json", `${JSON.stringify(urls, null, 2)}\n`);
  await writeDualFile(sourceLatestRoot, sourceSnapshotRoot, "_urls.txt", `${urls.map((entry) => entry.sourceUrl).join("\n")}\n`);

  return {
    sourceName: source.name,
    sourceType: source.type,
    pageCount: pages.length,
    errorCount: errors.length,
    changes: changeSet.counts,
  };
}

async function loadConfig(configPath) {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const text = await readFile(absolutePath, "utf8");
  const config = JSON.parse(text);
  if (!config.outputDir) {
    throw new Error("Config must define outputDir");
  }
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new Error("Config must define at least one source");
  }
  return { configPath: absolutePath, config };
}

async function run(configPath) {
  const { configPath: absoluteConfigPath, config } = await loadConfig(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  const outputRoot = path.resolve(configDir, config.outputDir);
  const latestRoot = path.join(outputRoot, "latest");
  const snapshotStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotRoot = path.join(outputRoot, "snapshots", snapshotStamp);
  const runStartedAt = new Date().toISOString();

  const previousManifests = new Map();
  for (const source of config.sources) {
    previousManifests.set(source.name, await loadPreviousSourceManifest(latestRoot, source.name));
  }

  await rm(latestRoot, { recursive: true, force: true });
  await mkdir(latestRoot, { recursive: true });
  await mkdir(snapshotRoot, { recursive: true });

  const sourceSummaries = [];

  for (const source of config.sources) {
    const { pages, errors } = await runSource(source);
    pages.sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
    errors.sort((a, b) => a.url.localeCompare(b.url));

    const summary = await writeSourceOutputs({
      latestRoot,
      snapshotRoot,
      source,
      runStartedAt,
      pages,
      errors,
      previousManifest: previousManifests.get(source.name),
    });
    sourceSummaries.push(summary);
  }

  const completedAt = new Date().toISOString();
  const runSummary = {
    tool: "spec-snapshot-scraper",
    version: VERSION,
    configPath: absoluteConfigPath,
    runStartedAt,
    completedAt,
    snapshotDir: path.relative(outputRoot, snapshotRoot),
    sourceCount: sourceSummaries.length,
    sources: sourceSummaries,
  };

  const latestPointer = {
    latestSnapshot: path.relative(outputRoot, snapshotRoot),
    generatedAt: completedAt,
  };

  await writeDualFile(latestRoot, snapshotRoot, "_run.json", `${JSON.stringify(runSummary, null, 2)}\n`);
  await writeFile(path.join(outputRoot, "latest.json"), `${JSON.stringify(latestPointer, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify(runSummary, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(usage());
    return;
  }

  if (args.command !== "run") {
    throw new Error(`Unsupported command: ${args.command}`);
  }
  if (!args.configPath) {
    throw new Error("Missing required --config argument");
  }

  await run(args.configPath);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
