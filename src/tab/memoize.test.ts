import { memoizeOne } from "./memoize";

describe("memoizeOne", () => {
  it("returns the cached result while called with the same argument references", () => {
    const compute = jest.fn((items: number[]) => ({ total: items.reduce((a, b) => a + b, 0) }));
    const memo = memoizeOne(compute);
    const items = [1, 2, 3];

    const first = memo(items);
    expect(first).toEqual({ total: 6 });
    expect(memo(items)).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes when an argument's identity changes, even with equal contents", () => {
    const compute = jest.fn((items: number[]) => items.length);
    const memo = memoizeOne(compute);
    memo([1]);
    memo([1]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keeps only the most recent call", () => {
    const compute = jest.fn((items: number[]) => items.length);
    const memo = memoizeOne(compute);
    const a = [1];
    const b = [1, 2];
    memo(a);
    memo(b);
    memo(a);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("compares every argument", () => {
    const compute = jest.fn((items: number[], needle: string) => `${items.length}:${needle}`);
    const memo = memoizeOne(compute);
    const items = [1, 2];
    expect(memo(items, "x")).toBe("2:x");
    expect(memo(items, "y")).toBe("2:y");
    expect(memo(items, "y")).toBe("2:y");
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
