import { parseDigestText } from "./digest-model";
import * as caps from "./caps";

/** A minimal, schema-valid v1 plan digest. */
function validPlanDigestObj(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "plan",
    producedBy: { task: "TerraformTaskV5", taskVersion: "5.12.0" },
    tool: { name: "terraform", version: "1.14.6" },
    meta: {
      name: "plan-main",
      workingDirectory: "infra/prod",
      stage: "Deploy",
      job: "TerraformPlan",
      createdIso: "2026-07-01T12:00:00.000Z",
    },
    truncated: false,
    summary: { add: 2, change: 1, destroy: 0, replace: 0, read: 0, noChanges: false, driftDetected: false },
    resources: [
      {
        address: "aws_instance.web",
        type: "aws_instance",
        name: "web",
        providerName: "registry.terraform.io/hashicorp/aws",
        actions: ["create"],
        attributeChanges: [
          { path: "instance_type", before: { kind: "unknown" }, after: { kind: "value", json: '"t3.micro"' } },
          { path: "password", before: { kind: "unknown" }, after: { kind: "sensitive" } },
        ],
      },
    ],
    outputChanges: [{ name: "db_password", action: "create", value: { kind: "sensitive" } }],
  };
}

/** A minimal, schema-valid v1 apply digest. */
function validApplyDigestObj(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "apply",
    producedBy: { task: "TerraformTaskV5", taskVersion: "5.12.0" },
    tool: { name: "terraform", version: "1.14.6" },
    meta: { name: "apply-main", createdIso: "2026-07-01T12:05:00.000Z" },
    truncated: false,
    outcome: "succeeded",
    summary: { add: 1, change: 0, destroy: 0, durationMs: 4321 },
    resources: [{ address: "aws_instance.web", action: "create", status: "complete", durationMs: 1200 }],
    diagnostics: [],
    outputs: [{ name: "db_password", action: "create", value: { kind: "sensitive" } }],
  };
}

