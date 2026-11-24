// Steady Sprint — a small-stake sniper bot for the pump.fun bonding-curve replay.
//
// Idea, in one paragraph: on pump.fun the quoted price never falls below a curve's
// create price, so a coin bought within a few slots of its creation, still near that
// price, can only lose its small entry premium plus fees — while a few coins run
// several multiples within minutes. The bot therefore buys launches almost at birth
// (age a few slots, run-up capped at a few percent, at least one distinct buyer, net
// flow non-negative), in tiny tranches, and exits fast on a small take-profit, a
// tight stop, a trailing stop, or a short time limit. Stakes stay tiny on purpose:
// the final window is a fresh 6 hours of coins this dev window never saw, and the
// dev window punishes every bigger, later, or more concentrated bet (momentum,
// reversion and lottery variants all lost 10-100x more). A pacing probe keeps the
// run above the guardrail bar (round trips of at least 0.01 SOL on at least 20
// coins) even on a quiet stretch.
//
// Deterministic by construction: no clock, no environment, no randomness. Every decision is
// a pure function of the batch stream (hello, batch, orders, slot), iterated in
// insertion order only.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface SprintParams {
  /** Strategy family: 'momentum' buys proven demand after a rise; 'sniper' buys young
   *  curves near their create price, before the crowd, and sells into the first wave. */
  mode: 'momentum' | 'sniper';
  /** Entry lookback, in slots. */
  windowSlots: number;
  /** Minimum net SOL (buys minus sells) over the entry window. */
  minNetSol: number;
  /** Minimum buy trades in the entry window. */
  minBuys: number;
  /** Minimum distinct buying wallets in the entry window. */
  minBuyers: number;
  /** Minimum price rise over the entry window (fraction, e.g. 0.04 = +4%). */
  minRise: number;
  /** Maximum price rise over the entry window; skip coins that already mooned in-window. */
  maxRise: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Second-half net flow must be at least this multiple of the first half's (acceleration). */
  accelMin: number;
  /** Largest single buyer's share of window buy SOL (0..1); 1 disables the check. */
  maxTopBuyerShare: number;
  /** Entry only while real SOL reserves sit inside [minCurveSol, maxCurveSol]. */
  minCurveSol: number;
  maxCurveSol: number;
  /** Minimum slots since the CreateEvent before an entry is allowed. */
  minAgeSlots: number;
  /** Total SOL a single position may ever hold. */
  maxStakeSol: number;
  /** First buy of a position, in SOL. */
  firstBuySol: number;
  /** Each pyramid add, in SOL. */
  addBuySol: number;
  /** Smallest buy worth sending, in SOL (guardrail floor is 0.01). */
  minBuySol: number;
  /** Buy slippage allowance, bps. Sells always go out at 10000. */
  buySlippageBps: number;
  /** Stop loss vs cost (fraction, e.g. 0.20 = sell at -20%). */
  stopLoss: number;
  /** Trailing stop vs peak close value (fraction). */
  trailStop: number;
  /** Trailing stop arms once close value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Fade exit: sell when net SOL over fadeWindowSlots falls below -fadeNetSol. */
  fadeWindowSlots: number;
  fadeNetSol: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHoldSlots: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the whole run. */
  maxEntriesPerCoin: number;
  /** Add only while price is at least this far above the last buy's decision price. */
  addStepUp: number;
  /** Add only while close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addMinNetSol: number;
  /** Most momentum positions open at once (remaining slots are for probes). */
  maxMainPositions: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Guardrail pacing targets (coins / fills) over paceSeconds of block time. */
  targetCoins: number;
  targetFills: number;
  paceSeconds: number;
  /** Probe round-trip size, in SOL (must stay >= 0.01 for the guardrail). */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
  // --- Sniper mode ---
  /** Oldest age (slots since create) at which a first sniper buy may be decided. */
  snipeMaxAgeSlots: number;
  /** Real SOL reserve band at sniper entry. */
  snipeMinCurveSol: number;
  snipeMaxCurveSol: number;
  /** Price run-up from the create price allowed at sniper entry (fraction). */
  snipeMaxRunup: number;
  /** Minimum run-up from the create price at sniper entry: the early spike is the signal. */
  snipeMinRunup: number;
  /** Distinct buyers required before a sniper buy. */
  snipeMinBuyers: number;
  /** Net SOL over the last snipeFlowSlots that a sniper buy requires. */
  snipeFlowSlots: number;
  snipeMinNetSol: number;
  /** Sniper tranche size per batch, in SOL. */
  snipeTrancheSol: number;
  /** Smallest sniper buy worth sending (tranches accumulate to the 0.01 guardrail). */
  snipeMinBuySol: number;
  /** Adds keep coming while age is under this (slots), even after the entry window closes. */
  snipeAddMaxAgeSlots: number;
  /** Take profit vs cost (fraction); 0 disables. */
  takeProfit: number;
}

