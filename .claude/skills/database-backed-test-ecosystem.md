# Building a Database-Backed Test Ecosystem

How to build a test suite where each test creates the data it needs in a real
database, calls the real code path through the real entry point, and asserts on the
real result — fast enough to run on every save.

The reference implementation is Vitest + Postgres + Prisma + fishery, but the design
is portable. Every section states the property first and the mechanism second.

---

## 0. The thesis

The dominant style of "unit testing" in application code is:

```ts
const mockRepo = { findUser: vi.fn().mockResolvedValue({ id: 1, name: "Test" }) };
const service = new UserService(mockRepo);
expect(await service.getUser(1)).toEqual({ id: 1, name: "Test" });
```

This test passes forever. It passes when the column is renamed, when the unique
constraint is violated, when the query has an N+1, when the `where` clause forgets the
tenant filter, when the migration was never applied, and when the endpoint returns 500
because the serializer is wrong. It asserts that `vi.fn()` returns what you told it to
return.

The alternative is not "integration tests are slow, write fewer tests." It is:

> **A test should perform the same operations the production code performs, against
> the same infrastructure, and assert on the same observable outcome — differing only
> in that it supplies its own inputs.**

Concretely, every test in this style has the same four-beat shape:

```
1. ARRANGE   Create real rows in a real database, via factories
2. ACT       Call the real function / real endpoint through the real entry point
3. ASSERT    On the returned value
4. VERIFY    By reading the database back — did the side effect actually happen?
```

Step 4 is what most test suites are missing, and it is where the bugs are.

The cost of this style is a database in CI and some infrastructure work. The payoff:
a green suite is meaningful evidence that the system works.

---

## 1. Infrastructure: a real, disposable database

### A separate database, selected by environment file

Never share a database with development. Keep a dedicated one, addressed by a
committed env file (with fake secrets only):

```ini
# .env.test
APP_ENV=test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/app_test"
REDIS_URL="localhost:6379"
SESSION_SECRET="test-secret-not-real"
S3_ENDPOINT=http://localhost:4566        # localstack
```

```jsonc
{
  "scripts": {
    "test":         "dotenv -e .env.test -- vitest",
    "test:migrate": "dotenv -e .env.test -- prisma migrate reset --skip-seed"
  }
}
```

```ts
// test/setup-test-env.ts  (first entry in setupFiles)
import { config } from "dotenv";
config({ path: ".env.test" });
```

Two properties worth naming: **the test database is created by running the real
migrations**, so the suite validates the migration chain as a side effect; and it is
**never seeded**, so every test is responsible for its own data — no test can depend
on an invisible fixture.

Everything else runs in Docker, one command:

```yaml
services:
  postgres:  { image: postgres:16, ports: ["5432:5432"], environment: [POSTGRES_PASSWORD=postgres] }
  redis:     { image: redis:7-alpine, ports: ["6379:6379"] }
  localstack:{ image: localstack/localstack, ports: ["4566:4566"] }   # S3 and friends
```

Prefer a real fake (localstack, a Redis container, a mail catcher) over a mock for any
dependency that has one. Reserve mocking for third-party SaaS that has no local
equivalent (§6).

### Serialise execution — the database is shared state

```ts
// vitest.config.ts
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    setupFiles: [
      "./test/setup-test-env.ts",       // env first
      "./test/db-truncation-timing.ts", // instrumentation
      "./test/global-mocks.ts",         // third-party SDK stubs
    ],
    poolOptions: { forks: { singleFork: true } },   // ← one process, no DB races
    mockReset: true,
  },
});
```

`singleFork` is the pragmatic choice: one shared database, one process, no
cross-worker truncation races. It costs wall-clock time, and there is a well-known
escape hatch when you outgrow it — **one schema (or one database) per worker**, with
`DATABASE_URL` suffixed by `process.env.VITEST_POOL_ID`, migrations applied per schema
in `globalSetup`. Do that when suite time actually hurts, not before; the complexity is
real and `singleFork` plus targeted truncation (§3) gets you a long way.

