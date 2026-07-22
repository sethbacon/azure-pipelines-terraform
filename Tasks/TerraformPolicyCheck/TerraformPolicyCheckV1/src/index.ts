import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import fs = require('fs');
import { resolvePolicyDir } from './policy-source';
import { runOpa } from './opa-engine';
import { runSentinel } from './sentinel-engine';
import { writeResultsFile, writeJUnit, publishJUnit, writeSarif } from './results';
import { PolicyResult } from './types';

function cleanup(tempDirs: string[]): void {
    for (const dir of tempDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            tasks.debug(`Cleaned up temp dir: ${dir}`);
        } catch (err) {
            // A leftover temp dir (a cloned policy repo, which may be a private
            // source, or a generated Sentinel config dir) is a real exposure on a
            // self-hosted agent -- surface it above debug, matching
            // TerraformTaskV5's scrubAndUnlink rationale.
            tasks.warning(`Failed to clean up ${dir}: ${err}`);
        }
    }
}

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));
    const tempDirs: string[] = [];

    try {
        const engine = tasks.getInput('engine') || 'opa';

        const inputFile = path.resolve(tasks.getInput('inputFile', true)!);
        if (!fs.existsSync(inputFile)) {
            throw new Error(`Input file does not exist: ${inputFile}. Provide the JSON output of 'terraform show -json <plan>'.`);
        }

        const agentPath = tasks.getInput('policyAgentPath') || tasks.which(engine, true);
        const policyDir = await resolvePolicyDir(tempDirs);

        let result: PolicyResult;
        if (engine === 'sentinel') {
            result = await runSentinel(agentPath, policyDir, inputFile, tempDirs);
        } else {
            result = await runOpa(agentPath, policyDir, inputFile);
        }

        const resultsFilePath = writeResultsFile(result.rawOutput);
        tasks.setVariable('resultsFilePath', resultsFilePath, false, true);
        tasks.setVariable('violationCount', String(result.violations.length), false, true);
        tasks.setVariable('policyResult', result.passed ? 'passed' : 'failed', false, true);

        if (tasks.getBoolInput('publishTestResults', false) && result.cases.length > 0) {
            const xmlPath = writeJUnit(result.cases, engine);
            publishJUnit(xmlPath, engine);
        }

        if (tasks.getBoolInput('sarifOutput', false)) {
            const sarifFilePath = writeSarif(result, engine, tasks.getInput('sarifPath', false));
            tasks.setVariable('sarifFilePath', sarifFilePath, false, true);
        }

        if (result.passed) {
            const summary = result.violations.length > 0
                ? `Policy check passed (${result.violations.length} non-blocking finding(s)).`
                : 'Policy check passed.';
            tasks.setResult(tasks.TaskResult.Succeeded, summary);
        } else {
            tasks.setResult(tasks.TaskResult.Failed, `Policy check failed with ${result.violations.length} violation(s).`);
        }
    } catch (error) {
        tasks.setResult(tasks.TaskResult.Failed, error instanceof Error ? error.message : String(error));
    } finally {
        cleanup(tempDirs);
    }
}

void run();
