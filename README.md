# Steady Sprint — Pump.fun Paper Sprint bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/DLiiMaGaming/pump-fun-paper-sprint-20261124/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/DLiiMaGaming/pump-fun-paper-sprint-20261124/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A small-stake sniper bot for the [Pump.fun Paper Sprint](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
competition on [make.fun](https://make.fun): one program (`main.ts`, Node 22, zero
dependencies) paper-trades pump.fun bonding curves on a 6-hour replay, ranked by
net PnL.

## Idea

On pump.fun the quoted price never falls below a curve's create price, so a coin
bought within a few slots of its creation, still near that price, can only lose
its small entry premium plus fees — while a few coins run several multiples within
minutes. The bot therefore buys launches almost at birth (a few slots old, run-up
capped at a few percent, at least one distinct buyer, net flow non-negative), in
tiny tranches, and exits fast on a small take-profit, a tight stop, a trailing
stop, or a short time limit. Stakes stay tiny on purpose: the final window is a
fresh 6 hours of coins the dev window never saw, and the dev window punishes
every bigger, later, or more concentrated bet (momentum, reversion and lottery
variants all lost 10–100x more). A pacing probe keeps the run above the guardrail
bar (round trips of at least 0.01 SOL on at least 20 coins) even on a quiet
stretch.

The strategy is deterministic by construction: no clock, no environment, no
randomness — every decision is a pure function of the batch stream.

## Layout

- `main.ts` — entrypoint: runs the strategy through the replay shim.
- `strategy.ts` — the strategy (momentum + sniper modes, exits, guardrail probes).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored as the
  kit instructs.

## Run

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
```
