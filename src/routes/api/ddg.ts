import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import puppeteer from "@cloudflare/puppeteer";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { GoogleGenAI } from "@google/genai";

type ReadabilityArticle = {
  title: string;
  content: string;
  byline?: string | null;
  length?: number | null;
  excerpt?: string | null;
  siteName?: string | null;
};

const NAV_TIMEOUT_MS = 10000;
const OP_TIMEOUT_MS = 10000;

// Rotate realistic desktop user-agents to reduce bot detection risk
const USER_AGENT_LIST: ReadonlyArray<string> = [
  // Safari on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  // Firefox on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  // Chrome on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.88 Safari/537.36",
  // Chrome on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.88 Safari/537.36",
  // Edge on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.88 Safari/537.36 Edg/127.0.2651.74",
];

function pickRandom<T>(items: ReadonlyArray<T>): T {
  const idx = Math.floor(Math.random() * items.length);
  return items[idx];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOCALES: ReadonlyArray<string> = ["en-US", "en-GB", "en-CA"];
const TIMEZONES: ReadonlyArray<string> = [
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "America/Toronto",
];

type ViewportChoice = {
  width: number;
  height: number;
  deviceScaleFactor: number;
};
const VIEWPORTS: ReadonlyArray<ViewportChoice> = [
  { width: 1366, height: 768, deviceScaleFactor: 1 },
  { width: 1440, height: 900, deviceScaleFactor: 2 },
  { width: 1920, height: 1080, deviceScaleFactor: 1 },
];

function buildAcceptLanguage(locale: string): string {
  const base = locale.split("-")[0];
  return `${locale},${base};q=0.9`;
}

async function applyPageStealth(
  page: import("@cloudflare/puppeteer").Page,
  opts: {
    userAgent: string;
    locale: string;
    timezone: string;
    viewport: ViewportChoice;
  }
): Promise<void> {
  await page.setUserAgent(opts.userAgent);
  await page.setViewport(opts.viewport);
  await page.emulateTimezone(opts.timezone);
  await page.setExtraHTTPHeaders({
    "Accept-Language": buildAcceptLanguage(opts.locale),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Upgrade-Insecure-Requests": "1",
  });
  // Subtle JS-level fingerprints
  await page.evaluateOnNewDocument(() => {
    try {
      // webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // languages
      const langs = [
        (navigator.language || "en-US") as string,
        (navigator.language?.split("-")[0] || "en") as string,
      ];
      Object.defineProperty(navigator, "languages", { get: () => langs });
      // plugins length
      // @ts-ignore
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      // chrome runtime shim
      // @ts-ignore
      (window as unknown as { chrome?: { runtime?: object } }).chrome = {
        runtime: {},
      };
    } catch {
      // ignore
    }
  });
}

async function firstNonNullWithConcurrency<TInput, TResult>(
  inputs: ReadonlyArray<TInput>,
  worker: (input: TInput) => Promise<TResult | null>,
  concurrency: number
): Promise<TResult | null> {
  if (inputs.length === 0) return null;
  let index = 0;
  let resolved = false;
  let result: TResult | null = null;
  const runners: Array<Promise<void>> = [];

  const runNext = async (): Promise<void> => {
    if (resolved) return;
    const myIndex = index++;
    if (myIndex >= inputs.length) return;
    const input = inputs[myIndex];
    const out = await worker(input).catch(() => null);
    if (!resolved && out !== null) {
      resolved = true;
      result = out;
      return;
    }
    if (!resolved) {
      await runNext();
    }
  };

  for (let i = 0; i < Math.max(1, Math.min(concurrency, inputs.length)); i++) {
    runners.push(runNext());
  }
  await Promise.all(runners);
  return result;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function escapeHtmlAttribute(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function wrapAsHtmlDocument(article: ReadabilityArticle): string {
  const safeTitle = escapeHtmlAttribute(article.title ?? "");
  // content is already sanitized/cleaned by Readability; we still serve as text/html
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${safeTitle}</title><style>body{margin:2rem auto;max-width:800px;line-height:1.6;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;padding:0 1rem} img,video,iframe{max-width:100%;height:auto} pre,code{white-space:pre-wrap;word-wrap:break-word}</style></head><body><article>${article.content}</article></body></html>`;
}

function isCloudflareChallenge(html: string): boolean {
  // Heuristics for Cloudflare interstitial/challenge pages
  const signals: ReadonlyArray<RegExp> = [
    /cdn-cgi\/challenge-platform\//i,
    /\bcf-chl-\w+/i,
    /\bcRay\b/i,
    /Just a moment\.\.\./i,
    /Attention Required!\s*\|\s*Cloudflare/i,
    /DDoS protection by Cloudflare/i,
    /enable (JavaScript|cookies) and try again/i,
    /Rocket Loader is loading your page/i,
    /\/cdn-cgi\/l\/chk_jschl/i,
  ];
  const text = html.slice(0, 200_000);
  return signals.some((re) => re.test(text));
}

async function firstNonNull<T>(
  promises: ReadonlyArray<Promise<T | null>>
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let remaining = promises.length;
    let resolved = false;
    for (const p of promises) {
      p.then((val) => {
        if (!resolved && val !== null) {
          resolved = true;
          resolve(val);
        }
      })
        .catch(() => {
          // ignore
        })
        .finally(() => {
          remaining -= 1;
          if (remaining === 0 && !resolved) {
            resolve(null);
          }
        });
    }
  });
}

export const Route = createFileRoute("/api/ddg")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) {
          return new Response(
            'Missing "q" search param. Usage: /api/ddg?q=your+query',
            {
              status: 400,
              headers: { "content-type": "text/plain; charset=utf-8" },
            }
          );
        }

        let successes: Array<{ url: string; html: string }> = [];

        const browser = await puppeteer.launch(env.MYBROWSER);
        try {
          const page = await browser.newPage();
          const chosenUserAgent = pickRandom(USER_AGENT_LIST);
          const chosenLocale = pickRandom(LOCALES);
          const chosenTimezone = pickRandom(TIMEZONES);
          const chosenViewport = pickRandom(VIEWPORTS);

          // Try to look more like a regular browser to avoid bot checks
          await applyPageStealth(page, {
            userAgent: chosenUserAgent,
            locale: chosenLocale,
            timezone: chosenTimezone,
            viewport: chosenViewport,
          });
          await page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
          await page.setDefaultTimeout(OP_TIMEOUT_MS);

          const normalizedQuery = query.replace(/\+/g, " ");
          const searchUrl =
            "https://html.duckduckgo.com/html/?" +
            new URLSearchParams({ q: normalizedQuery }).toString();

          // Small random delay before navigation
          await sleep(randomInt(100, 400));
          await page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: NAV_TIMEOUT_MS,
            referer: "https://duckduckgo.com/",
          });
          const serpHtml = await withTimeout(
            page.content(),
            OP_TIMEOUT_MS,
            "serp_content"
          );
          console.log("serpHtml", serpHtml);
          // Prefer static DOM parsing over waiting for a selector to avoid timeouts
          // Collect multiple candidate result links (excluding obvious ads)
          const rawResults = (await withTimeout(
            page.evaluate(() => {
              function resolveHref(anchor: HTMLAnchorElement): string | null {
                return anchor.href || anchor.getAttribute("href") || null;
              }
              function isAd(anchor: HTMLAnchorElement): boolean {
                return anchor.closest(".result--ad") !== null;
              }
              const selectors: ReadonlyArray<string> = [
                "a.result__a",
                "a.result__url",
                "a.result__title",
                'a[rel="nofollow noopener"][href]',
              ];
              const seen = new Set<string>();
              const results: Array<{ href: string; isAd: boolean }> = [];
              for (const sel of selectors) {
                const anchors = Array.from(
                  document.querySelectorAll<HTMLAnchorElement>(sel)
                );
                for (const a of anchors) {
                  const href = resolveHref(a);
                  if (!href) continue;
                  if (seen.has(href)) continue;
                  seen.add(href);
                  results.push({ href, isAd: isAd(a) });
                }
              }
              return results;
            }),
            OP_TIMEOUT_MS,
            "serp_evaluate"
          )) as Array<{ href: string; isAd: boolean }>;

          const normalizeDuckHref = (inputHref: string): string => {
            let candidate = inputHref;
            if (candidate.startsWith("/")) {
              candidate = new URL(
                candidate,
                "https://html.duckduckgo.com"
              ).toString();
            }
            if (
              candidate.includes("duckduckgo.com/l/?") ||
              candidate.startsWith("/l/?")
            ) {
              const urlObj = new URL(candidate, "https://duckduckgo.com");
              const uddg = urlObj.searchParams.get("uddg");
              if (uddg) {
                try {
                  candidate = decodeURIComponent(uddg);
                } catch {
                  // leave as-is if decoding fails
                }
              }
            }
            return candidate;
          };
          console.log("rawResults", rawResults);
          const preferredCandidates: string[] = Array.from(
            new Set(
              rawResults
                .filter((r) => !r.isAd)
                .map((r) => normalizeDuckHref(r.href))
                .filter((href) => /^https?:\/\//i.test(href))
                .filter((href) => !/google\.com\/adsense\/domains/i.test(href))
            )
          );

          if (preferredCandidates.length === 0) {
            throw new Error("Failed to locate any non-ad search result links");
          }

          let html: string | null = null;
          let successUrl: string | null = null;
          {
            const candidateUrls = preferredCandidates.slice(0, 8);
            console.log(
              "[ddg] considering",
              candidateUrls.length,
              "candidates:",
              candidateUrls
            );

            let visitedCount = 0;
            let skippedCount = 0;
            let successCount = 0;

            const worker = async (
              candidateUrl: string
            ): Promise<string | null> => {
              const p = await browser.newPage();
              try {
                console.log("[ddg] visiting", candidateUrl);
                visitedCount += 1;
                await applyPageStealth(p, {
                  userAgent: chosenUserAgent,
                  locale: chosenLocale,
                  timezone: chosenTimezone,
                  viewport: chosenViewport,
                });
                await p.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
                await p.setDefaultTimeout(OP_TIMEOUT_MS);

                await sleep(randomInt(120, 500));
                await p.goto(candidateUrl, {
                  waitUntil: "domcontentloaded",
                  timeout: NAV_TIMEOUT_MS,
                  referer: searchUrl,
                });

                // Some pages perform an immediate client-side redirect after DOMContentLoaded.
                await Promise.race([
                  p
                    .waitForNavigation({
                      waitUntil: "domcontentloaded",
                      timeout: 1500,
                    })
                    .catch(() => null),
                  sleep(300),
                ]);

                const readContentWithRetry = async (
                  maxAttempts: number
                ): Promise<string> => {
                  let lastError: Error | null = null;
                  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    try {
                      return await withTimeout(
                        p.content(),
                        OP_TIMEOUT_MS,
                        `candidate_content_attempt_${attempt}`
                      );
                    } catch (e) {
                      const err = e as Error;
                      lastError = err;
                      if (
                        !err.message.includes("Execution context was destroyed")
                      ) {
                        throw err;
                      }
                      await sleep(300);
                    }
                  }
                  if (lastError) throw lastError;
                  return await withTimeout(
                    p.content(),
                    OP_TIMEOUT_MS,
                    "candidate_content_final"
                  );
                };

                const candidateHtml = await readContentWithRetry(3);

                // Skip pages that are likely Cloudflare challenges or parked/ads
                const looksLikeParkedOrAd =
                  candidateHtml.length < 400 ||
                  /adsense\/domains\/caf\.js/i.test(candidateHtml);
                if (
                  looksLikeParkedOrAd ||
                  isCloudflareChallenge(candidateHtml)
                ) {
                  skippedCount += 1;
                  console.log(
                    "[ddg] skipped",
                    candidateUrl,
                    looksLikeParkedOrAd
                      ? "parked_or_ad"
                      : "cloudflare_challenge"
                  );
                  return null;
                }

                // Server-side Readability using linkedom
                try {
                  const { document } = parseHTML(candidateHtml);
                  const base = document.createElement("base");
                  base.setAttribute("href", candidateUrl);
                  const head = document.querySelector("head");
                  if (head) head.insertBefore(base, head.firstChild);
                  const article = new Readability(
                    document as unknown as Document
                  ).parse();
                  if (article && article.content && article.title) {
                    if (!successUrl) successUrl = candidateUrl;
                    successCount += 1;
                    console.log("[ddg] success_readability", candidateUrl);
                    const wrapped = wrapAsHtmlDocument({
                      title: article.title,
                      content: article.content,
                      byline: article.byline ?? null,
                      length: article.length,
                      excerpt: article.excerpt,
                      siteName: article.siteName,
                    });
                    successes.push({ url: candidateUrl, html: wrapped });
                    return wrapped;
                  }
                  if (!successUrl) successUrl = candidateUrl;
                  successCount += 1;
                  console.log("[ddg] success_raw", candidateUrl);
                  successes.push({ url: candidateUrl, html: candidateHtml });
                  return candidateHtml;
                } catch {
                  if (!successUrl) successUrl = candidateUrl;
                  successCount += 1;
                  console.log("[ddg] success_raw_fallback", candidateUrl);
                  successes.push({ url: candidateUrl, html: candidateHtml });
                  return candidateHtml;
                }
              } catch (e) {
                skippedCount += 1;
                console.log(
                  "[ddg] error",
                  candidateUrl,
                  (e as Error).message ?? e
                );
                return null;
              } finally {
                try {
                  await withTimeout(p.close(), 2_000, "page_close");
                } catch {
                  // ignore
                }
              }
            };

            // Lower concurrency to look less bot-like
            const first = await firstNonNullWithConcurrency<string, string>(
              candidateUrls,
              worker,
              2
            );
            if (first) {
              html = first;
              console.log(
                "[ddg] first_success:",
                successUrl ?? "unknown",
                "visited=",
                visitedCount,
                "skipped=",
                skippedCount,
                "successes=",
                successCount
              );
            }
          }

          if (!html) {
            // Fall back to returning the SERP HTML so the caller can inspect
            // what was found; avoids returning an empty stub page from a parked domain
            html = serpHtml;
          }

          // Summarize with Gemini using multiple sources when available
          try {
            const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
            const model = "gemini-flash-lite-latest";

            // Build multi-source input (cap per source to keep token budget)
            const sourceTexts: Array<{ url: string; text: string }> = [];
            const perSourceLimit = 20_000; // chars per source
            const maxTotal = 120_000; // overall cap
            if (successes.length > 0) {
              for (const s of successes) {
                const { document } = parseHTML(s.html);
                const articleEl =
                  document.querySelector("article") ?? document.body;
                const title =
                  document.querySelector("title")?.textContent ?? "";
                const rawText = (
                  articleEl?.textContent ??
                  document.textContent ??
                  ""
                ).trim();
                if (!rawText) continue;
                const snippet =
                  `${title ? `Title: ${title}\n\n` : ""}${rawText}`.slice(
                    0,
                    perSourceLimit
                  );
                sourceTexts.push({ url: s.url, text: snippet });
              }
            } else {
              const { document } = parseHTML(html);
              const articleEl =
                document.querySelector("article") ?? document.body;
              const title = document.querySelector("title")?.textContent ?? "";
              const rawText = (
                articleEl?.textContent ??
                document.textContent ??
                ""
              ).trim();
              const snippet =
                `${title ? `Title: ${title}\n\n` : ""}${rawText}`.slice(
                  0,
                  perSourceLimit
                );
              sourceTexts.push({ url: successUrl ?? "unknown", text: snippet });
            }

            // Combine with overall cap
            let combined = "";
            const usedUrls: string[] = [];
            for (const s of sourceTexts) {
              const nextChunk = `\n\n[Source: ${s.url}]\n${s.text}`;
              if (combined.length + nextChunk.length > maxTotal) break;
              combined += nextChunk;
              usedUrls.push(s.url);
            }

            const nonStreaming = await ai.models.generateContent({
              model,
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text:
                        `Answer the user's query precisely using ONLY the provided content.\n\n` +
                        `User query: ${query}\n\n` +
                        "If the content includes pricing, list the concrete plans, prices, currencies, and billing periods clearly. If pricing is not present, say that pricing information could not be found in the provided content. Be concise and factual. Then provide 2-5 short bullet points with key supporting facts.\n\nSources: " +
                        usedUrls.map((u, i) => `(${i + 1}) ${u}`).join(", ") +
                        "\n\nContent:\n" +
                        combined,
                    },
                  ],
                },
              ],
            });
            const summary =
              typeof nonStreaming.text === "string"
                ? nonStreaming.text.trim()
                : "";
            if (summary.length > 0) {
              const sourcesBlock =
                successes.length > 0
                  ? `\n\nSources:\n` +
                    successes.map((s, i) => `${i + 1}. ${s.url}`).join("\n")
                  : successUrl
                    ? `\n\nSource: ${successUrl}`
                    : "";
              return new Response(summary + sourcesBlock, {
                headers: { "content-type": "text/plain; charset=utf-8" },
              });
            }
          } catch (e) {
            // Fall through to return HTML if summarization fails
            console.log(e);
          }

          return new Response(html, {
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          });
        } finally {
          try {
            // Report how many pages yielded usable content
            try {
              console.log("[ddg] total_success_pages", successes.length);
            } catch {
              // ignore logging errors
            }
            await withTimeout(browser.close(), 10000, "browser_close");
          } catch {
            // ignore
          }
        }
      },
    },
  },
});
