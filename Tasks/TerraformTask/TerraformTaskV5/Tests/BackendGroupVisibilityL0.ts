import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CLASS TEST — the classic editor must show the backend section `init` will use (#1305).
 *
 * `ParentCommandHandler.execute` selects the init handler from `backendType`, not
 * `provider` (backends and providers are decoupled), but the AzureRM, AWS, GCP and
 * OCI backend groups were shown by `provider = <cloud> && command = init`. A
 * cross-cloud init (`provider: aws`, `backendType: gcs`) therefore showed the S3
 * inputs and hid the GCS inputs the task actually read. `backendHCP` and
 * `backendGeneric` were already keyed on `backendType`, which is why the class is
 * "every backend group", not the four that were wrong.
 *
 * Derived from task.json: every group whose name starts with `backend` must be shown
 * by exactly `backendType = <option> && command = init`, for a distinct `backendType`
 * option, and every option except `local` (which has no inputs) must have its group.
 * The expected table pins which option each group answers to, mirroring
 * `ParentCommandHandler.createHandler`.
 *
 * Mutation-provability: restoring any one group's `provider = ...` rule turns that
 * group's row RED and no other.
 */

interface Group { name: string; visibleRule?: string }
interface Input { name: string; options?: Record<string, string> }

const taskJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'task.json'), 'utf8'),
) as { groups: Group[]; inputs: Input[] };

const BACKEND_GROUPS = taskJson.groups.filter((g) => g.name.startsWith('backend'));
const BACKEND_TYPE_OPTIONS = Object.keys(
    taskJson.inputs.find((i) => i.name === 'backendType')?.options ?? {},
);

/** backendType option -> the group holding the inputs its handler reads. */
const EXPECTED: ReadonlyMap<string, string> = new Map([
    ['azurerm', 'backendAzureRm'],
    ['s3', 'backendAWS'],
    ['gcs', 'backendGCP'],
    ['oci', 'backendOCI'],
    ['hcp', 'backendHCP'],
    ['generic', 'backendGeneric'],
]);

const RULE = /^backendType = ([a-z0-9]+) && command = init$/;

describe('Backend group visibility follows backendType (class test #1305)', () => {
    it('task.json declares backend groups and backendType options (the table is not vacuous)', () => {
        assert.ok(BACKEND_GROUPS.length > 0, 'no backend* groups found in task.json');
        assert.ok(BACKEND_TYPE_OPTIONS.length > 0, 'backendType declares no options');
    });

    for (const group of BACKEND_GROUPS) {
        it(`${group.name} is shown by backendType, not provider`, () => {
            const match = RULE.exec(group.visibleRule ?? '');
            assert.ok(match,
                `${group.name} has visibleRule ${JSON.stringify(group.visibleRule)}; expected ` +
                "'backendType = <option> && command = init'. init selects its handler from backendType, so a rule " +
                'keyed on provider shows the wrong backend inputs whenever the two differ.');
            const expectedGroup = EXPECTED.get(match![1]);
            assert.strictEqual(expectedGroup, group.name,
                `${group.name} is shown for backendType '${match![1]}', whose handler reads ${expectedGroup ?? 'no group'}'s inputs.`);
            assert.ok(BACKEND_TYPE_OPTIONS.includes(match![1]),
                `${group.name} keys on backendType '${match![1]}', which is not a backendType option.`);
        });
    }

    it('every backendType option except local has exactly one backend group', () => {
        const shownFor = BACKEND_GROUPS.map((g) => RULE.exec(g.visibleRule ?? '')?.[1]).filter(Boolean);
        for (const option of BACKEND_TYPE_OPTIONS.filter((o) => o !== 'local')) {
            assert.strictEqual(shownFor.filter((v) => v === option).length, 1,
                `backendType '${option}' is shown by ${shownFor.filter((v) => v === option).length} backend groups; expected 1.`);
        }
    });
});
