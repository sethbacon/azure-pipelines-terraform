import tseslint from 'typescript-eslint';
import { srcAndTestsConfig } from '../../eslint.base.mjs';

// TerraformTaskV5 lints its Tests/ tree too (with relaxed rules), same as
// every other task now that srcAndTestsConfig() covers both trees — its own
// extra src/ rule ('no-extra-semi') is merged in via extraSrcRules. The
// underlying rule sets are still the shared single source of truth in
// Tasks/eslint.base.mjs.
export default srcAndTestsConfig(tseslint, {
    extraSrcRules: {
        'no-extra-semi': 'error',
    },
});
