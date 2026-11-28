import type { LibraryPin } from "./libraryLocationPin";

export type LibraryMonitoringReview = {
  library: string;
  previousRoot?: string;
  entry: string;
  reason: string;
  isCurrent(): boolean;
  review(): LibraryPin | undefined;
  approve(proposal: LibraryPin): boolean;
  reject(): void;
};

type ShowWarning = (message: string, detail: string | undefined, actions: string[]) => PromiseLike<string | undefined>;
const REVIEW = "Review New Location";
const STOP = "Stop Monitoring";
const TRUST = "Trust and Resume";
const REJECT = "Reject";
const CHECK = "Check Location Again";

/** Group simultaneous changes to a shared ancestor, without blocking inventory
 * work on a UI decision. Each library still needs its own explicit approval. */
export class LibraryMonitoringNotices {
  private pending: LibraryMonitoringReview[] = [];
  private queued = false;

  constructor(private readonly show: ShowWarning) {}

  enqueue(request: LibraryMonitoringReview): void {
    this.pending.push(request);
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      const groups = new Map<string, LibraryMonitoringReview[]>();
      for (const item of this.pending.splice(0)) {
        if (!item.isCurrent()) continue;
        const key = JSON.stringify([item.entry, item.reason]);
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
      }
      for (const group of groups.values()) void this.notify(group).catch(() => {});
    });
  }

  private async notify(group: LibraryMonitoringReview[]): Promise<void> {
    const first = group[0];
    const libraries = group.map(item => item.library).join(", ");
    const answer = await this.show(`R Console: ${first.reason}: ${first.entry}. ` +
      `Affected ${group.length === 1 ? "library" : "libraries"}: ${libraries}. ` +
      "Monitoring suspended; your R session is unaffected.", undefined, [REVIEW, STOP]);
    if (answer !== REVIEW) {
      for (const item of group) item.reject();
      return;
    }
    for (const item of group) await this.review(item);
  }

  private async review(item: LibraryMonitoringReview): Promise<void> {
    while (item.isCurrent()) {
      let proposal: LibraryPin | undefined;
      try { proposal = item.review(); }
      catch {
        if (!item.isCurrent()) return;
        const retry = await this.show(`R Console: Library location unavailable: ${item.library}`,
          "No verified replacement location is available. Monitoring remains suspended.", [CHECK, STOP]);
        if (retry !== CHECK) { item.reject(); return; }
        continue;
      }
      if (!proposal || !item.isCurrent()) return;
      const previous = item.previousRoot ?? "Not yet pinned";
      const answer = await this.show("R Console: Trust new library location?",
        `${item.library !== previous ? `Library: ${item.library}\n` : ""}Previously pinned: ${previous}\nNew location: ${proposal.root}\nReason: ${item.reason} (${item.entry})`,
        [REJECT, TRUST]);
      if (answer !== TRUST) { item.reject(); return; }
      if (!item.isCurrent()) return;
      if (item.approve(proposal)) return;
      if (!item.isCurrent()) return;
      const retry = await this.show("R Console: Reviewed library location changed or is unavailable.",
        "Monitoring remains suspended. Review the current location before trusting it.", [REVIEW, STOP]);
      if (retry !== REVIEW) { item.reject(); return; }
    }
  }
}
