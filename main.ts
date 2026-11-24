// Steady Sprint — a small-stake momentum bot for the pump.fun paper sprint.
// One program, one strategy: buy proven demand early, size small, exit fast.
// The grader runs `node main.ts` (Node 22 strips the types; no build, no install).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
