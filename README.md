# Pump.fun Paper Sprint — Momentum Paper-Trading Bot

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/RifkiyGaming/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/RifkiyGaming/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It paper-trades pump.fun bonding curves on a 6-hour replay — no real funds, pure net PnL.

## Strategy

The bot watches a short rolling tape of trades per curve and buys only when a curve
shows genuine heating-up momentum:

- **Mature curve** — past a minimum age since its `CreateEvent`, so the usual
  launch dump has already passed.
- **Accelerating inflow** — net SOL flowing in over a short window, with the
  newer half of the window bringing in more than the older half.
- **Broad buying** — several distinct wallets buying, not one big wallet.
- **Price holding near its high** — price up over the window and sitting near the
  window's high, without having already run too far.

Sizing is timid on purpose: a small first buy, then pyramid adds only while the
trade is already working (price stepped up from the last add and the position still
in profit), up to a fixed stake per coin. Every position carries a stop loss, a
trailing stop that arms once the trade is up, a fade exit on reversing flow, and a
hard maximum hold time.

## Guardrails

The competition requires a round trip of at least 0.01 SOL on each of at least 20
coins, maximum drawdown of 50% or less, and net PnL above 0 SOL. A pacing guard
watches the bot's own fills and distinct coins against the elapsed share of the
window; when it lags, it opens tiny 0.01 SOL probe round trips on liquid curves
(buy, then sell the whole probe as soon as the buy lands) until it is back on pace.

## Layout

- `main.ts` — entry point; hands the strategy to the harness (`runBot`).
- `strategy.ts` — the strategy: entry signal, sizing, exits, and the pacing guard.
- `vendor/agentfun-bot.ts` — the kit's SDK shim, copied byte for byte.

Deterministic: no clock, no randomness, no network, standard library only.
