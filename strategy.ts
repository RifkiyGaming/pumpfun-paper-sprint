// Pump.fun Paper Sprint — early-entry lottery-ticket paper-trading bot.
//
// What the dev window teaches: by the time a pump.fun curve has shown a clean
// multi-slot momentum footprint (the classic "buy the risers" signal), it has
// usually already topped — the kit's own tuned momentum pilot loses ~9.5 of 10 SOL
// on this data, and so did the first version of this bot. Fast in-and-out sniping
// does better but still loses a little on every trade to fees. What works is the
// lottery-ticket shape: buy many fresh launches tiny, hold the runners, and let
// the one or two coins that actually run pay for the rest of the book.
//
// Entry (decided within a few slots of the CreateEvent): a young curve with real
// buying already happening — the creator has not sold, the creator's own opening
// buy is not huge, a few distinct non-creator wallets are in, net flow is not
// negative, the price is already up a little from its create price, and the curve
// holds a sane amount of real SOL. Buys are small (the 1%-of-real-reserve cap
// binds on most fresh curves) and one per coin.
//
// Exits: there is no fixed take-profit — a runner is held and only a trailing
// stop (armed once the position has doubled, selling on a 20% fall from its peak)
// takes it off. Losers are cut only on a deep 50% stop, and creator sells are
// deliberately ignored: creators selling a little early is normal, and exiting on
// it was measured to cost more in missed runners than it saves in rugs. Curves
// that complete are closed by the replay at their final reserves.
//
// Guardrails: the competition needs a round trip of at least 0.01 SOL on each of
// at least 20 coins, drawdown at or under 50%, and net PnL above zero. Long holds
// mean few round trips, so one of the five position slots is always reserved for
// a pacing guard: when the bot's own fills or coins lag the pace, it opens tiny
// 0.01 SOL probe round trips on liquid curves (buy, then sell the whole probe as
// soon as the buy lands) until it is back on pace.
//
// Deterministic by construction: no clock, no randomness, no network. All iteration
// is over insertion-ordered maps fed by the batch stream, so two runs of the same
// window produce the same orders.


import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface SprintParams {
  /** Youngest age (slots since create) at which a first buy may be decided. */
  entryAgeMin: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  entryAgeMax: number;
  /** SOL staked in one coin in total (single buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL in the curve at entry: lower and upper bound. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot must be at most this (SOL). */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry: lower and upper bound. */
  minEarlyBuyers: number;
  maxEarlyBuyers: number;
  /** Skip the coin entirely once the creator has sold. */
  skipCreatorSold: boolean;
  /** Price now over the create price: upper bound (fraction, 1 = no limit). */
  maxRunup: number;
  /** Price now over the create price: lower bound — require some real buying interest already. */
  minRunup: number;
  /** Slots of recent tape the entry flow check looks at. */
  flowWindowSlots: number;
  /** Net SOL over the flow window must be at least this. */
  minFlowSol: number;
  /** Slippage tolerance on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Sell when value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm); then sell on a fall of trailDrop from peak. */
  trailArm: number;
  trailDrop: number;
  /** Sell after holding this many slots, whatever the price. */
  maxHoldSlots: number;
  /** Sell as soon as the creator sells while held. */
  exitOnCreatorSell: boolean;
  /** Sell on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Guardrail pacing targets: coins and fills to reach by the end of the pace window. */
  targetCoins: number;
  targetFills: number;
  /** Slots of the 5-position cap kept free for guardrail probes. */
  reserveProbeSlots: number;
  /** Seconds over which the pacing targets ramp from 0 to full. */
  paceWindowSecs: number;
  /** SOL per guardrail probe buy. */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbesOpen: number;
}