function json(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("parseDigestText — valid v1 digests", () => {
  it("parses a valid v1 plan digest into a typed object", () => {
    const result = parseDigestText(json(validPlanDigestObj()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownVersion).toBe(false);
    expect(result.detectedSchemaVersion).toBe(1);
    expect(result.digest.kind).toBe("plan");
    if (result.digest.kind !== "plan") return;
    expect(result.digest.summary.add).toBe(2);
    expect(result.digest.resources).toHaveLength(1);
    expect(result.digest.resources[0].address).toBe("aws_instance.web");
    expect(result.digest.resources[0].attributeChanges[0].after).toEqual({ kind: "value", json: '"t3.micro"' });
    expect(result.digest.resources[0].attributeChanges[1].after).toEqual({ kind: "sensitive" });
    expect(result.digest.meta.name).toBe("plan-main");
  });

  it("parses a valid v1 apply digest into a typed object", () => {
    const result = parseDigestText(json(validApplyDigestObj()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownVersion).toBe(false);
    expect(result.digest.kind).toBe("apply");
    if (result.digest.kind !== "apply") return;
    expect(result.digest.outcome).toBe("succeeded");
    expect(result.digest.resources[0].status).toBe("complete");
    expect(result.digest.outputs[0].value).toEqual({ kind: "sensitive" });
  });

  it("is deterministic: parsing the same input twice yields deep-equal digests", () => {
    const raw = json(validPlanDigestObj());
    const a = parseDigestText(raw);
    const b = parseDigestText(raw);
    expect(a).toEqual(b);
  });
});

describe("parseDigestText — malformed JSON", () => {
  it("returns a malformed-json failure without throwing", () => {
    expect(() => parseDigestText("{ not valid json")).not.toThrow();
    const result = parseDigestText("{ not valid json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed-json");
  });

  it("rejects a non-object JSON root (array/primitive) without throwing", () => {
    expect(parseDigestText("42").ok).toBe(false);
    expect(parseDigestText("[1,2,3]").ok).toBe(false);
    expect(parseDigestText("null").ok).toBe(false);
    expect(parseDigestText('"just a string"').ok).toBe(false);
  });
});

describe("parseDigestText — oversize refusal (parse ceiling)", () => {
  it("refuses a digest over the tab parse ceiling using an explicit byte length, before JSON.parse runs", () => {
    const parseSpy = jest.spyOn(JSON, "parse");
    const result = parseDigestText("{}", caps.TAB_PARSE_CEILING_BYTES + 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("oversize");
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it("refuses an oversize digest even without an explicit byte length (measures the raw text)", () => {
    const huge = json({ ...validPlanDigestObj(), padding: "x".repeat(caps.TAB_PARSE_CEILING_BYTES) });
    const result = parseDigestText(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("oversize");
  });

  it("accepts a digest comfortably under the ceiling", () => {
    const result = parseDigestText(json(validPlanDigestObj()), 1024);
    expect(result.ok).toBe(true);
  });
});

describe("parseDigestText — prototype-pollution keys", () => {
  it("rejects a digest with a top-level __proto__ key and never pollutes Object.prototype", () => {
    const malicious = { ...validPlanDigestObj(), __proto__: { polluted: true } };
    // Constructing the object above via object-literal spread with a literal
    // "__proto__" key sets the *actual* prototype in JS semantics, not an own
    // property — so build the attack the way an attacker actually would: via
    // JSON, where "__proto__" becomes a genuine own property (see digest-model
    // comments for why JSON.parse's own-property semantics differ from object
    // literals).
    const raw = '{"__proto__":{"polluted":true},' + json(validPlanDigestObj()).slice(1);
    const result = parseDigestText(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsafe-keys");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    void malicious;
  });

  it("rejects a digest with a nested constructor/prototype key deep inside the resource array", () => {
    const obj = validPlanDigestObj();
    (obj.resources as unknown[]).push({ constructor: { prototype: { polluted: true } } });
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsafe-keys");
  });
});

describe("parseDigestText — unknown newer schemaVersion", () => {
  it("degrades gracefully (no crash) on a far-future schemaVersion and signals a partial render", () => {
    const obj = { ...validPlanDigestObj(), schemaVersion: 999 };
    expect(() => parseDigestText(json(obj))).not.toThrow();
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownVersion).toBe(true);
    expect(result.detectedSchemaVersion).toBe(999);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.digest.kind).toBe("plan");
  });

  it("degrades gracefully even when a schemaVersion:999 digest is missing most fields, still requiring only `kind`", () => {
    const raw = json({ schemaVersion: 999, kind: "apply" });
    expect(() => parseDigestText(raw)).not.toThrow();
    const result = parseDigestText(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownVersion).toBe(true);
    expect(result.digest.kind).toBe("apply");
    if (result.digest.kind !== "apply") return;
    expect(result.digest.resources).toEqual([]);
    expect(result.digest.diagnostics).toEqual([]);
  });

  it("fails safely (not a throw) when even `kind` is unrecognizable on an unknown schemaVersion", () => {
    const raw = json({ schemaVersion: 999, kind: "state-inventory" });
    const result = parseDigestText(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported-kind");
  });
});

describe("parseDigestText — unsupported kind", () => {
  it("rejects a digest whose kind is neither plan nor apply", () => {
    const result = parseDigestText(json({ ...validPlanDigestObj(), kind: "destroy" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported-kind");
  });
});

describe("parseDigestText — missing/typo'd required fields (v1, rejected safely)", () => {
  it("rejects a v1 plan digest missing `summary` entirely, rather than rendering undefined", () => {
    const obj = validPlanDigestObj();
    delete obj.summary;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-envelope");
  });

  it("rejects a v1 plan digest missing `resources` entirely", () => {
    const obj = validPlanDigestObj();
    delete obj.resources;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-envelope");
  });

  it("rejects a v1 apply digest missing `diagnostics` entirely", () => {
    const obj = validApplyDigestObj();
    delete obj.diagnostics;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-envelope");
  });

  it("rejects a v1 digest missing the `meta` envelope object", () => {
    const obj = validPlanDigestObj();
    delete obj.meta;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(false);
  });
});

describe("parseDigestText — RedactedValue fail-closed on shape mismatch", () => {
  it("masks (never renders) a RedactedValue claiming kind:\"value\" with no json string", () => {
    const obj = validPlanDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].attributeChanges = [
      { path: "secret_url", before: { kind: "unknown" }, after: { kind: "value" } },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources[0].attributeChanges[0].after).toEqual({ kind: "sensitive" });
    expect(result.notes.some((n: string) => n.includes("fail-closed") || n.toLowerCase().includes("masked"))).toBe(true);
  });

  it("masks a RedactedValue with an unrecognized kind rather than passing it through", () => {
    const obj = validPlanDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].attributeChanges = [
      { path: "x", before: { kind: "unknown" }, after: { kind: "totally-new-kind", raw: "leaked-secret" } },
    ];
    const raw = json(obj);
    expect(raw).toContain("leaked-secret");
    const result = parseDigestText(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources[0].attributeChanges[0].after).toEqual({ kind: "sensitive" });
    // The unrecognized shape must never be echoed anywhere in the parsed digest.
    expect(JSON.stringify(result.digest)).not.toContain("leaked-secret");
  });

  it("defensively truncates an oversize RedactedValue.json beyond the redacted-value byte cap", () => {
    const obj = validPlanDigestObj();
    const oversizedJson = JSON.stringify("x".repeat(caps.MAX_REDACTED_VALUE_BYTES + 500));
    (obj.resources as Array<Record<string, unknown>>)[0].attributeChanges = [
      { path: "big", before: { kind: "unknown" }, after: { kind: "value", json: oversizedJson } },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    const after = result.digest.resources[0].attributeChanges[0].after;
    expect(after.kind).toBe("value");
    if (after.kind !== "value") return;
    expect(after.json.length).toBeLessThanOrEqual(caps.MAX_REDACTED_VALUE_BYTES + 32);
  });
});

describe("parseDigestText — defensive tab-side caps (§6, don't trust `truncated`)", () => {
  it("caps the resources array at MAX_RESOURCES even when the digest claims truncated:false", () => {
    const obj = validPlanDigestObj();
    const template = (obj.resources as unknown[])[0] as Record<string, unknown>;
    obj.resources = Array.from({ length: caps.MAX_RESOURCES + 5 }, (_, i) => ({
      ...template,
      address: `aws_instance.web[${i}]`,
    }));
    obj.truncated = false;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources).toHaveLength(caps.MAX_RESOURCES);
    expect(result.digest.truncated).toBe(true);
  });

  it("caps attributeChanges per resource at MAX_ATTR_CHANGES_PER_RESOURCE", () => {
    const obj = validPlanDigestObj();
    const many = Array.from({ length: caps.MAX_ATTR_CHANGES_PER_RESOURCE + 3 }, (_, i) => ({
      path: `attr_${i}`,
      before: { kind: "unknown" },
      after: { kind: "value", json: String(i) },
    }));
    (obj.resources as Array<Record<string, unknown>>)[0].attributeChanges = many;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources[0].attributeChanges).toHaveLength(caps.MAX_ATTR_CHANGES_PER_RESOURCE);
  });

  it("caps diagnostics at MAX_DIAGNOSTICS", () => {
    const obj = validApplyDigestObj();
    obj.diagnostics = Array.from({ length: caps.MAX_DIAGNOSTICS + 10 }, (_, i) => ({
      severity: "warning",
      summary: `warn ${i}`,
    }));
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "apply") return;
    expect(result.digest.diagnostics).toHaveLength(caps.MAX_DIAGNOSTICS);
  });

  it("caps plan outputChanges at MAX_OUTPUTS and marks truncated", () => {
    const obj = validPlanDigestObj();
    obj.outputChanges = Array.from({ length: caps.MAX_OUTPUTS + 7 }, (_, i) => ({
      name: `o${i}`,
      action: "create",
      value: { kind: "value", json: String(i) },
    }));
    obj.truncated = false;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok || result.digest.kind !== "plan") return;
    expect(result.digest.outputChanges).toHaveLength(caps.MAX_OUTPUTS);
    expect(result.digest.truncated).toBe(true);
    expect((result.digest.truncationNotes ?? []).some((n) => n.includes("output list capped"))).toBe(true);
  });

  it("caps plan drift at MAX_DRIFT and marks truncated", () => {
    const obj = validPlanDigestObj();
    obj.drift = Array.from({ length: caps.MAX_DRIFT + 3 }, (_, i) => ({
      address: `aws_instance.drift[${i}]`,
      type: "aws_instance",
      name: "drift",
      providerName: "p",
      attributeChanges: [],
    }));
    obj.truncated = false;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok || result.digest.kind !== "plan") return;
    expect(result.digest.drift).toHaveLength(caps.MAX_DRIFT);
    expect(result.digest.truncated).toBe(true);
    expect((result.digest.truncationNotes ?? []).some((n) => n.includes("drift list capped"))).toBe(true);
  });

  it("caps apply outputs at MAX_OUTPUTS and marks truncated", () => {
    const obj = validApplyDigestObj();
    obj.outputs = Array.from({ length: caps.MAX_OUTPUTS + 4 }, (_, i) => ({
      name: `o${i}`,
      action: "create",
      value: { kind: "value", json: String(i) },
    }));
    obj.truncated = false;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok || result.digest.kind !== "apply") return;
    expect(result.digest.outputs).toHaveLength(caps.MAX_OUTPUTS);
    expect(result.digest.truncated).toBe(true);
  });

  it("caps appliedBeforeFailure at MAX_RESOURCES", () => {
    const obj = validApplyDigestObj();
    obj.outcome = "failed";
    obj.appliedBeforeFailure = Array.from({ length: caps.MAX_RESOURCES + 6 }, (_, i) => `r.${i}`);
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok || result.digest.kind !== "apply") return;
    expect(result.digest.appliedBeforeFailure).toHaveLength(caps.MAX_RESOURCES);
    expect(result.notes.some((n) => n.includes("appliedBeforeFailure capped"))).toBe(true);
  });

  it("caps a hostile truncationNotes array at MAX_NOTES", () => {
    const obj = validPlanDigestObj();
    obj.truncated = true;
    obj.truncationNotes = Array.from({ length: caps.MAX_NOTES + 25 }, (_, i) => `note ${i}`);
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.digest.truncationNotes ?? []).length).toBeLessThanOrEqual(caps.MAX_NOTES);
    expect(result.notes.some((n) => n.includes("truncationNotes capped"))).toBe(true);
  });
});

