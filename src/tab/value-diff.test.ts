import { MAX_DIFF_ENTRIES, diffStructured } from "./value-diff";

describe("diffStructured", () => {
  it("lists changed, added and removed map keys, and counts the rest", () => {
    const diff = diffStructured('{"a":1,"b":2,"c":3}', '{"a":1,"b":5,"d":4}');
    expect(diff).toEqual({
      entries: [
        { kind: "changed", path: "b", before: 2, after: 5 },
        { kind: "removed", path: "c", value: 3 },
        { kind: "added", path: "d", value: 4 },
      ],
      more: 0,
      unchanged: 1,
      fromStrings: false,
    });
  });

  it("follows a single nested block down to the attribute that changed", () => {
    const diff = diffStructured('[{"worker_count":2,"always_on":true}]', '[{"worker_count":3,"always_on":true}]');
    expect(diff?.entries).toEqual([{ kind: "changed", path: "[0].worker_count", before: 2, after: 3 }]);
    expect(diff?.unchanged).toBe(1);
  });

  it("compares lists of different lengths as members added and removed", () => {
    const diff = diffStructured('["Microsoft.Storage"]', '["Microsoft.KeyVault","Microsoft.Storage"]');
    expect(diff?.entries).toEqual([{ kind: "added", path: "[]", value: "Microsoft.KeyVault" }]);
    expect(diff?.unchanged).toBe(1);
  });

  it("looks inside strings that hold JSON documents, such as policies", () => {
    const before = JSON.stringify(JSON.stringify({ Statement: [{ Effect: "Allow", Action: "s3:GetObject" }] }));
    const after = JSON.stringify(JSON.stringify({ Statement: [{ Effect: "Allow", Action: "s3:*" }] }));
    const diff = diffStructured(before, after);
    expect(diff?.fromStrings).toBe(true);
    expect(diff?.entries).toEqual([{ kind: "changed", path: "Statement[0].Action", before: "s3:GetObject", after: "s3:*" }]);
  });

  it("returns null for scalars, mismatched shapes and unparseable values", () => {
    expect(diffStructured('"a"', '"b"')).toBeNull();
    expect(diffStructured('{"a":1}', "[1]")).toBeNull();
    expect(diffStructured('{"a":1}', "null")).toBeNull();
    expect(diffStructured('{"a":1', '{"a":2}')).toBeNull();
    expect(diffStructured('"{not json"', '"{not json either"')).toBeNull();
  });

  it("reports no entries when only sensitive leaves differed before redaction", () => {
    const diff = diffStructured('{"password":"(sensitive)"}', '{"password":"(sensitive)"}');
    expect(diff?.entries).toEqual([]);
  });

  it("treats a __proto__ key as ordinary data", () => {
    const diff = diffStructured('{"__proto__":{"x":1}}', '{"__proto__":{"x":2}}');
    expect(diff?.entries).toEqual([{ kind: "changed", path: "__proto__.x", before: 1, after: 2 }]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("shows a value whole past the depth limit", () => {
    const deep = (leaf: number) => JSON.stringify({ a: { b: { c: { d: { e: leaf } } } } });
    const diff = diffStructured(deep(1), deep(2));
    expect(diff?.entries).toEqual([{ kind: "changed", path: "a.b.c.d", before: { e: 1 }, after: { e: 2 } }]);
  });

  it("caps the listed entries and counts the rest", () => {
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let i = 0; i < MAX_DIFF_ENTRIES + 5; i++) {
      before[`k${String(i).padStart(3, "0")}`] = 0;
      after[`k${String(i).padStart(3, "0")}`] = 1;
    }
    const diff = diffStructured(JSON.stringify(before), JSON.stringify(after));
    expect(diff?.entries).toHaveLength(MAX_DIFF_ENTRIES);
    expect(diff?.more).toBe(5);
  });
});