export const DEFAULT_PARAMS: SprintParams = {
  entryAgeMin: 0,
  entryAgeMax: 3,
  stakeSol: 0.5,
  minBuySol: 0.005,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 2.5,
  minEarlyBuyers: 2,
  maxEarlyBuyers: 5,
  skipCreatorSold: true,
  maxRunup: 100,
  minRunup: 0.02,
  flowWindowSlots: 10,
  minFlowSol: 0.01,
  buySlippageBps: 10_000,
  takeProfit: 100,
  stopLoss: 0.5,
  trailArm: 1,
  trailDrop: 0.2,
  maxHoldSlots: 1000000,
  exitOnCreatorSell: false,
  bigSellSol: 1000,
  targetCoins: 25,
  targetFills: 60,
  reserveProbeSlots: 1,
  paceWindowSecs: 21600,
  probeSol: 0.01,
  maxProbesOpen: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Tick {
  slot: number;
  buy: boolean;
  sol: number;
  wallet: string;
}

interface CoinWatch {
  creator: Pubkey;
  bornSlot: number;
  /** Create-time price (vq/vt) for the run-up check. */
  createVq: number;
  createVt: number;
  devBuySol: number;
  devSold: boolean;
  buyers: Set<Pubkey>;
  ticks: Tick[];
  /** Never buy again (exited, filtered out for good, or completed). */
  done: boolean;
  /** Decision price of the buy, for nothing — kept for clarity of the record. */
  bought: boolean;
  lastTradeSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  peakValueSol: number;
  creatorSoldAtOpen: boolean;
}

export function createStrategy(p: SprintParams = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, CoinWatch>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight: false = buy outstanding, true = sell outstanding. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;

  const watchFor = (mint: Pubkey, creator: Pubkey, slot: number, vq: number, vt: number): CoinWatch => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        creator,
        bornSlot: slot,
        createVq: vq,
        createVt: vt,
        devBuySol: 0,
        devSold: false,
        buyers: new Set(),
        ticks: [],
        done: false,
        bought: false,
        lastTradeSlot: slot,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net SOL and distinct non-creator buyers over the last `w` slots of a coin's tape. */
  const recentFlow = (c: CoinWatch, now: number, w: number): { net: number; buyers: number } => {
    let net = 0;
    const buyers = new Set<string>();
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (t.slot <= now - w) break;
      if (t.buy) {
        net += t.sol;
        buyers.add(t.wallet);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  };

  /** What selling `tokens` against (vq, vt) pays in SOL, after the curve fee and one tx fee. */
  const sellValueSol = (tokens: bigint, vq: number, vt: number, txSol: number): number => {
    if (tokens <= 0n || vt <= 0) return 0;
    const out = (Number(tokens) * vq) / (vt + Number(tokens)) / LAMPORTS;
    return out * (1 - CURVE_FEE) - txSol;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSellers = new Set<Pubkey>();
      const fresh = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }

      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          watchFor(e.mint, e.creator, e.slot, Number(e.virtual_quote_reserves), Number(e.virtual_token_reserves));
          fresh.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.ticks.push({ slot: e.slot, buy: e.is_buy, sol, wallet: e.user });
          c.lastTradeSlot = e.slot;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            if (isDev && e.slot === c.bornSlot) c.devBuySol += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          }
          if (!e.is_buy && sol >= p.bigSellSol) bigSellers.add(e.mint);
          fresh.add(e.mint);
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) c.done = true;
        }
      }

      // Prune tape older than the flow window.
      for (const mint of fresh) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.ticks.length && c.ticks[cut]!.slot <= now - p.flowWindowSlots) cut++;
        if (cut > 0) c.ticks.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingSell = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') return true;
        }
        return false;
      };
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // 1) Exits first: take profit, stop loss, trailing stop, max hold, creator sell, big sell.
      for (const [mint, pos] of open) {
        const holding = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (holding === undefined) {
          if (!pendingByMint.has(mint)) open.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = sellValueSol(holding.token_amount, vq, vt, txSol);
        const cost = Number(holding.cost_lamports) / LAMPORTS;
        if (value > pos.peakValueSol) pos.peakValueSol = value;
        const c = coins.get(mint);
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        if (value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && pos.peakValueSol >= cost * (1 + p.trailArm) && value <= pos.peakValueSol * (1 - p.trailDrop)) exit = true;
        if (!exit && now - pos.openedSlot >= p.maxHoldSlots) exit = true;
        if (!exit && p.exitOnCreatorSell && c !== undefined && c.devSold && !pos.creatorSoldAtOpen) exit = true;
        if (!exit && bigSellers.has(mint)) exit = true;
        if (!exit || pendingSell(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: BPS });
      }

      // 2) Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const holding = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (holding === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: BPS });
        if (!selling) probes.set(mint, true);
      }

      // 3) Entries: fresh coins only, rug filter, one small buy each.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of fresh) {
        if (orders.length >= orderCap) break;
        const c = coins.get(mint)!;
        if (c.done || c.bought) continue;
        const age = now - c.bornSlot;
        if (age > p.entryAgeMax) {
          c.done = true;
          continue;
        }
        if (age < p.entryAgeMin) continue;
        if (openSlots <= p.reserveProbeSlots) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (p.skipCreatorSold && c.devSold) {
          c.done = true;
          continue;
        }
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
        if (c.devBuySol > p.maxDevBuySol) continue;
        if (c.buyers.size < p.minEarlyBuyers || c.buyers.size > p.maxEarlyBuyers) continue;
        const flow = recentFlow(c, now, p.flowWindowSlots);
        if (flow.net < p.minFlowSol) continue;
        const priceNow = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const priceAtCreate = c.createVq / c.createVt;
        if (priceAtCreate > 0) {
          const runup = priceNow / priceAtCreate - 1;
          if (runup > p.maxRunup || runup < p.minRunup) continue;
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlippageBps,
        });
        freeSol -= amount + txSol;
        openSlots--;
        c.bought = true;
        open.set(mint, { openedSlot: now, peakValueSol: 0, creatorSoldAtOpen: c.devSold });
      }

      // 4) Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbesOpen && openSlots > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceWindowSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minReal = (p.probeSol * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of fresh) {
            if (orders.length >= orderCap || probes.size >= p.maxProbesOpen) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (freeSol < p.probeSol + 2 * txSol) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlippageBps,
            });
            probes.set(mint, false);
            freeSol -= p.probeSol + txSol;
          }
        }
      }

      return orders;
    },
  };
}