describe("parseDigestText — drift resources (resource_drift)", () => {
  it("parses a valid drift entry, masking sensitive drifted attributes", () => {
    const obj = validPlanDigestObj();
    obj.drift = [
      {
        address: "aws_instance.drifted",
        type: "aws_instance",
        name: "drifted",
        providerName: "registry.terraform.io/hashicorp/aws",
        attributeChanges: [
          { path: "tags.owner", before: { kind: "value", json: '"alice"' }, after: { kind: "value", json: '"bob"' } },
          { path: "password", before: { kind: "unknown" }, after: { kind: "sensitive" } },
        ],
      },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.drift).toHaveLength(1);
    expect(result.digest.drift?.[0].address).toBe("aws_instance.drifted");
    expect(result.digest.drift?.[0].attributeChanges[1].after).toEqual({ kind: "sensitive" });
  });

  it("skips a drift entry that is not an object, and one missing an address", () => {
    const obj = validPlanDigestObj();
    obj.drift = ["not-an-object", { type: "aws_instance", name: "no-address" }];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.drift).toEqual([]);
  });

  it("caps a drift entry's attributeChanges at MAX_ATTR_CHANGES_PER_RESOURCE", () => {
    const obj = validPlanDigestObj();
    const many = Array.from({ length: caps.MAX_ATTR_CHANGES_PER_RESOURCE + 2 }, (_, i) => ({
      path: `attr_${i}`,
      before: { kind: "unknown" },
      after: { kind: "value", json: String(i) },
    }));
    obj.drift = [
      { address: "aws_instance.drifted", type: "aws_instance", name: "drifted", providerName: "x", attributeChanges: many },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.drift?.[0].attributeChanges).toHaveLength(caps.MAX_ATTR_CHANGES_PER_RESOURCE);
  });

  it("omits `drift` entirely when the field is absent (it is optional)", () => {
    const result = parseDigestText(json(validPlanDigestObj()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.drift).toBeUndefined();
  });
});

