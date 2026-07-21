import { describe, expect, test } from "vitest";

import { runTaskPool } from "../../src/media/task-pool";

describe("bounded task pool", () => {
  test("keeps 32 workers fed until a larger queue is exhausted", async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve; });

    const running = runTaskPool(Array.from({ length: 70 }, (_, index) => index), 32, async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (completed < 32) await firstWave;
      else await Promise.resolve();
      completed += 1;
      active -= 1;
    });

    await viWaitFor(() => peak === 32);
    expect({ peak, active }).toEqual({ peak: 32, active: 32 });
    releaseFirstWave();
    await running;
    expect({ completed, active }).toEqual({ completed: 70, active: 0 });
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
