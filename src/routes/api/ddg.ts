import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { GoogleGenAI } from "@google/genai";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function random(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const Route = createFileRoute("/api/ddg")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const query = url.searchParams.get("q")?.trim();

        if (!query) {
          return new Response(
            'Missing "q" parameter. Usage: /api/ddg?q=your+query',
            {
              status: 400,
              headers: { "content-type": "text/plain; charset=utf-8" },
            }
          );
        }

        let browser;
        try {
          browser = await puppeteer.launch(env.MYBROWSER);
          const page = await browser.newPage();

          // Basic anti-bot setup
          const userAgent = USER_AGENTS[random(0, USER_AGENTS.length - 1)];
          await page.setUserAgent(userAgent);
          await page.setViewport({ width: 1920, height: 1080 });

          // Hide automation indicators
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, "webdriver", {
              get: () => undefined,
            });
            (window as Window & { chrome?: Record<string, unknown> }).chrome = {
              runtime: {},
            };
          });

          // Set realistic headers
          await page.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          });

          // Small random delay before navigation
          await sleep(random(200, 500));

          // Search DuckDuckGo
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
          await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

          // Extract search result links
          const links = await page.evaluate(() => {
            const results: string[] = [];
            document
              .querySelectorAll<HTMLAnchorElement>("a.result__a")
              .forEach((a) => {
                const href = a.href;
                if (
                  href &&
                  href.startsWith("http") &&
                  !href.includes("duckduckgo.com")
                ) {
                  results.push(href);
                }
              });
            return results;
          });

          if (links.length === 0) {
            return new Response("No search results found", {
              status: 404,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }

          // Human-like delay after viewing search results
          await sleep(random(300, 800));

          // Fetch and parse first result
          const firstLink = links[0];
          await page.goto(firstLink, { waitUntil: "domcontentloaded" });

          // Simulate reading time
          await sleep(random(500, 1000));
          const html = await page.content();

          // Extract article content
          const { document } = parseHTML(html);
          const article = new Readability(
            document as unknown as Document
          ).parse();

          // Summarize with AI
          const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
          const content = article?.textContent || document.textContent || "";
          const summary = await ai.models.generateContent({
            model: "gemini-flash-lite-latest",
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: `Answer this query concisely: ${query}\n\nBased on:\n${content.slice(0, 30000)}`,
                  },
                ],
              },
            ],
          });

          const result = {
            answer: summary.text?.trim() || "No summary available",
            source: firstLink,
            title: article?.title || "Untitled",
          };

          return new Response(JSON.stringify(result, null, 2), {
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        } catch (error) {
          return new Response(`Error: ${(error as Error).message}`, {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        } finally {
          if (browser) {
            await browser.close();
          }
        }
      },
    },
  },
});
