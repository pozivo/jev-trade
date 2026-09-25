import { expect, test } from "bun:test";
import type { Market } from "../src/market";
import type { Model, ModelDecision } from "../src/model";
import { capEntry, leverageRungs, liveIntent, parseLeverage, planQuote, quoteAction } from "../src/plan";
import { jevUnavailable, Trader } from "../src/trader";
import { config } from "../src/config";
import type { BlockEvent, Book, Quote, Side } from "../src/types";

test("jevUnavailable detects a TypeSafe credit 402", () => {
  expect(jevUnavailable(new Error("402 Your organization has no available TypeSafe API credits. Please add more credits"))).toBe(true);
  expect(jevUnavailable(new Error("hyperliquid rate limited"))).toBe(false);
});

test("open long buys and open short sells, resting post-only", () => {
  expect(quoteAction("open", "long")).toBe("buy");
  expect(quoteAction("open", "short")).toBe("sell");
  expect(planQuote({ intent: "open", bias: "long", positionSz: -2, quoteSz: 0.01 })).toEqual({
    side: "buy", size: 0.01, reduceOnly: false, taker: false,
  });
  expect(planQuote({ intent: "open", bias: "short", positionSz: 2, quoteSz: 0.01 })).toEqual({
    side: "sell", size: 0.01, reduceOnly: false, taker: false,
  });
});

test("close flattens the live book as a taker and skips when flat", () => {
  expect(planQuote({ intent: "close", bias: "long", positionSz: 0.08, quoteSz: 0.01 })).toEqual({
    side: "sell", size: 0.08, reduceOnly: true, taker: true,
  });
  expect(planQuote({ intent: "close", bias: "short", positionSz: -0.08, quoteSz: 0.01 })).toEqual({
    side: "buy", size: 0.08, reduceOnly: true, taker: true,
  });
  expect(planQuote({ intent: "close", bias: "long", positionSz: -0.08, quoteSz: 0.01 })).toEqual({
    side: "buy", size: 0.08, reduceOnly: true, taker: true,
  });
  expect(planQuote({ intent: "close", bias: "short", positionSz: 0.08, quoteSz: 0.01 })).toEqual({
    side: "sell", size: 0.08, reduceOnly: true, taker: true,
  });
  expect(planQuote({ intent: "close", bias: "long", positionSz: 0, quoteSz: 0.01 })).toBe(null);
});

test("hold sends nothing, whatever the bias or position", () => {
  expect(quoteAction("hold", "long")).toBe("hold");
  expect(quoteAction("hold", "short")).toBe("hold");
  expect(planQuote({ intent: "hold", bias: "long", positionSz: 0, quoteSz: 0.01 })).toBe(null);
  expect(planQuote({ intent: "hold", bias: "short", positionSz: 0.08, quoteSz: 0.01 })).toBe(null);
  expect(planQuote({ intent: "hold", bias: "long", positionSz: -0.08, quoteSz: 0.01 })).toBe(null);
});

test("entry cap rounds down to a valid lot and never blocks a close", () => {
  const open = planQuote({ intent: "open", bias: "long", positionSz: 1.5, quoteSz: 1 });
  expect(capEntry(open, 1.5, 100, 200, 2)?.size).toBe(0.5);
  expect(capEntry(open, 2, 100, 200, 2)).toBeNull();
  expect(capEntry(open, 1.999, 100, 200, 2)).toBeNull();
  expect(capEntry(open, 0, 100, NaN, 2)).toBeNull();
  const close = planQuote({ intent: "close", bias: "long", positionSz: 3, quoteSz: 1 });
  expect(capEntry(close, 3, 100, 200, 2)).toEqual(close);
});

test("liveIntent cannot close a flat book and stands down instead", () => {
  expect(liveIntent("flat", "close")).toBe("hold");
  expect(liveIntent("flat", "hold")).toBe("hold");
  expect(liveIntent("flat", "open")).toBe("open");
  expect(liveIntent("long", "close")).toBe("close");
  expect(liveIntent("long", "hold")).toBe("hold");
  expect(liveIntent("short", "open")).toBe("open");
});

test("leverage rungs follow the coin max", () => {
  expect(leverageRungs(10)).toEqual([1, 2, 3, 5, 10]);
  expect(leverageRungs(50)).toEqual([1, 2, 3, 5, 10, 20, 40, 50]);
  expect(leverageRungs(15)).toEqual([1, 2, 3, 5, 10, 15]);
  expect(parseLeverage("7", 10, 1)).toBe(5);
  expect(parseLeverage("50", 10, 1)).toBe(10);
});

const book: Book = {
  block: 1,
  bid: 99.9,
  ask: 100.1,
  mid: 100,
  spreadBps: 20,
  imbalance: 0,
  levels: { bids: [[99.9, 1]], asks: [[100.1, 1]] },
  depthBps: { "10": { bid: 1, ask: 1 } },
};

function packed(partial: Partial<ModelDecision> & Pick<ModelDecision, "intent" | "bias" | "action">): ModelDecision {
  return {
    leverage: 1,
    probabilities: { buy: 0, sell: 0, hold: 1, long: 0.5, short: 0.5, open: 0, close: 0 },
    upIn10: 0.5,
    latencyMs: 1,
    inputTokens: 0,
    ...partial,
  };
}

