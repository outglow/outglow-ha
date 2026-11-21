export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey: string | null = null;
  present: T;

  constructor(
    initial: T,
    readonly limit = 100,
    private readonly equals: (a: T, b: T) => boolean = (a, b) => a === b,
  ) {
    this.present = initial;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get key(): string | null {
    return this.lastKey;
  }

  get depth(): number {
    return this.past.length;
  }

  push(next: T, key: string | null = null): void {
    if (this.equals(next, this.present)) {
      return;
    }
    if (key !== null && key === this.lastKey && this.past.length > 0) {
      const start = this.past[this.past.length - 1]!;
      this.future = [];
      if (this.equals(next, start)) {
        this.past.pop();
        this.present = start;
        this.lastKey = null;
        return;
      }
      this.present = next;
      return;
    }
    this.past.push(this.present);
    if (this.past.length > this.limit) {
      this.past.splice(0, this.past.length - this.limit);
    }
    this.present = next;
    this.future = [];
    this.lastKey = key;
  }

  undo(): T {
    const previous = this.past.pop();
    if (previous !== undefined) {
      this.future.push(this.present);
      this.present = previous;
    }
    this.lastKey = null;
    return this.present;
  }

  redo(): T {
    const next = this.future.pop();
    if (next !== undefined) {
      this.past.push(this.present);
      this.present = next;
    }
    this.lastKey = null;
    return this.present;
  }

  seal(): void {
    this.lastKey = null;
  }

  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.lastKey = null;
    this.present = value;
  }
}
