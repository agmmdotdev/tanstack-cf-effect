import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
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
  const program = Effect.fn("hey this")(function* (hello: string) {
    yield* Effect.annotateCurrentSpan("user_id", "123");
    yield* Effect.log("hello this is log");
    const a = yield* Effect.tryPromise(() => env.CHECKOUT_WORKFLOW.create());
    if (Math.random() > 0.5) {
      return yield* Effect.fail(new Error("hello this is error"));
    }
    // List users within a span
    return "hello world";
  })("hello world").pipe(
    Effect.scoped,
    Effect.catchAll((e) => Effect.logError(e))
  );

  const a = program.pipe(
    Effect.provide(Layer.mergeAll(WebSdkLive)),
    Effect.runPromise
  );
  const b = await a;

  return {
    message: `Running in ${navigator.userAgent}`,
    myVar: env.MY_VAR,
    result: b,
  };
});

function Home() {
  const data = Route.useLoaderData();

  return (
    <div className="p-2">
      <h3>Welcome Home!!!</h3>
      <p>{data.message}</p>
      <p>{data.myVar}</p>
      <p>{data.result?.toString()}</p>
    </div>
  );
}
