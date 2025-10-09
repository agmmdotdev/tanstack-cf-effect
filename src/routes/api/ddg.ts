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

// Rotate realistic desktop user-agents with contact information for legitimate crawlers
const USER_AGENT_LIST: ReadonlyArray<string> = [
  // Safari on macOS with contact info
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15 (+https://example.com/bot; contact@example.com)",
  // Firefox on Windows with contact info
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0 (+https://example.com/bot; contact@example.com)",
  // Chrome on Windows with contact info
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.88 Safari/537.36 (+https://example.com/bot; contact@example.com)",
  // Chrome on macOS with contact info
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.88 Safari/537.36 (+https://example.com/bot; contact@example.com)",
  // Edge on Windows with contact info
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.88 Safari/537.36 Edg/127.0.2651.74 (+https://example.com/bot; contact@example.com)",
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

// Rate limiting with exponential backoff and jitter
class RateLimiter {
  private lastRequestTime = 0;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly baseDelay: number;

  constructor(minDelay = 1000, maxDelay = 10000, baseDelay = 1000) {
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.baseDelay = baseDelay;
  }

  async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    // Add jitter to avoid synchronized requests
    const jitter = randomInt(0, 500);
    const delay = Math.max(this.minDelay, this.baseDelay + jitter);

    if (timeSinceLastRequest < delay) {
      const waitTime = delay - timeSinceLastRequest;
      console.log(`[rate_limit] waiting ${waitTime}ms to respect rate limits`);
      await sleep(waitTime);
    }

    this.lastRequestTime = Date.now();
  }

  async backoff(attempt: number): Promise<void> {
    const exponentialDelay = Math.min(
      this.baseDelay * Math.pow(2, attempt),
      this.maxDelay
    );
    const jitter = randomInt(0, Math.floor(exponentialDelay * 0.1));
    const totalDelay = exponentialDelay + jitter;

    console.log(
      `[rate_limit] exponential backoff attempt ${attempt}, waiting ${totalDelay}ms`
    );
    await sleep(totalDelay);
  }
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
  // Enable cookie handling
  await page.setCookie({
    name: "__cf_bm",
    value: "dummy_cf_bm_value",
    domain: ".cloudflare.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  await page.setUserAgent(opts.userAgent);
  await page.setViewport(opts.viewport);
  await page.emulateTimezone(opts.timezone);
  await page.setExtraHTTPHeaders({
    "Accept-Language": buildAcceptLanguage(opts.locale),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Charset": "UTF-8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-Ch-Ua":
      '"Not)A;Brand";v="8", "Chromium";v="127", "Google Chrome";v="127"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Upgrade-Insecure-Requests": "1",
    DNT: "1",
  });
  // Enhanced stealth techniques to avoid headless browser detection
  await page.evaluateOnNewDocument(() => {
    try {
      // Remove webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // Override plugins to look more realistic
      Object.defineProperty(navigator, "plugins", {
        get: () => [
          {
            0: {
              type: "application/x-google-chrome-pdf",
              suffixes: "pdf",
              description: "Portable Document Format",
            },
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "Chrome PDF Plugin",
          },
          {
            0: { type: "application/pdf", suffixes: "pdf", description: "" },
            description: "",
            filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
            length: 1,
            name: "Chrome PDF Viewer",
          },
        ],
      });

      // Override languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });

      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({
              state: Notification.permission,
              name: "notifications",
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => false,
            } as PermissionStatus)
          : originalQuery(parameters);

      // Override chrome runtime
      // @ts-ignore
      (window as unknown as { chrome?: { runtime?: object } }).chrome = {
        runtime: {
          onConnect: undefined,
          onMessage: undefined,
        },
      };

      // Override getParameter to avoid WebGL fingerprinting
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 37445) {
          return "Intel Inc.";
        }
        if (parameter === 37446) {
          return "Intel(R) Iris(TM) Graphics 6100";
        }
        return getParameter(parameter);
      };

      // Override canvas fingerprinting
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function () {
        const context = this.getContext("2d");
        if (context) {
          const imageData = context.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] =
              imageData.data[i] + Math.floor(Math.random() * 10) - 5;
            imageData.data[i + 1] =
              imageData.data[i + 1] + Math.floor(Math.random() * 10) - 5;
            imageData.data[i + 2] =
              imageData.data[i + 2] + Math.floor(Math.random() * 10) - 5;
          }
          context.putImageData(imageData, 0, 0);
        }
        return originalToDataURL.call(this);
      };
    } catch (error) {
      console.warn("Stealth injection failed:", error);
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

// Check robots.txt before crawling
async function checkRobotsTxt(
  url: string,
  userAgent: string
): Promise<boolean> {
  try {
    const urlObj = new URL(url);
    const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;

    console.log(`[robots] checking ${robotsUrl}`);

    const response = await fetch(robotsUrl, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/plain",
      },
    });

    if (!response.ok) {
      console.log(
        `[robots] robots.txt not found or not accessible (${response.status})`
      );
      return true; // Allow crawling if robots.txt is not found
    }

    const robotsText = await response.text();
    const lines = robotsText.split("\n");

    let currentUserAgent = "";
    let disallowedPaths: string[] = [];
    let allowedPaths: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith("user-agent:")) {
        currentUserAgent = trimmed.substring(11).trim();
      } else if (trimmed.startsWith("disallow:")) {
        if (
          currentUserAgent === "*" ||
          currentUserAgent === userAgent.toLowerCase()
        ) {
          const path = trimmed.substring(9).trim();
          if (path) {
            disallowedPaths.push(path);
          }
        }
      } else if (trimmed.startsWith("allow:")) {
        if (
          currentUserAgent === "*" ||
          currentUserAgent === userAgent.toLowerCase()
        ) {
          const path = trimmed.substring(6).trim();
          if (path) {
            allowedPaths.push(path);
          }
        }
      }
    }

    // Check if the URL path is disallowed
    const urlPath = urlObj.pathname;
    for (const disallowedPath of disallowedPaths) {
      if (disallowedPath === "/" || urlPath.startsWith(disallowedPath)) {
        console.log(
          `[robots] disallowed by robots.txt: ${urlPath} matches ${disallowedPath}`
        );
        return false;
      }
    }

    console.log(`[robots] allowed to crawl ${urlPath}`);
    return true;
  } catch (error) {
    console.warn(`[robots] error checking robots.txt:`, error);
    return true; // Allow crawling if there's an error
  }
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

        // Initialize rate limiter for polite crawling
        const rateLimiter = new RateLimiter(1500, 8000, 1500);

        let browser;
        try {
          browser = await puppeteer.launch(env.MYBROWSER);
        } catch (e) {
          console.error(
            "[ddg] browser_launch_failed",
            (e as Error).message ?? e
          );
          return new Response(
            "Failed to launch browser: " + ((e as Error).message ?? String(e)),
            {
              status: 500,
              headers: { "content-type": "text/plain; charset=utf-8" },
            }
          );
        }

        try {
          let page;
          try {
            page = await browser.newPage();
          } catch (e) {
            console.error(
              "[ddg] page_creation_failed",
              (e as Error).message ?? e
            );
            throw new Error(
              "Failed to create new page: " +
                ((e as Error).message ?? String(e))
            );
          }

          const chosenUserAgent = pickRandom(USER_AGENT_LIST);
          const chosenLocale = pickRandom(LOCALES);
          const chosenTimezone = pickRandom(TIMEZONES);
          const chosenViewport = pickRandom(VIEWPORTS);

          // Try to look more like a regular browser to avoid bot checks
          try {
            await applyPageStealth(page, {
              userAgent: chosenUserAgent,
              locale: chosenLocale,
              timezone: chosenTimezone,
              viewport: chosenViewport,
            });
          } catch (e) {
            console.error(
              "[ddg] stealth_setup_failed",
              (e as Error).message ?? e
            );
            throw new Error(
              "Failed to apply stealth settings: " +
                ((e as Error).message ?? String(e))
            );
          }

          await page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
          await page.setDefaultTimeout(OP_TIMEOUT_MS);

          const normalizedQuery = query.replace(/\+/g, " ");
          const searchUrl =
            "https://html.duckduckgo.com/html/?" +
            new URLSearchParams({ q: normalizedQuery }).toString();

          // Respect rate limits before navigation
          await rateLimiter.waitIfNeeded();

          let serpHtml: string;
          try {
            await page.goto(searchUrl, {
              waitUntil: "domcontentloaded",
              timeout: NAV_TIMEOUT_MS,
              referer: "https://duckduckgo.com/",
            });
            serpHtml = await withTimeout(
              page.content(),
              OP_TIMEOUT_MS,
              "serp_content"
            );
            console.log(
              "[ddg] serp_loaded successfully",
              serpHtml.length,
              "chars"
            );
          } catch (e) {
            console.error(
              "[ddg] serp_navigation_failed",
              searchUrl,
              (e as Error).message ?? e
            );
            throw new Error(
              "Failed to load search results: " +
                ((e as Error).message ?? String(e))
            );
          }
          // Prefer static DOM parsing over waiting for a selector to avoid timeouts
          // Collect multiple candidate result links (excluding obvious ads)
          let rawResults: Array<{ href: string; isAd: boolean }>;
          try {
            rawResults = (await withTimeout(
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
            console.log(
              "[ddg] serp_evaluation_success",
              rawResults.length,
              "raw results found"
            );
          } catch (e) {
            console.error(
              "[ddg] serp_evaluation_failed",
              (e as Error).message ?? e
            );
            throw new Error(
              "Failed to extract search results: " +
                ((e as Error).message ?? String(e))
            );
          }

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
          console.log("[ddg] rawResults", rawResults.length, "total results");
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
            console.error(
              "[ddg] no_valid_candidates_found",
              "raw results:",
              rawResults.length
            );
            throw new Error("Failed to locate any non-ad search result links");
          }
          console.log(
            "[ddg] preferred_candidates_count",
            preferredCandidates.length
          );

          let html: string | null = null;
          let successUrl: string | null = null;
          {
            const candidateUrls = preferredCandidates.slice(0, 20);
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
              // Check robots.txt before crawling
              const isAllowed = await checkRobotsTxt(
                candidateUrl,
                chosenUserAgent
              );
              if (!isAllowed) {
                console.log("[ddg] skipping due to robots.txt", candidateUrl);
                skippedCount += 1;
                return null;
              }

              let p;
              try {
                p = await browser.newPage();
              } catch (e) {
                console.error(
                  "[ddg] candidate_page_creation_failed",
                  candidateUrl,
                  (e as Error).message ?? e
                );
                return null;
              }
              try {
                console.log("[ddg] visiting", candidateUrl);
                visitedCount += 1;

                try {
                  await applyPageStealth(p, {
                    userAgent: chosenUserAgent,
                    locale: chosenLocale,
                    timezone: chosenTimezone,
                    viewport: chosenViewport,
                  });
                } catch (e) {
                  console.error(
                    "[ddg] candidate_stealth_setup_failed",
                    candidateUrl,
                    (e as Error).message ?? e
                  );
                  throw e;
                }

                await p.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
                await p.setDefaultTimeout(OP_TIMEOUT_MS);

                // Respect rate limits before visiting each candidate
                await rateLimiter.waitIfNeeded();

                try {
                  const response = await p.goto(candidateUrl, {
                    waitUntil: "domcontentloaded",
                    timeout: NAV_TIMEOUT_MS,
                    referer: searchUrl,
                  });

                  // Check for rate limiting or blocking
                  if (response && response.status() >= 400) {
                    const status = response.status();
                    console.warn(`[ddg] HTTP ${status} for ${candidateUrl}`);

                    if (status === 429) {
                      // Rate limited - check for Retry-After header
                      const retryAfter = response.headers()["retry-after"];
                      if (retryAfter) {
                        const delay = parseInt(retryAfter) * 1000;
                        console.log(
                          `[ddg] rate limited, waiting ${delay}ms as per Retry-After header`
                        );
                        await sleep(delay);
                      } else {
                        await rateLimiter.backoff(1);
                      }
                      throw new Error(`Rate limited: HTTP ${status}`);
                    } else if (status === 403 || status === 503) {
                      console.log(
                        `[ddg] blocked or unavailable: HTTP ${status}`
                      );
                      throw new Error(`Blocked: HTTP ${status}`);
                    }
                  }
                } catch (e) {
                  console.error(
                    "[ddg] candidate_navigation_failed",
                    candidateUrl,
                    (e as Error).message ?? e
                  );
                  throw e;
                }

                // Some pages perform an immediate client-side redirect after DOMContentLoaded.
                await Promise.race([
                  p
                    .waitForNavigation({
                      waitUntil: "domcontentloaded",
                      timeout: 1500,
                    })
                    .catch((e) => {
                      console.log("[ddg] no_redirect_detected", candidateUrl);
                      return null;
                    }),
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
                        console.error(
                          "[ddg] content_read_failed",
                          candidateUrl,
                          "attempt:",
                          attempt,
                          err.message
                        );
                        throw err;
                      }
                      console.warn(
                        "[ddg] content_read_retry",
                        candidateUrl,
                        "attempt:",
                        attempt,
                        "context destroyed"
                      );
                      await sleep(300);
                    }
                  }
                  if (lastError) {
                    console.error(
                      "[ddg] content_read_all_attempts_failed",
                      candidateUrl,
                      lastError.message
                    );
                    throw lastError;
                  }
                  return await withTimeout(
                    p.content(),
                    OP_TIMEOUT_MS,
                    "candidate_content_final"
                  );
                };

                let candidateHtml: string;
                try {
                  candidateHtml = await readContentWithRetry(3);
                  console.log(
                    "[ddg] content_read_success",
                    candidateUrl,
                    "length:",
                    candidateHtml.length
                  );
                } catch (e) {
                  console.error(
                    "[ddg] content_read_final_failure",
                    candidateUrl,
                    (e as Error).message ?? e
                  );
                  throw e;
                }

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
                    console.log(
                      "[ddg] success_readability",
                      candidateUrl,
                      "content_length:",
                      article.content.length
                    );
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
                  console.log(
                    "[ddg] readability_no_article",
                    candidateUrl,
                    "falling back to raw HTML"
                  );
                  if (!successUrl) successUrl = candidateUrl;
                  successCount += 1;
                  console.log(
                    "[ddg] success_raw",
                    candidateUrl,
                    "html_length:",
                    candidateHtml.length
                  );
                  successes.push({ url: candidateUrl, html: candidateHtml });
                  return candidateHtml;
                } catch (e) {
                  console.warn(
                    "[ddg] readability_parse_error",
                    candidateUrl,
                    (e as Error).message ?? e,
                    "using raw HTML"
                  );
                  if (!successUrl) successUrl = candidateUrl;
                  successCount += 1;
                  console.log(
                    "[ddg] success_raw_fallback",
                    candidateUrl,
                    "html_length:",
                    candidateHtml.length
                  );
                  successes.push({ url: candidateUrl, html: candidateHtml });
                  return candidateHtml;
                }
              } catch (e) {
                skippedCount += 1;
                console.error(
                  "[ddg] candidate_worker_error",
                  candidateUrl,
                  (e as Error).message ?? e
                );
                return null;
              } finally {
                try {
                  await withTimeout(p.close(), 2_000, "page_close");
                } catch (e) {
                  console.warn(
                    "[ddg] candidate_page_close_error",
                    candidateUrl,
                    (e as Error).message ?? e
                  );
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
            } else {
              console.warn(
                "[ddg] no_successful_candidate",
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
            console.warn(
              "[ddg] falling_back_to_serp_html",
              "serp_length:",
              serpHtml.length
            );
            html = serpHtml;
          }

          // Summarize with Gemini using multiple sources when available
          try {
            console.log(
              "[ddg] starting_ai_summarization",
              "successes:",
              successes.length
            );
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
                if (!rawText) {
                  console.warn("[ddg] source_has_no_text", s.url);
                  continue;
                }
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

            console.log(
              "[ddg] ai_source_texts_prepared",
              sourceTexts.length,
              "sources"
            );

            // Combine with overall cap
            let combined = "";
            const usedUrls: string[] = [];
            for (const s of sourceTexts) {
              const nextChunk = `\n\n[Source: ${s.url}]\n${s.text}`;
              if (combined.length + nextChunk.length > maxTotal) break;
              combined += nextChunk;
              usedUrls.push(s.url);
            }

            console.log(
              "[ddg] ai_combined_input_size",
              combined.length,
              "chars",
              "urls:",
              usedUrls.length
            );

            const response = await ai.models.generateContent({
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

            const summary = (response.text ?? "").trim();
            console.log(
              "[ddg] ai_response_received",
              "summary_length:",
              summary.length
            );
            if (summary.length > 0) {
              const sourcesBlock =
                successes.length > 0
                  ? `\n\nSources:\n` +
                    successes.map((s, i) => `${i + 1}. ${s.url}`).join("\n")
                  : successUrl
                    ? `\n\nSource: ${successUrl}`
                    : "";
              console.log("[ddg] returning_ai_summary");
              return new Response(summary + sourcesBlock, {
                headers: { "content-type": "text/plain; charset=utf-8" },
              });
            } else {
              console.warn("[ddg] ai_returned_empty_summary");
            }
          } catch (e) {
            // Fall through to return HTML if summarization fails
            console.error(
              "[ddg] ai_summarization_failed",
              (e as Error).message ?? e,
              "stack:",
              (e as Error).stack
            );
          }

          console.log("[ddg] returning_html_response", "length:", html.length);
          return new Response(html, {
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          });
        } catch (e) {
          console.error(
            "[ddg] request_handler_error",
            (e as Error).message ?? e,
            "stack:",
            (e as Error).stack
          );
          return new Response(
            "Search failed: " + ((e as Error).message ?? String(e)),
            {
              status: 500,
              headers: { "content-type": "text/plain; charset=utf-8" },
            }
          );
        } finally {
          try {
            // Report how many pages yielded usable content
            console.log("[ddg] total_success_pages", successes.length);
            await withTimeout(browser.close(), 10000, "browser_close");
            console.log("[ddg] browser_closed_successfully");
          } catch (e) {
            console.error(
              "[ddg] browser_close_error",
              (e as Error).message ?? e
            );
          }
        }
      },
    },
  },
});