describe("parseDigestText — remaining field/element coercion branches", () => {
  it("carries replacePaths through for a resource forced to replace", () => {
    const obj = validPlanDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].actions = ["delete", "create"];
    (obj.resources as Array<Record<string, unknown>>)[0].replacePaths = ["ami", "availability_zone"];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources[0].replacePaths).toEqual(["ami", "availability_zone"]);
  });

  it("carries appliedBeforeFailure through for a partially-failed apply", () => {
    const obj = validApplyDigestObj();
    obj.appliedBeforeFailure = ["aws_instance.a", "aws_instance.b"];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "apply") return;
    expect(result.digest.appliedBeforeFailure).toEqual(["aws_instance.a", "aws_instance.b"]);
  });

  it("masks a RedactedValue that is not an object at all (e.g. a bare string or null)", () => {
    const obj = validPlanDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].attributeChanges = [
      { path: "weird", before: "not-an-object", after: null },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    const change = result.digest.resources[0].attributeChanges[0];
    expect(change.before).toEqual({ kind: "sensitive" });
    expect(change.after).toEqual({ kind: "sensitive" });
  });

  it('passes through an "omitted" RedactedValue as-is', () => {
    const obj = validPlanDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].attributeChanges = [
      { path: "huge", before: { kind: "unknown" }, after: { kind: "omitted", reason: "too-large" } },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources[0].attributeChanges[0].after).toEqual({ kind: "omitted", reason: "too-large" });
  });

  it("skips a plan resource array element that is not an object", () => {
    const obj = validPlanDigestObj();
    (obj.resources as unknown[]).push("not-an-object");
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources).toHaveLength(1);
  });

  it("treats an actions array with only unrecognized strings as empty, with a note", () => {
    const obj = validPlanDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].actions = ["totally-bogus"];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources[0].actions).toEqual([]);
    expect(result.notes.some((n) => n.includes("no recognized action"))).toBe(true);
  });

  it("skips an attributeChanges element that is not an object", () => {
    const obj = validPlanDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].attributeChanges = ["not-an-object"];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources[0].attributeChanges).toEqual([]);
  });

  it('skips an attributeChanges element missing "path"', () => {
    const obj = validPlanDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].attributeChanges = [
      { before: { kind: "unknown" }, after: { kind: "unknown" } },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources[0].attributeChanges).toEqual([]);
  });

  it("skips an outputChanges element that is not an object, one missing a name, and one with an unrecognized action", () => {
    const obj = validPlanDigestObj();
    obj.outputChanges = [
      "not-an-object",
      { action: "create", value: { kind: "unknown" } },
      { name: "bad_action", action: "bogus", value: { kind: "unknown" } },
      { name: "good", action: "update", value: { kind: "unknown" } },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.outputChanges).toEqual([{ name: "good", action: "update", value: { kind: "unknown" } }]);
  });

  it("defensively caps apply resources at MAX_RESOURCES", () => {
    const obj = validApplyDigestObj();
    const template = (obj.resources as unknown[])[0] as Record<string, unknown>;
    obj.resources = Array.from({ length: caps.MAX_RESOURCES + 5 }, (_, i) => ({
      ...template,
      address: `aws_instance.web[${i}]`,
    }));
    obj.truncated = false;
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "apply") return;
    expect(result.digest.resources).toHaveLength(caps.MAX_RESOURCES);
    expect(result.digest.truncated).toBe(true);
  });

  it("skips an apply resource array element that is not an object, and one missing an address", () => {
    const obj = validApplyDigestObj();
    (obj.resources as unknown[]).push("not-an-object", { action: "create", status: "complete" });
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "apply") return;
    expect(result.digest.resources).toHaveLength(1);
  });

  it("defaults an apply resource's status to \"started\" when missing/unrecognized", () => {
    const obj = validApplyDigestObj();
    (obj.resources as Array<Record<string, unknown>>)[0].status = "bogus-status";
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "apply") return;
    expect(result.digest.resources[0].status).toBe("started");
  });

  it("skips a diagnostic element that is not an object, one with a missing/unrecognized severity, and one missing summary", () => {
    const obj = validApplyDigestObj();
    obj.diagnostics = [
      "not-an-object",
      { severity: "critical", summary: "bad severity" },
      { severity: "error" },
      { severity: "warning", summary: "kept" },
    ];
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "apply") return;
    expect(result.digest.diagnostics).toEqual([{ severity: "warning", summary: "kept", detail: undefined, address: undefined }]);
  });
});

describe("parseDigestText — malformed array elements are skipped, not fatal", () => {
  it("skips a resource missing its address, keeping the other valid resources", () => {
    const obj = validPlanDigestObj();
    (obj.resources as unknown[]).push({ type: "aws_instance", name: "no-address" });
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "plan") return;
    expect(result.digest.resources).toHaveLength(1);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("skips an apply resource missing a recognizable action", () => {
    const obj = validApplyDigestObj();
    (obj.resources as unknown[]).push({ address: "aws_instance.bad", action: "not-a-real-action", status: "complete" });
    const result = parseDigestText(json(obj));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.digest.kind !== "apply") return;
    expect(result.digest.resources).toHaveLength(1);
  });

  it("does not crash when an array field itself is the wrong JSON type (e.g. resources is an object)", () => {
    const obj = validPlanDigestObj();
    obj.resources = { not: "an array" };
    expect(() => parseDigestText(json(obj))).not.toThrow();
  });
});
