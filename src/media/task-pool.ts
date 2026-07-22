export async function runTaskPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("invalid task-pool concurrency");
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

interface PrioritizedTask {
  key: string;
  priority: number;
  order: number;
  run: (signal: AbortSignal) => Promise<void>;
}

interface ActiveTask extends PrioritizedTask {
  controller: AbortController;
  preempted: boolean;
  cancelled: boolean;
}

/** A continuously fed, keyed pool whose pending work can be reprioritized. */
export class PriorityTaskPool {
  private readonly pending = new Map<string, PrioritizedTask>();
  private readonly active = new Map<string, ActiveTask>();
  private readonly idleWaiters = new Set<() => void>();
  private running = 0;
  private nextOrder = 0;
  private drainScheduled = false;

  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("invalid task-pool concurrency");
  }

  enqueue(key: string, priority: number, run: (signal: AbortSignal) => Promise<void>): void {
    if (!key) throw new Error("task key is required");
    if (!Number.isFinite(priority)) throw new Error("task priority must be finite");
    const active = this.active.get(key);
    if (active) {
      active.priority = Math.min(active.priority, priority);
      const requeued = this.pending.get(key);
      if (requeued) {
        requeued.priority = priority;
        requeued.run = run;
      }
      return;
    }
    const queued = this.pending.get(key);
    if (queued) {
      queued.priority = priority;
      queued.run = run;
    } else {
      this.pending.set(key, { key, priority, order: this.nextOrder++, run });
    }
    this.preemptOneFor(priority);
    this.scheduleDrain();
  }

  reprioritizePending(priority: number): void {
    if (!Number.isFinite(priority)) throw new Error("task priority must be finite");
    for (const task of this.pending.values()) task.priority = priority;
  }

  reprioritizeAll(priority: number): void {
    this.reprioritizePending(priority);
    for (const task of this.active.values()) task.priority = priority;
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.pending.keys()) {
      if (!keys.has(key)) this.pending.delete(key);
    }
    for (const task of this.active.values()) {
      if (!keys.has(task.key)) {
        task.cancelled = true;
        task.controller.abort();
      }
    }
    this.resolveIdleIfNeeded();
  }

  clearPending(): void {
    this.pending.clear();
    this.resolveIdleIfNeeded();
  }

  whenIdle(): Promise<void> {
    if (this.running === 0 && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < this.concurrency && this.pending.size > 0) {
      const next = [...this.pending.values()].reduce((best, candidate) =>
        candidate.priority < best.priority || (candidate.priority === best.priority && candidate.order < best.order)
          ? candidate
          : best,
      );
      this.pending.delete(next.key);
      const active: ActiveTask = { ...next, controller: new AbortController(), preempted: false, cancelled: false };
      this.active.set(next.key, active);
      this.running += 1;
      let failed = false;
      void next.run(active.controller.signal).catch(() => {
        failed = true;
        // Individual task failures must not stop the shared queue.
      }).finally(() => {
        if (active.cancelled || (active.preempted && !failed)) this.pending.delete(next.key);
        this.active.delete(next.key);
        this.running -= 1;
        this.drain();
        this.resolveIdleIfNeeded();
      });
    }
    this.resolveIdleIfNeeded();
  }

  private preemptOneFor(priority: number): void {
    if (this.running < this.concurrency) return;
    let candidate: ActiveTask | undefined;
    for (const active of this.active.values()) {
      if (active.preempted || active.cancelled || active.priority <= priority) continue;
      if (!candidate || active.priority > candidate.priority ||
        (active.priority === candidate.priority && active.order < candidate.order)) candidate = active;
    }
    if (!candidate) return;
    candidate.preempted = true;
    this.pending.set(candidate.key, {
      key: candidate.key,
      priority: candidate.priority,
      order: this.nextOrder++,
      run: candidate.run,
    });
    candidate.controller.abort();
  }

  private resolveIdleIfNeeded(): void {
    if (this.running !== 0 || this.pending.size !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
