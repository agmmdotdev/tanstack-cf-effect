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
            "https://www.google.com/search?q=" +
            encodeURIComponent(query) +
            "&hl=en&gl=us&pws=0&nfpr=1";

          await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

          // Prefer result anchors that contain an <h3> (standard Google SERP results)
          await page.waitForSelector("div#search a:has(h3)", {
            timeout: 10000,
          });

          const firstResultHref = (await page.evaluate(() => {
            const anchor = document.querySelector<HTMLAnchorElement>(
              "div#search a:has(h3)"
            );
            return anchor?.getAttribute("href") ?? null;
          })) as string | null;

          if (!firstResultHref) {
            throw new Error("Failed to locate first search result link");
          }

          let targetUrl: string = firstResultHref;
          // Google often wraps results like /url?q=<target>&...
          if (firstResultHref.startsWith("/url?")) {
            const urlObj = new URL(firstResultHref, "https://www.google.com");
            const q = urlObj.searchParams.get("q");
            if (q) {
              targetUrl = q;
            } else {
              targetUrl = urlObj.toString();
            }
          } else if (firstResultHref.startsWith("/")) {
            targetUrl = new URL(
              firstResultHref,
              "https://www.google.com"
            ).toString();
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
