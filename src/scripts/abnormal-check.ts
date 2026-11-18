/**
 * Abnormal trading tools end to end: the real MCP server (createMcpServer → SDK validation → safe() →
 * services → local database) over an in-memory transport, plus REST/HTTP when the server is running.
 * Synthetic data with a planted spike (volume ×30, AR +10%) and a 5-day drift on TEST-LOCAL symbols
 * TLX-* only; always removed afterwards. Other assets' prices must stay byte-identical.
 * Run: npm run check:abnormal [baseUrl]
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDb, schema } from "../db";
import { createMcpServer } from "../server/mcp";
import { ABNORMAL_TOOL_NAMES } from "../server/mcp-abnormal";

const BASE = process.argv[2] ?? "http://localhost:3101";
const KEY = process.env.API_KEY ?? "";
const DISCLAIMER = "เป็นสัญญาณทางสถิติ ไม่ใช่หลักฐานการกระทำผิด";
const db = getDb();
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
};

type Res = { ok: true; data: any } | { ok: false; code: string; text: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
let client: Client;
async function call(name: string, args: Record<string, unknown>): Promise<Res> {
  const r = await client.callTool({ name, arguments: args });
  const c = r.content as { text: string }[];
  if (!r.isError) return { ok: true, data: JSON.parse(c[0].text) };
  const extra = c[1] ? (JSON.parse(c[1].text) as { code: string }) : null;
  return {
    ok: false,
    code:
      extra?.code ?? c[0].text.match(/\[([A-Z_]+)\]/)?.[1] ?? "SDK_VALIDATION",
    text: c[0].text,
  };
}
const codeOf = (r: Res) => (r.ok ? "OK" : r.code);
const clean = (v: unknown) => !/NaN|Infinity/.test(JSON.stringify(v));

async function cleanup() {
  const ids = (
    await db
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(like(schema.assets.symbol, "TLX-%"))
  ).map((r) => r.id);
  for (const id of ids) {
    await db.delete(schema.prices).where(eq(schema.prices.assetId, id));
    await db
      .delete(schema.assetLifecycleEvents)
      .where(eq(schema.assetLifecycleEvents.assetId, id));
    await db.delete(schema.assets).where(eq(schema.assets.id, id));
  }
  await db
    .delete(schema.benchmarkPrices)
    .where(like(schema.benchmarkPrices.symbol, "TLX-%"));
  await db
    .delete(schema.stockEvents)
    .where(like(schema.stockEvents.symbol, "TLX-%"));
  await db
    .delete(schema.sharesOutstanding)
    .where(like(schema.sharesOutstanding.symbol, "TLX-%"));
  return ids.length;
}
const othersHash = async () =>
  createHash("sha256")
    .update(
      JSON.stringify(
        await db
          .select()
          .from(schema.prices)
          .where(
            sql`${schema.prices.assetId} not in (select id from assets where symbol like 'TLX-%')`,
          )
          .orderBy(schema.prices.assetId, schema.prices.date),
      ),
    )
    .digest("hex");

const N = 400;
const SPIKE = 380;
const NEWS = 385;
const day = (i: number) =>
  new Date(Date.UTC(2025, 0, 2) + i * 86_400_000).toISOString().slice(0, 10);

async function seed() {
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
  const [a] = await db
    .insert(schema.assets)
    .values({
      symbol: "TLX-A",
      name: "TEST-LOCAL abnormal (sample)",
      assetClass: "thai_stock",
      priceSource: "manual",
    })
    .returning();
  const [u] = await db
    .insert(schema.assets)
    .values({
      symbol: "TLX-US",
      name: "TEST-LOCAL us (sample)",
      assetClass: "us_stock",
      priceSource: "manual",
      currency: "USD",
    })
    .returning();
  let pi = 100;
  let pm = 1000;
  const P = [];
  const B = [];
  for (let i = 0; i < N; i++) {
    const rm = rnd() * 0.02;
    let ri = 1.1 * rm + rnd() * 0.02;
    let vol = 1e6 * (1 + rnd() * 0.5);
    if (i === SPIKE) {
      ri += 0.1;
      vol *= 30;
    }
    if (i > 0) {
      pi *= 1 + ri;
      pm *= 1 + rm;
    }
    P.push({
      assetId: a.id,
      date: day(i),
      close: pi,
      adjClose: pi,
      volume: Math.round(vol),
    });
    B.push({ symbol: "TLX-TRI", date: day(i), close: pm });
  }
  await db.insert(schema.prices).values(P);
  await db
    .insert(schema.prices)
    .values([{ assetId: u.id, date: day(0), close: 10 }]);
  await db.insert(schema.benchmarkPrices).values(B);
  return { a, u };
}

async function main() {
  await cleanup();
  const before = await othersHash();
  const server = createMcpServer();
  client = new Client({ name: "check", version: "0" });
  const [t1, t2] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(t1), client.connect(t2)]);
  try {
    const { a } = await seed();
    const tools = (await client.listTools()).tools;
    check(
      "tools/list has the 7 abnormal tools, read tools are readOnly",
      ABNORMAL_TOOL_NAMES.every((n) => tools.some((t) => t.name === n)) &&
        [
          "run_event_study",
          "get_abnormal_volume",
          "scan_abnormal_trading",
          "list_events",
        ].every(
          (n) =>
            tools.find((t) => t.name === n)?.annotations?.readOnlyHint === true,
        ),
    );

    // Events and shares outstanding.
    check(
      "record_event on an unknown symbol → ASSET_NOT_FOUND",
      codeOf(
        await call("record_event", {
          symbol: "TLX-NOPE",
          eventDate: day(NEWS),
          eventType: "news",
          description: "x",
        }),
      ) === "ASSET_NOT_FOUND",
    );
    check(
      "record_event with a bad type → validation",
      codeOf(
        await call("record_event", {
          symbol: "TLX-A",
          eventDate: day(NEWS),
          eventType: "rumour",
        }),
      ) !== "OK",
    );
    const ev = await call("record_event", {
      symbol: "tlx-a",
      eventDate: day(NEWS),
      eventType: "news",
      description: "sample news",
      source: "test",
    });
    check(
      "record_event stores under the asset symbol",
      ev.ok && ev.data.symbol === "TLX-A" && ev.data.id > 0,
    );
    const evId = ev.ok ? ev.data.id : 0;
    const le = await call("list_events", { symbol: "TLX-A" });
    check(
      "list_events returns it",
      le.ok && le.data.events.some((e: { id: number }) => e.id === evId),
    );
    check(
      "set_shares_outstanding without source → validation",
      codeOf(
        await call("set_shares_outstanding", {
          symbol: "TLX-A",
          effectiveDate: day(0),
          shares: 1e8,
        }),
      ) !== "OK",
    );
    const sh = await call("set_shares_outstanding", {
      symbol: "TLX-A",
      effectiveDate: day(0),
      shares: 100_000_000,
      source: "sample",
    });
    check(
      "set_shares_outstanding saves and returns history",
      sh.ok &&
        sh.data.history.length === 1 &&
        sh.data.disclaimer === DISCLAIMER,
    );

    // Abnormal volume.
    const av = await call("get_abnormal_volume", {
      symbol: "TLX-A",
      from: day(300),
    });
    check(
      "get_abnormal_volume: turnover basis, spike flagged ผิดปกติ, states model/period/n/disclaimer, days omitted by default",
      av.ok &&
        av.data.basis === "turnover" &&
        av.data.flagged.some(
          (f: { date: string; level: string }) =>
            f.date === day(SPIKE) && f.level === "ผิดปกติ",
        ) &&
        av.data.model === "mean_adjusted" &&
        av.data.period.from === day(300) &&
        av.data.n >= 120 &&
        av.data.disclaimer === DISCLAIMER &&
        !("days" in av.data) &&
        av.data.benchmark === null,
    );
    const avd = await call("get_abnormal_volume", {
      symbol: "TLX-A",
      from: day(300),
      includeDays: true,
    });
    check(
      "get_abnormal_volume includeDays",
      avd.ok && avd.data.days.length === N - 300,
    );

    // Scan.
    const sc = await call("scan_abnormal_trading", {
      symbols: ["TLX-A", "TLX-US", "TLX-NOPE"],
      from: day(300),
      triSymbol: "TLX-TRI",
    });
    const st = sc.ok ? sc.data.stocks[0] : null;
    check(
      "scan: spike day is the top flag, ผิดปกติ, labelled 5 trading days before the news",
      !!st &&
        st.flagged[0].date === day(SPIKE) &&
        st.flagged[0].level === "ผิดปกติ" &&
        /ผิดปกติก่อน event 5 วัน/.test(st.flagged[0].preEventLabel ?? ""),
      st ? JSON.stringify(st.flagged[0]).slice(0, 200) : codeOf(sc),
    );
    check(
      "scan: TRI basis (adjusted close vs TLX-TRI), coverage full",
      !!st &&
        st.benchmark.basis === "total_return" &&
        st.benchmark.symbol === "TLX-TRI" &&
        st.coverage.withAR === N - 300,
    );
    check(
      "scan: US stock and unknown symbol skipped with reasons",
      sc.ok &&
        sc.data.skipped.length === 2 &&
        sc.data.skipped.every((s: { reason: string }) => s.reason.length > 0),
    );
    check(
      "scan: output states model, criteria, thresholds, disclaimer; no NaN",
      sc.ok &&
        /Market model/.test(sc.data.modelLabel) &&
        sc.data.criteria.ผิดปกติ.includes("3") &&
        sc.data.thresholds.notable === 2 &&
        sc.data.disclaimer === DISCLAIMER &&
        clean(sc.data),
    );
    check(
      "scan: thresholds abnormal < notable → VALIDATION_ERROR",
      codeOf(
        await call("scan_abnormal_trading", {
          symbols: ["TLX-A"],
          thresholds: { notable: 3, abnormal: 2 },
        }),
      ) === "VALIDATION_ERROR",
    );
    const strict = await call("scan_abnormal_trading", {
      symbols: ["TLX-A"],
      from: day(300),
      triSymbol: "TLX-TRI",
      thresholds: { notable: 40, abnormal: 50 },
    });
    check(
      "scan: stricter thresholds remove the flags",
      strict.ok &&
        strict.data.stocks[0].flagged.length === 0 &&
        strict.data.stocks[0].level === "ปกติ",
    );
    const all = await call("scan_abnormal_trading", { from: day(390) });
    check(
      "scan without symbols covers non-archived thai_stock only",
      all.ok &&
        all.data.stocks.some((s: { symbol: string }) => s.symbol === "TLX-A") &&
        !all.data.stocks.some((s: { symbol: string }) => s.symbol === "TLX-US"),
    );

    // Event study.
    const es = await call("run_event_study", {
      symbol: "TLX-A",
      eventId: evId,
      triSymbol: "TLX-TRI",
    });
    const spikeDay = es.ok
      ? es.data.days.find((d: { rel: number }) => d.rel === -5)
      : null;
    check(
      "run_event_study by eventId: day 0 = news, AR at −5 with t > 3",
      es.ok &&
        es.data.ok === true &&
        es.data.day0 === day(NEWS) &&
        spikeDay?.t > 3,
      es.ok ? `t=${spikeDay?.t}` : codeOf(es),
    );
    check(
      "run_event_study states model, benchmark, estimation n, CAR sub-windows, volume, disclaimer",
      es.ok &&
        es.data.model === "market" &&
        es.data.benchmark.basis === "total_return" &&
        es.data.estimation.n >= 120 &&
        es.data.cars.some(
          (c: { label: string; t: number }) =>
            /run-up/.test(c.label) && c.t > 2,
        ) &&
        es.data.volume.ok &&
        es.data.volume.days.find((d: { rel: number }) => d.rel === -5)?.z > 3 &&
        es.data.disclaimer === DISCLAIMER &&
        clean(es.data),
    );
    const dim = await call("run_event_study", {
      symbol: "TLX-A",
      eventDate: day(NEWS),
      model: "dimson",
      triSymbol: "TLX-TRI",
    });
    check(
      "run_event_study Dimson",
      dim.ok && dim.data.ok === true && dim.data.fit.betas?.length === 3,
      dim.ok ? JSON.stringify(dim.data.fit).slice(0, 120) : codeOf(dim),
    );
    const early = await call("run_event_study", {
      symbol: "TLX-A",
      eventDate: day(50),
      triSymbol: "TLX-TRI",
    });
    check(
      "event too early → ok:false INSUFFICIENT_DATA with reason (not a guess)",
      early.ok &&
        early.data.ok === false &&
        early.data.code === "INSUFFICIENT_DATA" &&
        early.data.reason.length > 0 &&
        early.data.disclaimer === DISCLAIMER,
    );
    check(
      "run_event_study on a non-Thai stock → UNSUPPORTED_ASSET",
      codeOf(
        await call("run_event_study", { symbol: "TLX-US", eventDate: day(1) }),
      ) === "UNSUPPORTED_ASSET",
    );
    const noTri = await call("run_event_study", {
      symbol: "TLX-A",
      eventDate: day(NEWS),
      triSymbol: "TLX-NONE",
    });
    check(
      "without the TRI: falls back to close vs price index with a warning",
      noTri.ok &&
        noTri.data.benchmark.basis === "price" &&
        noTri.data.warnings.some((w: string) => /TLX-NONE/.test(w)),
    );

    // REST / HTTP.
    const up = await fetch(`${BASE}/login`)
      .then((r) => r.ok)
      .catch(() => false);
    if (!up) console.log("SKIP  HTTP checks — server not running at", BASE);
    else {
      const noAuth = await fetch(`${BASE}/api/v1/assets/${a.id}/abnormal`);
      check("REST without key → 401", noAuth.status === 401);
      if (!KEY) console.log("SKIP  authorized REST — API_KEY not set");
      else {
        const h = {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        };
        const viaMcp = await call("scan_abnormal_trading", {
          symbols: ["TLX-A"],
          from: day(300),
        });
        const mcpFlags = viaMcp.ok ? viaMcp.data.stocks[0].flagged.length : -1;
        const ov = await fetch(
          `${BASE}/api/v1/assets/${a.id}/abnormal?from=${day(300)}`,
          { headers: h },
        );
        const ovj = await ov.json();
        check(
          "GET /assets/{id}/abnormal: every day + events + shares, same flags as MCP",
          ov.status === 200 &&
            ovj.stock.days.length === N - 300 &&
            ovj.events.length === 1 &&
            ovj.sharesOutstanding.length === 1 &&
            ovj.stock.flagged.length === mcpFlags,
        );
        const bad = await fetch(
          `${BASE}/api/v1/assets/${a.id}/abnormal?from=2026-13-40`,
          { headers: h },
        );
        check("bad date → 400", bad.status === 400);
        const es2 = await fetch(
          `${BASE}/api/v1/abnormal/event-study?symbol=TLX-A&eventDate=${day(NEWS)}&triSymbol=TLX-TRI`,
          { headers: h },
        ).then((r) => r.json());
        check(
          "GET /abnormal/event-study matches MCP CAR",
          es.ok && Math.abs(es2.car.value - es.data.car.value) < 1e-12,
        );
        const delNoConfirm = await fetch(
          `${BASE}/api/v1/stock-events/${evId}?symbol=TLX-A`,
          { method: "DELETE", headers: h },
        );
        check(
          "DELETE event without confirmDelete → 400",
          delNoConfirm.status === 400,
        );
        const mcpBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        });
        const mh = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        };
        const m401 = await fetch(`${BASE}/api/mcp`, {
          method: "POST",
          headers: mh,
          body: mcpBody,
        });
        const mok = await fetch(`${BASE}/api/mcp`, {
          method: "POST",
          headers: { ...mh, authorization: `Bearer ${KEY}` },
          body: mcpBody,
        });
        const mtext = await mok.text();
        check(
          "/api/mcp: 401 without key; tools/list includes the abnormal tools",
          m401.status === 401 &&
            mok.status === 200 &&
            ABNORMAL_TOOL_NAMES.every((n) => mtext.includes(`"${n}"`)),
        );
      }
    }

    check(
      "delete_event without confirmDelete → refused",
      codeOf(await call("delete_event", { id: evId, symbol: "TLX-A" })) !==
        "OK",
    );
    check(
      "delete_event with the wrong symbol → EVENT_NOT_FOUND",
      codeOf(
        await call("delete_event", {
          id: evId,
          symbol: "TLX-US",
          confirmDelete: true,
        }),
      ) === "EVENT_NOT_FOUND",
    );
    const del = await call("delete_event", {
      id: evId,
      symbol: "TLX-A",
      confirmDelete: true,
    });
    check("delete_event", del.ok && del.data.deleted === true);

    // Data quality: TLX-A has volume, shares and history → no issues; TLX-US (not Thai) is not listed.
    const dq = await call("get_data_quality", {});
    const tlx = dq.ok
      ? dq.data.abnormalTrading.stocks.find(
          (s: { symbol: string }) => s.symbol === "TLX-A",
        )
      : null;
    check(
      "get_data_quality: abnormal-trading readiness per Thai stock (TLX-A complete, TLX-US excluded) + check row",
      dq.ok &&
        !!tlx &&
        tlx.issues.length === 0 &&
        !dq.data.abnormalTrading.stocks.some(
          (s: { symbol: string }) => s.symbol === "TLX-US",
        ) &&
        dq.data.checks.some(
          (c: { area: string }) => c.area === "ข้อมูลตรวจการซื้อขายผิดปกติ",
        ),
      tlx ? JSON.stringify(tlx.issues) : codeOf(dq),
    );

    check(
      "other assets' prices byte-identical",
      (await othersHash()) === before,
    );
  } finally {
    await client.close().catch(() => undefined);
    console.log(`cleaned up ${await cleanup()} test assets`);
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => 0);
  process.exit(1);
});
