/** Require two matching observations before offering a changed build. */
export class SourceRefreshGate {
  private observed?: string;
  private rejected?: string;
  observe(current: string | undefined, revision: string): boolean {
    if (!current || revision === current || revision === this.rejected) {
      this.observed = undefined;
      return false;
    }
    if (this.observed !== revision) {
      this.observed = revision;
      return false;
    }
    this.observed = undefined;
    return true;
  }
  reject(revision: string): void {
    this.rejected = revision;
  }
}
