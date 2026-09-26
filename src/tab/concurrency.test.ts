import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("returns results in input order, whatever order they finish in", async () => {
    const delays = [30, 5, 15, 1];
    const results = await mapWithConcurrency(delays, 2, (ms, i) => new Promise<string>((resolve) => setTimeout(() => resolve(`r${i}`), ms)));
    expect(results).toEqual(["r0", "r1", "r2", "r3"]);
  });

  it("never runs more than `limit` calls at once, and keeps that many busy", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 9 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("handles an empty list and a limit larger than the list", async () => {
    await expect(mapWithConcurrency([], 4, async (x: number) => x)).resolves.toEqual([]);
    await expect(mapWithConcurrency([1, 2], 10, async (x) => x * 2)).resolves.toEqual([2, 4]);
  });
});