class ScriptModel implements Model {
  constructor(readonly name = "script") {}
  next: ModelDecision | Error = packed({ intent: "hold", bias: "long", action: "hold" });
  delayMs = 0;
  async decide(): Promise<ModelDecision> {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

class FakeMarket {
  readonly coin = "BTC";
  readonly pair = "BTC-USD";
  readonly wallet = null;
  readonly account = null;
  readonly szDecimals = 5;
  readonly maxLeverage = 40;
  readonly fillPrints: [] = [];
  assetCtx = null;
  lastOid: number | null = null;
  cancels = 0;
  sends = 0;
  requestedLeverage: number | null = null;
  failLeverage = false;
  sendDelayMs = 0;
  candleCloses() { return []; }
  refresh() { return Promise.resolve(); }
  readBook() { return book; }
  quoteSize() { return 0.01; }
  setLeverage(n: number) {
    this.requestedLeverage = n;
    return this.failLeverage ? Promise.reject(new Error("leverage update failed")) : Promise.resolve(n);
  }
  async send(side: Side, size: number, _book: Book, cancel: number[]): Promise<Quote> {
    this.sends++;
    if (this.sendDelayMs) await Bun.sleep(this.sendDelayMs);
    this.lastOid = 4242;
    return {
      side, price: 99.9, size, txHash: null, cancel, status: "placed",
      orderId: 4242, capped: false, reduceOnly: false, taker: false,
    };
  }
  async cancelResting() {
    this.cancels++;
    const oid = this.lastOid;
    this.lastOid = null;
    return oid == null ? [] : [oid];
  }
}

function desk(model: ScriptModel, market = new FakeMarket()) {
  const events: BlockEvent[] = [];
  const trader = new Trader(market as unknown as Market, model, (e) => events.push(e));
  return { trader, market, events };
}

test("a hold tick pulls an in-flight quote before it can rest", async () => {
  const model = new ScriptModel();
  const { trader, market } = desk(model);
  market.sendDelayMs = 80;
  model.next = packed({ intent: "open", bias: "long", action: "buy" });
  const open = trader.onBlock(1);
  await Bun.sleep(10);
  model.next = packed({ intent: "hold", bias: "long", action: "hold" });
  await trader.onBlock(2);
  await open;
  await Bun.sleep(120);
  expect(market.cancels).toBeGreaterThan(0);
});

test("a busy tick still emits late so the desk can show it", async () => {
  const model = new ScriptModel();
  const { trader, events } = desk(model);
  model.delayMs = 40;
  const first = trader.onBlock(1);
  await Bun.sleep(5);
  await trader.onBlock(2);
  await first;
  expect(events.some((e) => e.block === 2 && e.decision?.late === true)).toBe(true);
});

test("a failed Jev call emits late instead of going silent", async () => {
  const model = new ScriptModel();
  const { events, trader, market } = desk(model);
  model.next = new Error("boom");
  await trader.onBlock(1);
  expect(events.some((e) => e.decision?.late === true)).toBe(true);
  await Bun.sleep(0);
  expect(market.cancels).toBe(1);
});

test("a model failure pulls the preceding resting quote", async () => {
  const model = new ScriptModel();
  const { trader, market } = desk(model);
  model.next = packed({ intent: "open", bias: "long", action: "buy" });
  await trader.onBlock(1);
  await Bun.sleep(0);
  expect(market.lastOid).toBe(4242);
  model.next = new Error("model unavailable");
  await trader.onBlock(2);
  await Bun.sleep(0);
  expect(market.lastOid).toBeNull();
});

test("the hard leverage cap is applied before sending an entry", async () => {
  const model = new ScriptModel();
  const { trader, market, events } = desk(model);
  model.next = packed({ intent: "open", bias: "long", action: "buy", leverage: 40 });
  await trader.onBlock(1);
  await Bun.sleep(0);
  expect(market.requestedLeverage).toBe(config.maxLeverage);
  expect(events[0]?.decision?.leverage).toBe(config.maxLeverage);
  expect(market.sends).toBe(1);
});

test("a failed leverage update prevents the entry", async () => {
  const model = new ScriptModel();
  const { trader, market } = desk(model);
  market.failLeverage = true;
  model.next = packed({ intent: "open", bias: "long", action: "buy", leverage: 40 });
  await trader.onBlock(1);
  await Bun.sleep(0);
  expect(market.sends).toBe(0);
});

test("mock model calls do not accrue Jev API costs", async () => {
  const model = new ScriptModel();
  const { trader, events } = desk(model);
  model.next = packed({ intent: "hold", bias: "long", action: "hold", inputTokens: 1000 });
  await trader.onBlock(1);
  expect(events[0]?.totals.jevUsd).toBe(0);
});

test("session net includes estimated Jev API spend from the first decision", async () => {
  const model = new ScriptModel("jev");
  const { trader, events } = desk(model);
  model.next = packed({ intent: "hold", bias: "long", action: "hold", inputTokens: 1000 });
  await trader.onBlock(1);
  expect(events[0]?.totals.jevUsd).toBeCloseTo(0.000042, 8);
  expect(events[0]?.totals.sessionNetUsd).toBeCloseTo(-0.000042, 8);
});
