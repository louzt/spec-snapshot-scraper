import test from "node:test";
import assert from "node:assert/strict";
import { discoverPaperAssetUrls, extractUrlsFromLlmsText } from "../src/cli.mjs";

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

test("discoverPaperAssetUrls converts arxiv abstract links to pdf assets", () => {
  const text = `
[Chimera Time-Crystalline order](https://arxiv.org/abs/2103.00104)
[Direct PDF](https://ru.iis.sociales.unam.mx/bitstream/IIS/5684/2/sociosemiotica_y_cultura.pdf)
`;

  const urls = discoverPaperAssetUrls(text, "https://example.com/list", {
    allowPaperHosts: ["arxiv.org", "ru.iis.sociales.unam.mx"],
  });

  assert.deepEqual(urls, [
    "https://arxiv.org/pdf/2103.00104",
    "https://ru.iis.sociales.unam.mx/bitstream/IIS/5684/2/sociosemiotica_y_cultura.pdf",
  ]);
});

test("discoverPaperAssetUrls supports explicit paper url patterns", () => {
  const text = `
https://example.org/papers/no-extension
https://example.org/blog/not-a-paper
`;

  const urls = discoverPaperAssetUrls(text, "https://example.org", {
    allowPaperHosts: ["example.org"],
    paperUrlPatterns: ["/papers/"],
  });

  assert.deepEqual(urls, ["https://example.org/papers/no-extension"]);
});