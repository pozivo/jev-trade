import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

export type ProtectionKind = "sl" | "tp";
export type ProtectionOrder = {
  kind: ProtectionKind;
  side: "buy" | "sell";
  triggerPx: string;
  limitPx: string;
  size: string;
};

/** Position-linked market triggers. The execution limit permits up to 10% slippage. */
export function protectionOrders(positionSz: number, entryPx: number, szDecimals: number, stopBps: number, takeBps: number): ProtectionOrder[] {
  if (!Number.isFinite(positionSz) || !positionSz || !Number.isFinite(entryPx) || entryPx <= 0) throw new Error("invalid position for TP/SL");
  if (!(stopBps > 0 && stopBps < 10_000 && takeBps > 0 && takeBps < 10_000)) throw new Error("invalid TP/SL bps");
  const long = positionSz > 0;
  const side = long ? "sell" : "buy";
  const stop = entryPx * (1 + (long ? -stopBps : stopBps) / 10_000);
  const take = entryPx * (1 + (long ? takeBps : -takeBps) / 10_000);
  const build = (kind: ProtectionKind, trigger: number): ProtectionOrder => ({
    kind, side,
    triggerPx: formatPrice(trigger, szDecimals),
    limitPx: formatPrice(trigger * (long ? 0.9 : 1.1), szDecimals),
    size: formatSize(Math.abs(positionSz), szDecimals),
  });
  return [build("sl", stop), build("tp", take)];
}

export type VisibleProtection = {
  side: "A" | "B";
  orderType: string;
  triggerPx: string;
  reduceOnly: boolean;
  isPositionTpsl: boolean;
};

export function matchesProtection(order: VisibleProtection, desired: ProtectionOrder): boolean {
  return order.isPositionTpsl && order.reduceOnly &&
    order.side === (desired.side === "buy" ? "B" : "A") &&
    order.orderType === (desired.kind === "sl" ? "Stop Market" : "Take Profit Market") &&
    Number(order.triggerPx) === Number(desired.triggerPx);
}
