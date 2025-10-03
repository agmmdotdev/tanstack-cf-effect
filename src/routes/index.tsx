import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { useEffect, useState } from "react";
import {
  Chunk,
  Effect,
  Option,
  Stream,
  Console,
  Logger,
  LogLevel,
  Layer,
} from "effect";
import { NodeSdk, WebSdk } from "@effect/opentelemetry";
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";

export const Route = createFileRoute("/")({
  loader: () => getData(),
  component: Home,
});
const checkStatus = createServerFn()
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }) => {
    const a = await env.CHECKOUT_WORKFLOW.get(id);
    return await a.status();
  });
const getData = createServerFn().handler(async () => {
  // client.ts

  // create an Effect layer that initializes OpenTelemetry and exports spans to the console
  const NodeSdkLive = NodeSdk.layer(() => ({
    resource: { serviceName: "tanstack-start-example-basic-cloudflare" },
    spanProcessor: new SimpleSpanProcessor(new ConsoleSpanExporter()),
  }));
  const silentLogger = Logger.make((log) => Logger.none);
  const testLogger = Logger.replace(
    Logger.defaultLogger,
    Logger.withConsoleLog(silentLogger)
  );
  const WebSdkLive = WebSdk.layer(() => ({
    resource: { serviceName: "tanstack-start-example-basic-cloudflare" },
    spanProcessor: new SimpleSpanProcessor(new ConsoleSpanExporter()),
  }));
  // run program with tracing enabled

  // Minimal in-memory user store implemented with Effect primitives

  // Use the in-memory store
  class MyError extends Error {}
  const program = Effect.fn("hey this")(function* () {
    yield* Effect.annotateCurrentSpan("user_id", "123");
    yield* Effect.log("hello this is log");
    const a = yield* Effect.tryPromise(() => env.CHECKOUT_WORKFLOW.create());
    const id = yield* Effect.sync(() => a.id);
    return id;
  })().pipe(
    Effect.scoped,
    Effect.catchAll((e) => Effect.succeed({ error: e }))
  );
  const a = program.pipe(
    Effect.provide(Layer.mergeAll(WebSdkLive)),
    Effect.runPromise
  );
  const b = await a;

  if (typeof b === "string") {
    return b;
  }
  throw notFound();
});

function Home() {
  const data = Route.useLoaderData();
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    console.log(data);

    // Set up interval to check status every 2 seconds
    const interval = setInterval(async () => {
      if (data && typeof data === "string") {
        try {
          const currentStatus = await checkStatus({ data });
          setStatus(currentStatus.status);
          console.log("Status:", currentStatus);
        } catch (error) {
          console.error("Error checking status:", error);
        }
      }
    }, 2000);

    // Cleanup interval on component unmount or data change
    return () => clearInterval(interval);
  }, [data]);

  return (
    <div className="p-2">
      <h3>Welcome Home!!!</h3>
      {data && typeof data === "string" && (
        <div>
          <p>Workflow ID: {data}</p>
          {status !== null && <p>Status: {String(status)}</p>}
        </div>
      )}
    </div>
  );
}
