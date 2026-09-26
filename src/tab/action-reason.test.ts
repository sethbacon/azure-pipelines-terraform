import { describeActionReason } from "./action-reason";

describe("describeActionReason", () => {
  it.each([
    ["replace_because_cannot_update", "must be replaced"],
    ["replace_because_tainted", "tainted, so must be replaced"],
    ["replace_by_request", "replaced as requested (-replace)"],
    ["replace_by_triggers", "replaced by replace_triggered_by"],
    ["delete_because_no_resource_config", "no longer in configuration"],
    ["delete_because_no_module", "its module is no longer in configuration"],
    ["delete_because_wrong_repetition", "count or for_each changed for this resource"],
    ["delete_because_count_index", "count index is out of range"],
    ["delete_because_each_key", "for_each key is no longer present"],
    ["delete_because_no_move_target", "moved to an address that doesn't exist"],
    ["read_because_config_unknown", "read during apply: its configuration depends on unknown values"],
    ["read_because_dependency_pending", "read during apply: it depends on pending changes"],
    ["read_because_check_nested", "read during apply: a check block refers to it"],
  ])("describes %s as %p", (code, text) => {
    expect(describeActionReason(code)).toBe(text);
  });

  it("passes an unknown code through unchanged, including one named after an Object property", () => {
    expect(describeActionReason("replace_because_future_reason")).toBe("replace_because_future_reason");
    expect(describeActionReason("toString")).toBe("toString");
    expect(describeActionReason("__proto__")).toBe("__proto__");
  });
});
