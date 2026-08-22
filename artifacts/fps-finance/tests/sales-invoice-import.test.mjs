import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import {
  FpsConnectSalesInvoiceAdapter,
  FpsOnePlatformSalesInvoiceAdapter,
  MemoryFinanceRepository,
} from "../dist/invoice-import.mjs";

const reporter = { capture() {} };

async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

async function startJsonServer(payloadRef) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({
      authorization: req.headers.authorization,
      url: req.url,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payloadRef.current));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    requests,
    url: `http://127.0.0.1:${address.port}/sales-invoices`,
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

test("both source contracts import beside each other with isolated identity, versions and cursors", async (t) => {
  const connectPayload = {
    current: await fixture("fps-connect-sales-invoices.json"),
  };
  const onePayload = {
    current: await fixture("fps-one-platform-sales-invoices.json"),
  };
  const connectServer = await startJsonServer(connectPayload);
  const oneServer = await startJsonServer(onePayload);
  t.after(async () => {
    await Promise.all([
      closeServer(connectServer.server),
      closeServer(oneServer.server),
    ]);
  });

  const repository = new MemoryFinanceRepository();
  repository.seedLocalAdministration("fps-bouw", "FPS Bouw", "FPS Bouw");
  repository.seedLocalAdministration(
    "fps-software-bv",
    "FPS Software B.V.",
    "FPS Software",
  );
  const connect = new FpsConnectSalesInvoiceAdapter({
    endpointUrl: connectServer.url,
    token: "connect-contract-token",
    administrationMap: {
      "connect-fps-bouw": "fps-bouw",
    },
  }, reporter);
  const one = new FpsOnePlatformSalesInvoiceAdapter({
    endpointUrl: oneServer.url,
    token: "one-contract-token",
    administrationId: "fps-software-bv",
  }, reporter);

  const [connectFirst, oneFirst] = await Promise.all([
    connect.run(repository),
    one.run(repository),
  ]);
  assert.equal(connectFirst.state, "healthy");
  assert.equal(connectFirst.changed, 2);
  assert.equal(oneFirst.state, "healthy");
  assert.equal(oneFirst.changed, 2);

  const imported = await repository.listSalesInvoices();
  assert.equal(imported.length, 4);
  const shared = imported.filter(
    (invoice) => invoice.sourceDocumentId === "shared-invoice-001",
  );
  assert.equal(shared.length, 2);
  assert.deepEqual(
    new Set(shared.map((invoice) => invoice.source)),
    new Set(["fps-connect", "fps-one-platform"]),
  );
  assert.equal(
    shared.find((invoice) => invoice.source === "fps-connect").administrationId,
    "fps-bouw",
  );
  assert.equal(
    shared.find((invoice) => invoice.source === "fps-connect").sourceAdministrationId,
    "connect-fps-bouw",
  );
  assert.equal(
    shared.find((invoice) => invoice.source === "fps-one-platform").administrationId,
    "fps-software-bv",
  );
  assert.equal(
    shared.find((invoice) => invoice.source === "fps-one-platform").sourceAdministrationId,
    null,
  );

  const [connectRepeated, oneRepeated] = await Promise.all([
    connect.run(repository),
    one.run(repository),
  ]);
  assert.equal(connectRepeated.changed, 0);
  assert.equal(connectRepeated.skipped, 2);
  assert.equal(oneRepeated.changed, 0);
  assert.equal(oneRepeated.skipped, 2);
  assert.match(connectServer.requests[1].url, /cursor=connect-cursor-/);
  assert.match(oneServer.requests[1].url, /cursor=one-cursor-/);
  assert.equal(
    connectServer.requests[0].authorization,
    "Bearer connect-contract-token",
  );
  assert.equal(oneServer.requests[0].authorization, "Bearer one-contract-token");

  connectPayload.current.items[0] = {
    ...connectPayload.current.items[0],
    version: "2026-08-20T12:00:00.000Z",
    state: "paid",
    amounts: {
      net: 1100,
      vat: 231,
      total: 1331,
    },
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
  const changed = await connect.run(repository);
  assert.equal(changed.changed, 1);
  assert.equal(changed.skipped, 1);
  const updated = (await repository.listSalesInvoices()).find(
    (invoice) =>
      invoice.source === "fps-connect"
      && invoice.sourceDocumentId === "shared-invoice-001",
  );
  assert.equal(updated.status, "paid");
  assert.equal(updated.totalAmount, 1331);

  await closeServer(oneServer.server);
  const oneFailure = await one.run(repository);
  assert.equal(oneFailure.state, "degraded");
  const connectAfterOneFailure = await connect.run(repository);
  assert.equal(connectAfterOneFailure.state, "healthy");
  const connectStatus = await repository.getSalesInvoiceImportStatus("fps-connect");
  const oneStatus = await repository.getSalesInvoiceImportStatus("fps-one-platform");
  assert.equal(connectStatus.state, "healthy");
  assert.equal(oneStatus.state, "degraded");
  assert.equal((await repository.listSalesInvoices()).length, 4);
});

test("missing source configuration fails explicitly and creates no example invoices", async () => {
  const repository = new MemoryFinanceRepository();
  repository.seedLocalAdministration(
    "fps-software-bv",
    "FPS Software B.V.",
    "FPS Software",
  );
  const adapter = new FpsOnePlatformSalesInvoiceAdapter({
    endpointUrl: undefined,
    token: undefined,
    administrationId: "fps-software-bv",
  }, reporter);

  const result = await adapter.run(repository);
  assert.equal(result.state, "degraded");
  assert.equal(result.configured, false);
  assert.match(result.message, /FINANCE_ONE_PLATFORM_INVOICE_URL/);
  assert.deepEqual(await repository.listSalesInvoices(), []);
});

test("repeated records across paginated source responses do not create duplicates", async (t) => {
  const contract = await fixture("fps-connect-sales-invoices.json");
  const sourceInvoice = contract.items[0];
  const seenCursors = [];
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const cursor = requestUrl.searchParams.get("cursor");
    seenCursors.push(cursor);
    const payload = cursor === "page-2"
      ? {
          items: [sourceInvoice],
          nextCursor: "complete",
          hasMore: false,
        }
      : {
          items: [sourceInvoice],
          nextCursor: "page-2",
          hasMore: true,
        };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => closeServer(server));
  const address = server.address();

  const repository = new MemoryFinanceRepository();
  repository.seedLocalAdministration("fps-bouw", "FPS Bouw", "FPS Bouw");
  const adapter = new FpsConnectSalesInvoiceAdapter({
    endpointUrl: `http://127.0.0.1:${address.port}/sales-invoices`,
    token: "pagination-token",
    administrationMap: {
      "connect-fps-bouw": "fps-bouw",
    },
  }, reporter);

  const result = await adapter.run(repository);
  assert.equal(result.state, "healthy");
  assert.equal(result.processed, 2);
  assert.equal(result.changed, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(seenCursors, [null, "page-2"]);
  assert.equal((await repository.listSalesInvoices()).length, 1);
});

test("over-precise or internally inconsistent source amounts are rejected", async (t) => {
  const contract = await fixture("fps-connect-sales-invoices.json");
  const cases = [
    {
      name: "more than two decimals",
      amounts: { net: 1000, vat: 210, total: 1210.001 },
      expected: /maximaal twee decimalen/,
    },
    {
      name: "net and VAT do not add up to total",
      amounts: { net: 1000, vat: 210, total: 1209.99 },
      expected: /tellen niet op/,
    },
  ];

  for (const invalidCase of cases) {
    await t.test(invalidCase.name, async (subtest) => {
      const payload = {
        current: {
          ...contract,
          items: [{
            ...contract.items[0],
            amounts: invalidCase.amounts,
          }],
        },
      };
      const source = await startJsonServer(payload);
      subtest.after(() => closeServer(source.server));
      const repository = new MemoryFinanceRepository();
      repository.seedLocalAdministration("fps-bouw", "FPS Bouw", "FPS Bouw");
      const adapter = new FpsConnectSalesInvoiceAdapter({
        endpointUrl: source.url,
        token: "invalid-contract-token",
        administrationMap: {
          "connect-fps-bouw": "fps-bouw",
        },
      }, reporter);

      const result = await adapter.run(repository);
      assert.equal(result.state, "degraded");
      assert.match(result.message, invalidCase.expected);
      assert.deepEqual(await repository.listSalesInvoices(), []);
    });
  }
});