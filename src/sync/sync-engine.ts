import type { SyncCursors, SyncSummary, SyncUpdates } from "./model";
import { MirrorStore } from "./mirror-store";

export interface UpdatesSource {
  getUpdates(cursors: SyncCursors): Promise<SyncUpdates>;
}

export class SyncEngine {
  private active: Promise<SyncSummary> | undefined;

  constructor(
    private readonly source: UpdatesSource,
    private readonly store: MirrorStore,
  ) {}

  syncOnce(): Promise<SyncSummary> {
    this.active ??= this.run().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async run(): Promise<SyncSummary> {
    const cursors = await this.store.getCursors();
    const updates = await this.source.getUpdates(cursors);
    return this.store.applyUpdates(updates);
  }
}

