import { TERRAFORM_TASK_ID, buildOriginLookup, compareOrigins, formatOrigin, parseAttachmentHref, TimelineRecordLike } from "./origin";

const TIMELINE_ID = "11111111-1111-1111-1111-111111111111";
const STAGE_PROD = "aaaaaaaa-0000-0000-0000-000000000001";
const STAGE_TEST = "aaaaaaaa-0000-0000-0000-000000000002";
const PHASE = "bbbbbbbb-0000-0000-0000-000000000001";
const JOB = "cccccccc-0000-0000-0000-000000000001";
const JOB_TEST = "cccccccc-0000-0000-0000-000000000002";
const STEP_TF = "dddddddd-0000-0000-0000-000000000001";
const STEP_SCRIPT = "dddddddd-0000-0000-0000-000000000002";
const STEP_TEST = "dddddddd-0000-0000-0000-000000000003";
const BASE = "https://dev.example.test/org/proj";

function href(recordId: string): string {
  return `${BASE}/_apis/build/builds/42/${TIMELINE_ID}/${recordId}/attachments/terraform-plan-summary/prod`;
}

const RECORDS: TimelineRecordLike[] = [
  { id: STAGE_PROD, type: "Stage", name: "Plan prod", order: 2 },
  { id: STAGE_TEST, type: "Stage", name: "Plan test", order: 1 },
  { id: PHASE, parentId: STAGE_PROD, type: "Phase", name: "Plan", order: 1 },
  { id: JOB, parentId: PHASE, type: "Job", name: "Plan", order: 1 },
  { id: STEP_TF, parentId: JOB, type: "Task", name: "Terraform plan", order: 5, task: { id: TERRAFORM_TASK_ID.toUpperCase() } },
  { id: STEP_SCRIPT, parentId: JOB, type: "Task", name: "Bash", order: 6, task: { id: "6c731c3c-3c68-459a-a5c9-bde6e6595b5b" } },
  { id: JOB_TEST, parentId: STAGE_TEST, type: "Job", name: "Plan test", order: 1 },
  { id: STEP_TEST, parentId: JOB_TEST, type: "Task", name: "Terraform plan", order: 3, task: { id: TERRAFORM_TASK_ID } },
];

describe("parseAttachmentHref", () => {
  it("reads the collection/project base and the publishing record from an attachment URL", () => {
    expect(parseAttachmentHref(href(STEP_TF))).toEqual({ base: BASE, recordId: STEP_TF });
  });

  it("keeps an on-premises collection path in the base", () => {
    const onPrem = `https://tfs.example.test/tfs/DefaultCollection/proj/_apis/build/builds/7/${TIMELINE_ID}/${STEP_TF}/attachments/t/n`;
    expect(parseAttachmentHref(onPrem)?.base).toBe("https://tfs.example.test/tfs/DefaultCollection/proj");
  });

  it("rejects anything that isn't an http(s) attachment URL", () => {
    expect(parseAttachmentHref("not a url")).toBeNull();
    expect(parseAttachmentHref(`javascript:${href(STEP_TF)}`)).toBeNull();
    expect(parseAttachmentHref(`${BASE}/_apis/build/builds/42/attachments/terraform-plan-summary`)).toBeNull();
    expect(parseAttachmentHref(`${BASE}/_apis/build/builds/42/${TIMELINE_ID}/not-a-guid/attachments/t/n`)).toBeNull();
  });
});

describe("buildOriginLookup", () => {
  const originOf = buildOriginLookup(RECORDS, 42);

  it("names the stage, job and step that published the attachment, and links its log", () => {
    expect(originOf(href(STEP_TF))).toEqual({
      stage: "Plan prod",
      job: "Plan",
      step: "Terraform plan",
      fromTerraformTask: true,
      orderPath: [2, 1, 1, 5],
      logUrl: `${BASE}/_build/results?buildId=42&view=logs&j=${JOB}&t=${STEP_TF}`,
    });
  });

  it("flags a step that isn't the Terraform task", () => {
    expect(originOf(href(STEP_SCRIPT))).toMatchObject({ step: "Bash", fromTerraformTask: false });
  });

  it("has no origin for a record that isn't in the timeline or a URL that doesn't parse", () => {
    expect(originOf(href("eeeeeeee-0000-0000-0000-000000000009"))).toBeUndefined();
    expect(originOf("fixture://terraform-plan-summary/prod")).toBeUndefined();
  });

  it("survives a cyclic parent chain", () => {
    const cyclic = buildOriginLookup(
      [
        { id: STAGE_PROD, parentId: STEP_TF, type: "Stage", name: "S", order: 1 },
        { id: STEP_TF, parentId: STAGE_PROD, type: "Task", name: "T", order: 1 },
      ],
      42
    );
    expect(cyclic(href(STEP_TF))).toMatchObject({ stage: "S", step: "T", logUrl: undefined });
  });
});

describe("compareOrigins and formatOrigin", () => {
  const originOf = buildOriginLookup(RECORDS, 42);

  it("orders by position in the run, and puts items without an origin last", () => {
    const prod = originOf(href(STEP_TF));
    const test = originOf(href(STEP_TEST));
    expect(compareOrigins(test, prod)).toBeLessThan(0);
    expect(compareOrigins(prod, undefined)).toBeLessThan(0);
    expect(compareOrigins(undefined, prod)).toBeGreaterThan(0);
    expect(compareOrigins(undefined, undefined)).toBe(0);
    expect(compareOrigins(prod, prod)).toBe(0);
  });

  it("joins the levels it has", () => {
    expect(formatOrigin(originOf(href(STEP_TF))!)).toBe("Plan prod › Plan › Terraform plan");
    expect(formatOrigin({ step: "Only step", fromTerraformTask: true, orderPath: [] })).toBe("Only step");
  });
});
