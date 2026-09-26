import { expect, test } from "bun:test";
import { matchesProtection, protectionOrders } from "../src/protection";

test("long protection closes with a sell below and above entry", () => {
  const [sl, tp] = protectionOrders(2, 100, 5, 100, 200);
  expect(sl).toMatchObject({ kind: "sl", side: "sell", triggerPx: "99", size: "2" });
  expect(tp).toMatchObject({ kind: "tp", side: "sell", triggerPx: "102" });
  expect(Number(sl!.limitPx)).toBeLessThan(Number(sl!.triggerPx));
  expect(matchesProtection({ side: "A", orderType: "Stop Market", triggerPx: "99", reduceOnly: true, isPositionTpsl: true }, sl!)).toBe(true);
});

test("short protection buys above and below entry", () => {
  const [sl, tp] = protectionOrders(-2, 100, 5, 100, 200);
  expect(sl).toMatchObject({ kind: "sl", side: "buy", triggerPx: "101" });
  expect(tp).toMatchObject({ kind: "tp", side: "buy", triggerPx: "98" });
  expect(Number(sl!.limitPx)).toBeGreaterThan(Number(sl!.triggerPx));
  expect(matchesProtection({ side: "B", orderType: "Stop Limit", triggerPx: "101", reduceOnly: true, isPositionTpsl: true }, sl!)).toBe(false);
});

test("invalid protection settings fail closed", () => {
  expect(() => protectionOrders(1, 100, 5, 0, 200)).toThrow();
  expect(() => protectionOrders(1, 100, 5, 100, 10_000)).toThrow();
});
