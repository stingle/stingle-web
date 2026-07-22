import { describe, expect, test } from "vitest";

import { PriorityTaskPool, runTaskPool } from "../../src/media/task-pool";

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

  test("runs newly visible work before pending background work", async () => {
    const pool = new PriorityTaskPool(2);
    const started: string[] = [];
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });

    for (const key of ["active-1", "active-2", "background-1", "background-2"]) {
      pool.enqueue(key, 10, async () => {
        started.push(key);
        if (key.startsWith("active")) await activeGate;
      });
    }
    await viWaitFor(() => started.length === 2);

    pool.reprioritizePending(10);
    pool.enqueue("visible-1", 0, async () => { started.push("visible-1"); });
    pool.enqueue("visible-2", 0, async () => { started.push("visible-2"); });
    releaseActive();
    await pool.whenIdle();

    expect(started).toEqual([
      "active-1", "active-2", "visible-1", "visible-2", "background-1", "background-2",
    ]);
  });

  test("updates the priority of duplicate pending work without running it twice", async () => {
    const pool = new PriorityTaskPool(1);
    const started: string[] = [];
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
    pool.enqueue("active", 0, async () => { started.push("active"); await activeGate; });
    pool.enqueue("thumbnail", 10, async () => { started.push("stale-task"); });
    await viWaitFor(() => started.length === 1);
    pool.enqueue("thumbnail", 0, async () => { started.push("thumbnail"); });
    releaseActive();
    await pool.whenIdle();
    expect(started).toEqual(["active", "thumbnail"]);
  });

  test("preempts and requeues an in-flight background task for newly visible work", async () => {
    const pool = new PriorityTaskPool(1);
    const started: string[] = [];
    let backgroundAttempts = 0;
    pool.enqueue("background", 0, async (signal) => {
      backgroundAttempts += 1;
      started.push(`background-${backgroundAttempts}`);
      if (backgroundAttempts === 1) {
        await new Promise<void>((_resolve, reject) => signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        ));
      }
    });
    await viWaitFor(() => started.length === 1);
    pool.reprioritizeAll(10);
    pool.enqueue("visible", 0, async () => { started.push("visible"); });
    await pool.whenIdle();
    expect(started).toEqual(["background-1", "visible", "background-2"]);
  });

  test("cancels pending and active work outside a replacement viewport", async () => {
    const pool = new PriorityTaskPool(2);
    const started: string[] = [];
    const aborted: string[] = [];
    for (const key of ["stale-1", "stale-2", "stale-pending"]) {
      pool.enqueue(key, 5, async (signal) => {
        started.push(key);
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
          aborted.push(key);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true }));
      });
    }
    await viWaitFor(() => started.length === 2);

    pool.retain(new Set(["visible"]));
    pool.enqueue("visible", 0, async () => { started.push("visible"); });
    await pool.whenIdle();

    expect(started).toEqual(["stale-1", "stale-2", "visible"]);
    expect(aborted).toEqual(["stale-1", "stale-2"]);
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}
