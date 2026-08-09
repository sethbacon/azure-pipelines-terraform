import tasks = require('azure-pipelines-task-lib/task');

/**
 * Registers every non-empty line of a (possibly multi-line) credential with the
 * agent's log masker.
 *
 * `tasks.setSecret()` throws `LIB_MultilineSecret` when its argument contains a
 * CR or LF, so a whole PEM must never be handed to it in one piece: that call
 * throws and NOTHING ends up registered — the masking that was supposed to
 * cover the credential is what fails. ADO's masker also matches within a single
 * log line, so per-line registration is the only form that actually masks a
 * multi-line value. Boundary lines are kept (the UI passwordbox flattens a PEM
 * onto one line that itself starts with `-----BEGIN`, so that single "line" IS
 * the credential).
 */
export function maskSecretLines(value: string): void {
    for (const line of value.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
            tasks.setSecret(trimmed);
        }
    }
}

/**
 * Reads an ADO service-connection *data* parameter that carries credential
 * material, without letting the value reach the build log first.
 *
 * `tasks.getEndpointDataParameter()` cannot be used for a secret. task-lib's
 * implementation ends with
 *
 *     debug(id + ' data ' + key + ' = ' + dataParamVal);
 *
 * (azure-pipelines-task-lib/task.js, getEndpointDataParameter), so the raw value
 * is emitted as a `##vso[task.debug]` line at READ time — strictly before the
 * caller has any opportunity to `tasks.setSecret()` it. And unlike `INPUT_*`,
 * `ENDPOINT_AUTH_*`, `SECUREFILE_TICKET_*` and `SECRET_*`, `ENDPOINT_DATA_*` is
 * NOT in task-lib's `_loadData` vaulting list, so the value is neither
 * encrypted in-process, nor deleted from `process.env`, nor seeded into the
 * agent's masker at job start.
 *
 * This helper therefore:
 *   1. reads the same environment variable task-lib would read, bypassing that
 *      `debug()` call entirely;
 *   2. registers the value with the masker line-wise BEFORE returning it, so
 *      the first possible emission is already covered;
 *   3. deletes the variable so the raw credential is not inherited by the tool
 *      child process (packer/terraform) or by any plugin binary that process
 *      forks — which `EnvironmentVariableHelper.clearTrackedVariables()` cannot
 *      do, since it only clears variables this task set itself.
 *
 * Returns `undefined` when the parameter is absent or empty; the caller owns the
 * "missing credential" error message.
 */
export function readSecretEndpointDataParameter(serviceName: string, key: string): string | undefined {
    // Must match task-lib's own key derivation EXACTLY:
    // 'ENDPOINT_DATA_' + id + '_' + key.toUpperCase() — the id is used verbatim,
    // it is NOT upper-cased.
    const envName = `ENDPOINT_DATA_${serviceName}_${key.toUpperCase()}`;
    const value = process.env[envName];
    if (!value) {
        return undefined;
    }
    maskSecretLines(value);
    delete process.env[envName];
    return value;
}
