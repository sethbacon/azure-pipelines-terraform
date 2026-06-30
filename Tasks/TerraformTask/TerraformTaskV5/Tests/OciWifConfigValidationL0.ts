import * as assert from 'assert';
import { validateOciTenancyOcid, validateOciRegion } from '../src/oci-terraform-command-handler';

/**
 * Direct unit tests for the OCI WIF synthetic-config field validation.
 * tenancyOcid and region are interpolated raw into an INI file consumed via
 * OCI_CLI_CONFIG_FILE — an embedded newline could inject or override config
 * keys (e.g. a crafted tenancy value introducing its own key_file= line).
 * Both inputs are author-controlled pipeline YAML, so this is defense in
 * depth matching the same OCID/region character set HashiCorp's own OCI
 * provider accepts, not a privilege-boundary fix.
 */
describe('OCI WIF synthetic-config field validation', function () {
    describe('validateOciTenancyOcid', () => {
        it('accepts a well-formed tenancy OCID', () => {
            const ocid = 'ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f44n2b2m2yt2j6rx32uzr4h25vqstifsfdsq';
            assert.strictEqual(validateOciTenancyOcid(ocid), ocid);
        });

        it('rejects a value with an embedded newline (INI key injection)', () => {
            assert.throws(() => validateOciTenancyOcid('ocid1.tenancy.oc1..abc\nkey_file=/etc/passwd'));
        });

        it('rejects a value that does not start with ocid1.tenancy.', () => {
            assert.throws(() => validateOciTenancyOcid('ocid1.user.oc1..abc'));
        });

        it('rejects embedded INI special characters', () => {
            assert.throws(() => validateOciTenancyOcid('ocid1.tenancy.oc1..abc]\n[other]'));
        });
    });

    describe('validateOciRegion', () => {
        it('accepts a well-formed region', () => {
            assert.strictEqual(validateOciRegion('us-ashburn-1'), 'us-ashburn-1');
        });

        it('rejects a value with an embedded newline', () => {
            assert.throws(() => validateOciRegion('us-ashburn-1\nfingerprint=evil'));
        });

        it('rejects uppercase or special characters', () => {
            assert.throws(() => validateOciRegion('US-Ashburn-1'));
            assert.throws(() => validateOciRegion('us-ashburn-1; rm -rf'));
        });
    });
});
