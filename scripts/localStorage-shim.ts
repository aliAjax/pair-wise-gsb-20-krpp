// 极简 localStorage 垫片，供 Node 自检使用
class MemStorage {
  private m = new Map<string, string>();
  getItem(key: string): string | null {
    return this.m.has(key) ? this.m.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, String(value));
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  clear(): void {
    this.m.clear();
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