/** Default settings. Chosen by sweeping the dev window and the stress copies, preferring
 *  flat, robust regions over the single best cell (see the run log). */
export const DEFAULT_PARAMS: SprintParams = {
  mode: 'sniper',
  windowSlots: 40,
  minNetSol: 0.5,
  minBuys: 4,
  minBuyers: 4,
  minRise: 0.04,
  maxRise: 0.8,
  nearHigh: 0.97,
  accelMin: 1.0,
  maxTopBuyerShare: 0.6,
  minCurveSol: 1,
  maxCurveSol: 80,
  minAgeSlots: 300,
  maxStakeSol: 0.05,
  firstBuySol: 0.05,
  addBuySol: 0.1,
  minBuySol: 0.01,
  buySlippageBps: 500,
  stopLoss: 0.05,
  trailStop: 0.15,
  trailArm: 0.05,
  fadeWindowSlots: 20,
  fadeNetSol: 1000,
  maxHoldSlots: 200,
  holdIfUp: 0.2,
  cooldownSlots: 150,
  maxEntriesPerCoin: 2,
  addStepUp: 0.02,
  addIfUp: -1,
  addMinNetSol: 0,
  maxMainPositions: 5,
  maxExposureSol: 5,
  targetCoins: 25,
  targetFills: 40,
  paceSeconds: 14400,
  probeSol: 0.02,
  maxProbes: 1,
  snipeMaxAgeSlots: 3,
  snipeMinCurveSol: 0.5,
  snipeMaxCurveSol: 100,
  snipeMaxRunup: 0.05,
  snipeMinRunup: 0,
  snipeMinBuyers: 1,
  snipeFlowSlots: 10,
  snipeMinNetSol: 0,
  snipeTrancheSol: 0.005,
  snipeMinBuySol: 0.005,
  snipeAddMaxAgeSlots: 120,
  takeProfit: 0.15,
};

const LAMPORTS = 1e9;
/** Curve fee (protocol + creator fallback, 95 + 30 bps) applied to close-value estimates. */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinTape {
  createdSlot: number | null;
  createPrice: number;
  creator: string;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  peakValueSol: number;
  investedSol: number;
  exiting: boolean;
  sawFill: boolean;
  lastBuyPrice: number;
  lastValueSol: number;
}

