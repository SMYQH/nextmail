export class LatestRequestGate {
  private generation = 0
  private scope: string | null = null

  begin(scope: string) {
    this.scope = scope
    const generation = ++this.generation
    return {
      isCurrent: () => this.scope === scope && this.generation === generation,
    }
  }

  invalidate() {
    this.generation += 1
    this.scope = null
  }
}
