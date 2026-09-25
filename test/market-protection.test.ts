import { expect, test } from "bun:test";
import { Market } from "../src/market";
import { protectionOrders } from "../src/protection";
import { config } from "../src/config";

function venueOrder(kind: "sl" | "tp", positionSz = 2) {
  const desired = protectionOrders(positionSz, 100, 5, config.stopLossBps, config.takeProfitBps)
    .find((order) => order.kind === kind)!;
  return {
    coin: "BTC", oid: kind === "sl" ? 1 : 2,
    isTrigger: true, isPositionTpsl: true, reduceOnly: true,
    side: desired.side === "buy" ? "B" : "A",
    orderType: kind === "sl" ? "Stop Market" : "Take Profit Market",
    triggerPx: desired.triggerPx,
  };
}

function fakeMarket(positionSz: number, existing: ReturnType<typeof venueOrder>[]) {
  const market = Object.create(Market.prototype) as Market & Record<string, any>;
  const orders = [...existing];
  const sent: any[] = [];
  market.wallet = { address: "0x123" } as any;
  market.coin = "BTC";
  market.szDecimals = 5;
  market.account = { positionSz, entryPrice: positionSz ? 100 : null } as any;
  market.protectionTail = Promise.resolve();
  market.protectedSignature = "";
  market.protectionCheckedAt = 0;
  market.info = { frontendOpenOrders: async () => [...orders] };
  market.ex = { order: async (request: any) => {
    sent.push(request);
    const trigger = request.orders[0].t.trigger;
    orders.push(venueOrder(trigger.tpsl, positionSz));
    return { response: { data: { statuses: [{ resting: { oid: orders.length } }] } } };
  } };
  return { market, sent, orders };
}

test("a position receives stop first, then take profit, and both are confirmed", async () => {
  const { market, sent } = fakeMarket(2, []);
  await market.ensureProtection();
  expect(sent.map((request) => request.orders[0].t.trigger.tpsl)).toEqual(["sl", "tp"]);
  expect(sent.every((request) => request.grouping === "positionTpsl" && request.orders[0].r)).toBe(true);
  expect(sent.every((request) => request.orders[0].b === false)).toBe(true);
});

test("an existing stop is reused; a different trigger blocks exposure", async () => {
  const { market, sent } = fakeMarket(-2, [venueOrder("sl", -2)]);
  await market.ensureProtection();
  expect(sent.map((request) => request.orders[0].t.trigger.tpsl)).toEqual(["tp"]);
  expect(sent[0].orders[0].b).toBe(true);

  const conflict = fakeMarket(2, [{ ...venueOrder("sl"), triggerPx: "95" }]);
  await expect(conflict.market.ensureProtection()).rejects.toThrow("different TP/SL");
  expect(conflict.sent).toHaveLength(0);
});

test("a flat account with leftover position triggers blocks new entries", async () => {
  const { market, sent } = fakeMarket(0, [venueOrder("sl")]);
  await expect(market.ensureProtection()).rejects.toThrow("stale position TP/SL");
  expect(sent).toHaveLength(0);
});