export function createStrategy(p: SprintParams = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight: false while the buy is pending, true while selling. */
  const probes = new Map<Pubkey, boolean>();
  let ownFills = 0;
  const ownCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = Math.max(p.windowSlots, p.fadeWindowSlots) + 5;

  const tapeOf = (mint: Pubkey): CoinTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, createPrice: 0, creator: '', trades: [], entries: 0, lastExitSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) on a tape over the last `w` slots. */
  const netFlow = (t: CoinTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** The momentum entry signal on a tape at slot `now`. */
  const entryOk = (t: CoinTape, now: number, curveSol: number): boolean => {
    if (curveSol < p.minCurveSol || curveSol > p.maxCurveSol) return false;
    if (t.createdSlot === null || now - t.createdSlot < p.minAgeSlots) return false;
    const from = now - p.windowSlots;
    const mid = now - p.windowSlots / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byBuyer = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byBuyer.set(tr.user, (byBuyer.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byBuyer.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const rise = last / startPrice - 1;
    if (rise < p.minRise || rise > p.maxRise) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accelMin * netOld) return false;
    let top = 0;
    for (const v of byBuyer.values()) if (v > top) top = v;
    if (top > p.maxTopBuyerShare * buySol) return false;
    return true;
  };

  /** The sniper entry signal: a young curve, still near its create price, with fresh
   *  distinct buyers pushing net SOL in. Buys the launch, not the top of the first wave. */
  const snipeOk = (t: CoinTape, now: number, curveSol: number, price: number): boolean => {
    if (t.createdSlot === null) return false;
    const age = now - t.createdSlot;
    if (age < 0 || age > p.snipeMaxAgeSlots) return false;
    if (curveSol < p.snipeMinCurveSol || curveSol > p.snipeMaxCurveSol) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice - 1;
    if (runup > p.snipeMaxRunup || runup < p.snipeMinRunup) return false;
    if (netFlow(t, now, p.snipeFlowSlots) < p.snipeMinNetSol) return false;
    const buyers = new Set<string>();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.buy && tr.user !== t.creator) buyers.add(tr.user);
    }
    if (buyers.size < p.snipeMinBuyers) return false;
    return true;
  };

  /** Add window for the sniper: the launch may still be building size while young,
   *  even after the first-buy age window has closed. */
  const snipeAddOk = (t: CoinTape, now: number, curveSol: number, price: number): boolean => {
    if (t.createdSlot === null) return false;
    if (now - t.createdSlot > p.snipeAddMaxAgeSlots) return false;
    if (curveSol < p.snipeMinCurveSol || curveSol > p.snipeMaxCurveSol) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice - 1;
    if (runup > p.snipeMaxRunup || runup < p.snipeMinRunup) return false;
    if (netFlow(t, now, p.snipeFlowSlots) < 0) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          ownFills++;
          ownCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.createdSlot = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // --- Exits first: stops, trailing stops, fading flow, time limit. ---
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (h.sawFill) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        h.sawFill = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValueSol) h.peakValueSol = value;
        h.lastValueSol = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && p.takeProfit > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValueSol >= cost * (1 + p.trailArm) && value < h.peakValueSol * (1 - p.trailStop)) exit = true;
        if (!exit && netFlow(t, now, p.fadeWindowSlots) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.openedSlot > p.maxHoldSlots && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      // --- Probe round trips: sell the whole probe as soon as its buy has landed. ---
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and pyramid adds. ---
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMainPositions - open.size;
      let exposureSol = 0;
      for (const [mint, h] of open) {
        exposureSol += Math.max(h.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const curveSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntriesPerCoin || now - t.lastExitSlot < p.cooldownSlots) continue;
          if (p.mode === 'sniper') {
            if (!snipeOk(t, now, curveSol, price)) continue;
            want = Math.min(p.snipeTrancheSol, p.maxStakeSol);
          } else {
            if (!entryOk(t, now, curveSol)) continue;
            want = Math.min(p.firstBuySol, p.maxStakeSol);
          }
        } else if (p.mode === 'sniper') {
          // Keep adding tranches while the launch is still young and near its create
          // price; the second wave often comes tens to hundreds of slots later.
          if (h.exiting || !h.sawFill || h.investedSol >= p.maxStakeSol - p.minBuySol) continue;
          if (!snipeAddOk(t, now, curveSol, price)) continue;
          want = Math.min(p.snipeTrancheSol, p.maxStakeSol - h.investedSol);
        } else {
          // Pyramid into strength only: price stepped up from the last add, the position
          // is up, and net SOL still flows in.
          if (h.exiting || !h.sawFill || h.investedSol >= p.maxStakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastBuyPrice * (1 + p.addStepUp)) continue;
          if (h.lastValueSol < (Number(pos.cost_lamports) / LAMPORTS) * (1 + p.addIfUp)) continue;
          if (netFlow(t, now, p.windowSlots) < p.addMinNetSol) continue;
          if (curveSol > p.maxCurveSol) continue;
          want = Math.min(p.addBuySol, p.maxStakeSol - h.investedSol);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposureSol);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        const buyFloor = p.mode === 'sniper' ? p.snipeMinBuySol : p.minBuySol;
        if (amount < buyFloor) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlippageBps });
        freeSol -= amount + txSol;
        exposureSol += amount;
        if (h === undefined) {
          open.set(mint, {
            openedSlot: now,
            peakValueSol: 0,
            investedSol: amount,
            exiting: false,
            sawFill: false,
            lastBuyPrice: price,
            lastValueSol: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.investedSol += amount;
          h.lastBuyPrice = price;
        }
      }

      // --- Guardrail pacing: open a probe when fills or coins lag the pace. ---
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSeconds);
        const needCoins = ownCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = ownFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minCurve = (p.probeSol * 10000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && ownCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minCurve * 1.5) continue;
            if (freeSol < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            freeSol -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
