import test from "node:test";
import assert from "node:assert/strict";
import { extractUrlsFromLlmsText } from "../src/cli.mjs";

test("extractUrlsFromLlmsText collects absolute urls from llms.txt", () => {
  const text = `
# Documentation Index
https://docs.iroh.computer/overview
https://docs.iroh.computer/pricing
`;

  const urls = extractUrlsFromLlmsText(text, "https://docs.iroh.computer/llms.txt", {
    allowHosts: ["docs.iroh.computer"],
    includeUrlPatterns: ["^https://docs\\.iroh\\.computer(?:/.*)?$"],
    excludeUrlPatterns: ["^https://docs\\.iroh\\.computer/llms\\.txt$"]
  });

  assert.deepEqual(urls, [
    "https://docs.iroh.computer/overview",
    "https://docs.iroh.computer/pricing",
  ]);
});

test("extractUrlsFromLlmsText resolves markdown relative links", () => {
  const text = `
- [Billing](/iroh-services/billing)
- [Pricing](https://docs.iroh.computer/pricing)
- [Anchor](#overview)
`;

  const urls = extractUrlsFromLlmsText(text, "https://docs.iroh.computer/llms.txt", {
    allowHosts: ["docs.iroh.computer"],
    includeUrlPatterns: ["^https://docs\\.iroh\\.computer(?:/.*)?$"],
    excludeUrlPatterns: ["^https://docs\\.iroh\\.computer/llms\\.txt$"]
  });

  assert.deepEqual(urls, [
    "https://docs.iroh.computer/iroh-services/billing",
    "https://docs.iroh.computer/pricing",
  ]);
});

test("extractUrlsFromLlmsText respects host and exclude filters", () => {
  const text = `
https://docs.iroh.computer/llms.txt
https://docs.iroh.computer/overview
https://example.com/not-allowed
`;

  const urls = extractUrlsFromLlmsText(text, "https://docs.iroh.computer/llms.txt", {
    allowHosts: ["docs.iroh.computer"],
    includeUrlPatterns: ["^https://docs\\.iroh\\.computer(?:/.*)?$"],
    excludeUrlPatterns: ["^https://docs\\.iroh\\.computer/llms\\.txt$"]
  });

  assert.deepEqual(urls, ["https://docs.iroh.computer/overview"]);
});