> **Portability.** pytest: `--dist loadfile` with per-worker databases, or the
> `pytest-django --reuse-db` model. Go: `t.Parallel()` off by default plus
> testcontainers. Rails: `parallelize` already does per-worker databases and is the
> reference implementation of this idea.

---

## 2. Factories: the data-arrangement language

Factories are the reason this style is affordable. Without them, "arrange" is fifty
lines of nested `create` calls and nobody writes the test.

### What a factory must do

1. **Produce a valid, persisted row from zero arguments.** `await userFactory.create()`
   must work. Every required column gets a sensible default.
2. **Accept overrides for exactly what the test cares about.** The test states only what
   is relevant; everything else is noise the factory absorbs.
3. **Create required parents automatically** — but reuse a parent you hand it.
4. **Never collide** on unique columns, across any number of invocations.

Points 3 and 4 are where naive factories fall down, and they are worth building
carefully.

### The base: a generic factory library plus a persistence mixin

Start from a builder library ([fishery](https://github.com/thoughtbot/fishery), or
factory_boy / FactoryBot elsewhere) and add a thin subclass that knows about your ORM:

```ts
// test/factories/prisma-factory-mixin.ts
const PrismaFactoryMixin = <T, I, C>(
  model: any,
  dependentTables?: Array<string | (Factory<any, any, any> & { dependentTables: string[] })>
) =>
  class extends Factory<T, I, C> {
    // Flattened transitive list of tables this factory can touch — see §3.
    dependentTables: string[] = uniq(flattenDeep(
      (dependentTables ?? []).map((el) => (typeof el === "string" ? el : el.dependentTables))
    ));

    /**
     * Build a nested-write fragment for an association:
     *   - a transient object was passed  → connect to it
     *   - a foreign key was passed       → connect by id
     *   - neither                        → create one via that factory
     */
    buildAssc(
      fkId: number | null | undefined,
      transientObj: { id: number } | null | undefined,
      { skipCreate = false, transientParams }: { skipCreate?: boolean; transientParams?: any } = {}
    ) {
      if (transientObj) return { connect: { id: transientObj.id } };
      if (fkId)         return { connect: { id: fkId } };
      if (skipCreate)   return undefined;
      return { create: this.build({} as any, transientParams ? { transient: transientParams } : undefined) };
    }

    async create(params?: DeepPartial<T>, options: BuildOptions<T, I> = {}): Promise<C> {
      const builder = this.builder(params, options);

      // The library merges `params` over the generator's output by default. We disable
      // that: the generator has already consumed `params` and may deliberately have
      // dropped keys (e.g. turning `ownerId` into a nested `connect`). Re-merging would
      // resurrect a raw FK next to the relation and break the write.
      builder._mergeParamsOntoObject = (object: T) => object;

      const created = await model.create({ data: builder.build() });
      return builder._callAfterCreates(created);
    }
  };
```

Two details in there carry most of the weight.

**`buildAssc` — connect-or-create.** Association handling is where factory suites turn
into swamps. This one rule covers every case:

```ts
const projectFactory = ProjectFactory.define(({ params, transientParams }) => {
  const { ownerId, organizationId, ...rest } = params;   // strip raw FKs
  const output = { name: "Project", status: "draft", ...rest };

  output.owner        = userFactory.buildAssc(ownerId, transientParams.owner);
  output.organization = organizationFactory.buildAssc(organizationId, transientParams.organization);

  return output;
});
```

Now all four of these do the right thing, and a test says only what it means:

```ts
await projectFactory.create();                                    // owner + org created for you
await projectFactory.create({ ownerId: user.id });                // connect by FK
await projectFactory.create({}, { transient: { owner: user } });  // connect by object
await projectFactory.create({}, { transient: { organization } }); // one org, many projects
```

**Transient parameters are the key to shared ancestors.** The distinction: *params*
become columns; *transient params* are instructions to the factory that never reach
the database. That is exactly what you need to say "these three projects belong to the
same organization" — the most common shape in multi-tenant tests. Transient params
propagate down, too:

```ts
output.owner = userFactory.buildAssc(ownerId, transientParams.owner, {
  transientParams: { organization: transientParams.organization },  // ← same org all the way down
});
```

Without that propagation you get a project in org A owned by a user in org B, and your
authorization test passes for the wrong reason.

**Uniqueness via sequence.** The builder library gives every invocation a monotonic
counter; use it for every unique column:

```ts
const userFactory = UserFactory.define(({ sequence }) => ({
  email: `user-${sequence}@example.com`,
  externalId: `ext_${sequence}`,
}));
```

Use random data (faker) only where the value is genuinely irrelevant. Sequences are
deterministic, which makes failures reproducible; random emails produce the flaky test
that fails once a fortnight.

### Composite helpers for recurring shapes

When a scenario needs a whole object graph, put it behind one function rather than
repeating twenty lines:

```ts
export async function setupProjectWithTasks(args: {
  organization: DB.Organization;
  tasks: { title: string; status?: string }[];
}) {
  const project = await projectFactory.create({}, { transient: { organization: args.organization } });
  const tasks = await Promise.all(
    args.tasks.map((t, i) => taskFactory.create({ ...t, position: i }, { transient: { project } }))
  );
  return { project, tasks };
}
```

The rule of thumb: a helper should describe **a domain scenario** ("a published form
with two pages and a signature field"), not **a sequence of inserts**. If reading the
helper name does not tell you what state the world is in, it is the wrong abstraction.

---

## 3. Isolation: truncation driven by declared dependencies

Tests need a known starting state. Three strategies, in ascending order of how much you
have to think:

| Strategy | Speed | Catch |
|---|---|---|
| Transaction per test, rolled back | fastest | Breaks if the code under test uses transactions itself, or spans connections |
| Truncate everything before each test | simple | Cost grows with table count — hundreds of tables makes this slow |
| **Truncate only the tables involved** | fast, scales | Needs to know which tables are involved |

The third is the interesting one, and it is solvable by making each factory *declare*
its dependencies:

```ts
const TaskFactory = PrismaFactoryMixin<any, TransientTask, DB.Task>(
  db.task,
  ["tasks", projectFactory, userFactory, organizationFactory]   // ← declared, transitive
);
```

The mixin flattens that list transitively at construction time, so each factory knows
the full set of tables it can possibly touch. A test then names the *factories* it
uses and the table set is inferred:

```ts
describe("createTask", () => {
  beforeAll(() => truncateDbByFactories(taskFactory, tagFactory));
  // ...
});
```

```ts
export async function truncateDbByFactories(
  ...tables: Array<string | (Factory<any, any, any> & { dependentTables: string[] })>
) {
  const tableNames = uniq(flattenDeep(
    tables.map((el) => (typeof el === "string" ? el : el.dependentTables))
  ));
  return tableNames.length ? truncateDB(tableNames) : truncateDB();
}

export async function truncateDB(tables?: string[]) {
  // Load-bearing guard: this function drops data. It must be impossible to point it
  // at production, whatever a misconfigured CI job does with DATABASE_URL.
  if (!["test", "development"].includes(process.env.NODE_ENV!)) {
    throw new Error(`truncateDB is only allowed in test/development, got: ${process.env.NODE_ENV}`);
  }

  const tableNames = tables ?? (
    await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  ).filter(({ tablename }) => tablename !== "_prisma_migrations")
   .map(({ tablename }) => tablename);

  const start = Date.now();
  await prisma.$transaction(
    tableNames.map((t) =>
      prisma.$queryRawUnsafe(`TRUNCATE TABLE "public"."${t}" RESTART IDENTITY CASCADE;`))
  );
  totalTruncateTime += Date.now() - start;
}
```

Details that matter:

- **`RESTART IDENTITY`** resets sequences, so ids are stable across runs. Without it,
  ids drift and any test that accidentally depends on them becomes order-dependent.
- **`CASCADE`** handles FK order for you, so you do not maintain a topological sort.
- **One transaction** for all truncates: one round trip, and no window where the
  database is half-empty.
- **Never truncate the migrations table.**
- **`beforeAll` versus `beforeEach`.** `beforeAll` is much faster and is correct when
  tests in the file create their own scoped data (their own organization, their own
  project) and assert only within that scope. Use `beforeEach` when a test asserts on
  global counts (`expect(rows).toHaveLength(2)` across the whole table). Prefer writing
  tests that are scope-safe — it is the property that keeps the suite fast.

### Measure the cost

```ts
// test/db-truncation-timing.ts
afterAll(() => {
  if (!process.env.CI) console.log(`Total db truncation time: ${getTotalTruncateTime()}ms`);
});
```

A single number, printed after every local run. It turns "the tests feel slow" into
"truncation is 40% of the suite, and it is this file," which is the difference between
a complaint and a fix. Instrument the thing you expect to become the bottleneck before
it does.

---

## 4. Testing through the real entry point

This is the highest-value technique in the document.

### The problem

Endpoint tests usually pick one of two bad options:

- **Call the handler function directly.** Fast, but skips routing, request decoding,
  auth middleware, response encoding, status-code mapping, and error serialisation —
  which is where a large share of endpoint bugs live.
- **Boot a server and make real HTTP calls.** Realistic, but you now manage ports,
  startup and teardown, flakiness, and a separate process that cannot share the test
  transaction or be debugged with a breakpoint.

### The solution: substitute the transport, keep everything else

If the application exposes a `(Request) => Promise<Response>` handler — the Web
Fetch-style interface that most modern frameworks now build on — the whole server can
run *inside the test process*, and the client can be pointed at it by replacing the
`fetch` implementation:

```ts
export const withApi = <A, E, R>(auth: { account?: DB.Account; user?: DB.User }) =>
  (effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      // Mint a real session cookie using the application's own session code.
      const cookie = yield* Effect.tryPromise(() => createCookie(auth));

      const client = yield* HttpApiClient.make(Api, {
        baseUrl: "http://localhost",
        transformClient: (c) =>
          c.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("Cookie", cookie))),
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        // ── the whole trick ──────────────────────────────────────────
        Effect.provideService(FetchHttpClient.Fetch, async (...args) =>
          handler(new Request(...args))     // the app's real web handler, in-process
        )
      );

      return yield* effect.pipe(
        Effect.scoped,
        Effect.provideService(ApiClient, client),
        Effect.provide(Db.Live),
        Effect.provide(Redis.Live),
        Effect.provide(Models.Live)
      );
    });

const createCookie = async ({ account, user }: { account?: DB.Account; user?: DB.User }) => {
  const session = await sessionStorage.getSession();
  if (user)    session.set("user", { userId: user.id });
  if (account) session.set("account", { id: account.id });
  return sessionStorage.commitSession(session);   // real signing, real format
};
```

What a test now exercises, for real:

| Layer | Real? |
|---|---|
| URL construction and routing | ✅ |
| Query-string encoding and decoding | ✅ |
| Request body serialisation and schema decoding | ✅ |
| Auth middleware, cookie parsing, session decoding | ✅ |
| Authorization rules | ✅ |
| Handler logic | ✅ |
| Database queries, constraints, triggers | ✅ |
| Response encoding and status-code mapping | ✅ |
| Error serialisation and round-tripping | ✅ |
| Client-side response decoding | ✅ |
| TCP sockets, port binding | ❌ — the only thing removed |

And because the client is derived from the same contract as the server (see the
[type-safety guide](./end-to-end-type-safety.md)), **the test is fully type-checked**.
Rename a payload field and the test stops compiling; you find out at `tsc`, not on a
red CI run.

The auth detail is worth calling out separately: the test does not mock authentication,
it **constructs a genuine session cookie with the application's own session
serialiser**. Which means the auth middleware, the cookie signature, the session schema
decode, and the user lookup are all under test. A refactor that breaks session
encoding fails these tests immediately — the exact class of bug that `vi.mock("auth")`
guarantees you will ship.

> **Portability.** Express/Koa/Fastify: `supertest(app)` does the same thing (no port
> binding, real middleware). Next.js / Remix / Hono / any Fetch-based framework: call
> the exported handler with a `Request`. Django: `django.test.Client`. Rails:
> `ActionDispatch::IntegrationTest`. FastAPI: `TestClient` (httpx ASGI transport).
> Spring: `MockMvc`. Every mature ecosystem has this; the trick is remembering it
> exists and using it as the *default* for endpoint tests rather than the exception.

---

## 5. What a test actually looks like

### The shape

```ts
describe("Create project endpoint", () => {
  it.effect("creates a project owned by the current account", () =>
    Effect.gen(function* () {
      // ── 1. ARRANGE ────────────────────────────────────────────────
      const organization = yield* Factory.organization.create({ name: "Acme" });
      const account = yield* Factory.account.create({}, { transient: { organization } });
      const user    = yield* Factory.user.create();

      yield* Effect.gen(function* () {
        const db = yield* Db;
        const client = yield* ApiClient;

        // ── 2. ACT ──────────────────────────────────────────────────
        const result = yield* client.projects.create({
          payload: { name: "New Project" },
        });

        // ── 3. ASSERT on the response ───────────────────────────────
        expect(result).toMatchObject({ name: "New Project", status: "draft" });

        // ── 4. VERIFY in the database ───────────────────────────────
        const persisted = yield* db.use((_) =>
          _.project.findFirst({ where: { uid: result.uid } })
        );
        if (!persisted) expect.unreachable();

        expect(persisted).toMatchObject({
          organizationId: organization.id,
          status: "draft",
        });
      }).pipe(withApi({ account, user }));
    })
  );
});
```

Notes on the shape:

- **Arrange happens outside the API scope, act and assert inside it.** The nesting
  makes the authenticated region syntactically obvious, and the auth context is
  constructed from the same rows the assertions reference.
- **Step 4 is not optional.** The response is the handler's claim about what it did;
  the database is what it actually did. Endpoints that return the right JSON while
  writing the wrong row are common, and only step 4 catches them.
- **`expect.unreachable()`** narrows the type and fails loudly, instead of `!` (which
  produces a confusing null-dereference three lines later).
- **`toMatchObject`, not `toEqual`.** Assert on what the test is about. `toEqual`
  against a full row means every future column addition breaks unrelated tests.

### Asserting on typed failures

Since errors are typed values rather than thrown exceptions, invert the channel and
assert on the error as a value:

```ts
it.effect("rejects when the org is not on a plan that allows projects", () =>
  Effect.gen(function* () {
    const organization = yield* Factory.organization.create({ plan: "free" });
    const account = yield* Factory.account.create({}, { transient: { organization } });
    const user    = yield* Factory.user.create();

    yield* Effect.gen(function* () {
      const client = yield* ApiClient;

      const error = yield* client.projects
        .create({ payload: { name: "New Project" } })
        .pipe(Effect.flip);       // ← swap channels: failure becomes success

      expect(error).toBeInstanceOf(QuotaExceeded);
      expect(error.limit).toBe(3);
    }).pipe(withApi({ account, user }));
  })
);
```

`Effect.flip` is much better than `expect(...).rejects.toThrow(/quota/)`: it asserts on
the *type* of the failure and its structured fields, it round-trips the error through
real HTTP serialisation and decoding, and it fails if the endpoint succeeds. Testing
error messages with regexes is how you end up with tests that break on copy edits and
pass on wrong behaviour.

Without Effect, the same discipline: return a discriminated result and assert
`expect(result).toEqual({ ok: false, error: { _tag: "QuotaExceeded", limit: 3 } })`.

### Testing what a list endpoint must *not* return

Multi-tenant leaks are the highest-severity bug class in most SaaS applications, and
they are trivially testable — create the negative case explicitly:

```ts
it.effect("returns only projects in the caller's organization", () =>
  Effect.gen(function* () {
    const organization = yield* Factory.organization.create();
    const account = yield* Factory.account.create({}, { transient: { organization } });
    const user    = yield* Factory.user.create();

    yield* Factory.project.create({ name: "Mine 1" }, { transient: { organization } });
    yield* Factory.project.create({ name: "Mine 2" }, { transient: { organization } });
    yield* Factory.project.create({ name: "Someone else's" });   // ← different org

    yield* Effect.gen(function* () {
      const client = yield* ApiClient;
      const result = yield* client.projects.list({ urlParams: { page: 1, per_page: 10 } });

      expect(result.data).toHaveLength(2);
      expect(result.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Mine 1" }),
        expect.objectContaining({ name: "Mine 2" }),
      ]));
      expect(result.total).toBe(2);
      expect(result.total_pages).toBe(1);
    }).pipe(withApi({ account, user }));
  })
);
```

The third factory call is the entire point of the test. **A list-endpoint test without
an out-of-scope row is not testing the filter.** Make it a review rule.

Pagination deserves the same treatment: request `per_page: 1` with two rows present and
assert *which* row came back, not just that one did — that catches missing or unstable
`ORDER BY`, which is otherwise found in production when a customer reports a row
appearing on two pages.

### Testing transactional behaviour

Rollback semantics are worth explicit tests, because they are load-bearing and silently
breakable:

```ts
it.effect("rolls back the whole unit of work on failure", () =>
  Effect.gen(function* () {
    const db = yield* Db;

    const result = yield* db.withTransaction(
      Effect.gen(function* () {
        const db = yield* Db;   // shadowed: this is now the transaction client
        yield* db.use((_) => _.user.create({ data: { email: "a@example.com" } }));
        return yield* Effect.fail("boom");
      })
    ).pipe(Effect.either);

    expect(result).toEqual(Either.left("boom"));

    const users = yield* db.use((_) => _.user.findMany());
    expect(users).toHaveLength(0);          // ← the actual assertion
  }).pipe(Effect.provide(Db.Live))
);
```

---

## 6. Mock only what you cannot run

The rule: **mock at the process boundary, never inside your own code.**

| Dependency | Approach |
|---|---|
| Your database | Real |
| Your cache / queue | Real (container) |
| S3, SQS | Real fake (localstack) |
| Your own modules | **Never mock** |
| Third-party SaaS SDK | Stub the SDK, globally |
| Third-party HTTP API | Intercept at the HTTP layer (MSW / VCR) |
| Clock | Freeze it |

Stub external SDKs once, in a global setup file, so no individual test has to remember:

```ts
// test/global-mocks.ts
vi.mock("@some-vendor/node", () => {
  const Vendor = vi.fn(() => ({
    users: { sendInvitation: vi.fn(), revokeInvitation: vi.fn() },
  }));
  return { Vendor };
});
```

Prefer intercepting HTTP (MSW) over mocking a client library where you can: it tests
your request construction and your response parsing, which are the parts you actually
wrote and can actually get wrong.

**Feature flags** are the one legitimate case for per-file mocking, because they are a
control input rather than a dependency:

```ts
vi.mock("@/utils/feature-flags", () => ({ default: vi.fn() }));

describe("when the new pricing flow is enabled", () => {
  beforeEach(() => {
    vi.mocked(featureFlags).mockReturnValue({ NEW_PRICING: true } as any);
  });
  // ...
});
```

Set `mockReset: true` in the Vitest config so stubs cannot leak between files. Leaked
mock state produces order-dependent failures, which are the most expensive kind of
flake to diagnose.

---

## 7. Keeping the suite honest as it grows

**Test the test infrastructure.** A factory that silently produces invalid rows
poisons every test that uses it. One cheap test that exercises every factory catches
this immediately:

```ts
// test/factories.test.ts
import * as factories from "./factories";

describe("factories", () => {
  beforeEach(() => truncateDB());
  for (const [name, factory] of Object.entries(factories)) {
    it(`${name} creates a valid record`, async () => {
      await expect(factory.create()).resolves.toBeTruthy();
    });
  }
});
```

**Colocate tests with the code they test.** `handlers/projects.create.server.ts` beside
`tests/projects.create.test.ts` under the same resource folder. One file per endpoint
or per unit, named after it. This makes coverage gaps visible by directory listing —
a folder with five handlers and two test files is a legible problem.

**Snapshot the API contract** and diff it in CI (see the type-safety guide, §7). It is
not a test of behaviour; it is a test that behaviour did not change *unannounced*,
which is the property consumers depend on.

**Write scope-safe tests.** A test that scopes its assertions to data it created can
run with `beforeAll` truncation and survive parallelisation later. A test that asserts
on global table counts forces `beforeEach` on every neighbour and blocks the escape
hatch in §1. This is a small discipline with a large compounding payoff.

---

## 8. Honest costs

- **You need infrastructure to run tests.** New contributors need Docker up before
  anything passes. Mitigate with one `pnpm setup` command and a clear README error
  when the database is unreachable.
- **CI needs service containers.** Well supported everywhere now, but it is
  configuration to maintain and a cache to warm.
- **The suite is slower than a mock suite.** Milliseconds-per-test rather than
  microseconds. In exchange, a green run is evidence rather than decoration.
- **Truncation cost grows with the schema.** This is the thing that will eventually
  bite you, which is exactly why §3 instruments it from day one.
- **Factories need maintenance.** A new required column means updating one factory —
  a genuinely small tax, and one the factory test in §7 will point at immediately.

None of these are reasons to mock your database. They are the running costs of a test
suite that can actually fail when the code is wrong.

---

## Checklist

**Infrastructure**
- [ ] Dedicated test database, addressed by a committed `.env.test`
- [ ] Schema created by running real migrations; never seeded
- [ ] All infra dependencies in Docker; one command to start
- [ ] Execution serialised (or one database per worker)
- [ ] `mockReset` on

**Factories**
- [ ] `factory.create()` with no arguments produces a valid row
- [ ] Unique columns use a sequence, not randomness
- [ ] Associations are connect-or-create through one shared helper
- [ ] Transient params attach shared ancestors and propagate down the graph
- [ ] Composite helpers describe domain scenarios, not insert sequences
- [ ] A test asserts every factory can create

**Isolation**
- [ ] Factories declare their dependent tables; truncation is inferred from factories
- [ ] Truncation guarded by an environment check
- [ ] `TRUNCATE ... RESTART IDENTITY CASCADE` in a single transaction
- [ ] Truncation time instrumented and printed

**Tests**
- [ ] Endpoint tests go through the real handler with a substituted transport
- [ ] Auth uses a genuine session/token minted by the application's own code
- [ ] Every test arranges, acts, asserts on the response, **and verifies in the database**
- [ ] Failure cases assert on the typed error value, not a message regex
- [ ] Every list test includes an out-of-scope row
- [ ] Pagination tests assert *which* rows, not just how many
- [ ] Mocks exist only at process boundaries
- [ ] Tests are colocated with the code they test, one file per unit

---

## See also

- [`end-to-end-type-safety.md`](./end-to-end-type-safety.md) — the contract that makes these tests type-checked
- [`extending-the-orm-layer.md`](./extending-the-orm-layer.md) — the database layer under test
