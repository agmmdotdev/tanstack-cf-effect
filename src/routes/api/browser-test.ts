import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";

export const Route = createFileRoute("/api/browser-test")({
  server: {
    handlers: {
      GET: async ({ request: _request }) => {
        const browser = await puppeteer.launch(env.MYBROWSER);
        try {
          const page = await browser.newPage();

          const query = "sora2 pricing";
          const searchUrl =
            "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);

          await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

          // DuckDuckGo HTML results anchors
          await page.waitForSelector("a.result__a", {
            timeout: 10000,
          });

          const firstResultHref = (await page.evaluate(() => {
            const anchor =
              document.querySelector<HTMLAnchorElement>("a.result__a");
            return anchor?.href ?? anchor?.getAttribute("href") ?? null;
          })) as string | null;

          if (!firstResultHref) {
            throw new Error("Failed to locate first search result link");
          }

          let targetUrl: string = firstResultHref;
          if (firstResultHref.startsWith("/")) {
            targetUrl = new URL(
              firstResultHref,
              "https://html.duckduckgo.com"
            ).toString();
          }
          // DuckDuckGo redirector links: /l/?uddg=<encoded-url>
          if (
            targetUrl.includes("duckduckgo.com/l/?") ||
            targetUrl.startsWith("/l/?")
          ) {
            const urlObj = new URL(targetUrl, "https://duckduckgo.com");
            const uddg = urlObj.searchParams.get("uddg");
            if (uddg) {
              try {
                targetUrl = decodeURIComponent(uddg);
              } catch {
                // leave as-is if decoding fails
              }
            }
          }

          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

          const html = await page.content();

          return new Response(html, {
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          });
        } finally {
          await browser.close();
        }
      },
    },
  },
});
