import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { processFrontMatterDriven, processFileList, parseFileList } from './converter';
import { migrationNotice } from './deprecation-notice';

async function run(): Promise<void> {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));

    // #1113: this task writes no sensitive temp file, so cleanup() is a
    // deliberate no-op -- the handler is still registered so a cancelled run
    // dies promptly instead of lingering (registering a signal listener
    // suppresses Node's default terminate-on-signal behavior, so the signal
    // must be re-raised with its default disposition after cleanup), and an
    // unawaited rejection anywhere in a helper no longer falls through to
    // Node's default handling with no tasks.setResult call and no
    // deterministic exit code.
    const cleanup = (): void => { /* No sensitive temp file/state to clean up today. */ };
    const handleTerminationSignal = (signal: NodeJS.Signals) => {
        cleanup();
        process.removeListener(signal, handleTerminationSignal);
        process.kill(process.pid, signal);
    };
    process.on('SIGTERM', handleTerminationSignal);
    process.on('SIGINT', handleTerminationSignal);
    process.on('uncaughtException', (err) => {
        cleanup();
        tasks.setResult(tasks.TaskResult.Failed, `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        cleanup();
        tasks.setResult(tasks.TaskResult.Failed, `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
        process.exit(1);
    });

    // Outside the try: a notice the catch could swallow would go quiet on
    // exactly the runs most likely to be someone's last with this task.
    tasks.warning(migrationNotice('Markdown2Html', 'PipelineMarkdown2Html'));
    try {
        const mode = tasks.getInput('mode', true)!;
        const outputFile = tasks.getInput('outputFile', true)!;
        const title = tasks.getInput('title', false) ?? 'Combined Markdown Files';
        const sections = tasks.getBoolInput('sections', false);
        const dividers = tasks.getBoolInput('dividers', false);
        const debug = tasks.getBoolInput('debug', false);

        const outPath = path.resolve(outputFile);

        if (mode === 'frontMatter') {
            const primaryFile = tasks.getInput('primaryFile', true)!;
            await processFrontMatterDriven(primaryFile, outPath, {
                titleOverride: title !== 'Combined Markdown Files' ? title : undefined,
                debug,
            });
        } else {
            // filelist mode
            const inputFilesRaw = tasks.getInput('inputFiles', true) ?? '';
            const inputFiles = parseFileList(inputFilesRaw);

            if (inputFiles.length === 0) {
                throw new Error(tasks.loc('NoInputFilesProvided'));
            }

            await processFileList(inputFiles, outPath, {
                title,
                addSections: sections,
                addDividers: dividers,
                debug,
            });
        }

        tasks.setVariable('htmlFilePath', outPath, false, true);
        tasks.setResult(tasks.TaskResult.Succeeded, tasks.loc('HtmlWrittenTo', outPath));
    } catch (error) {
        tasks.setResult(
            tasks.TaskResult.Failed,
            error instanceof Error ? error.message : String(error)
        );
    } finally {
        process.removeListener('SIGTERM', handleTerminationSignal);
        process.removeListener('SIGINT', handleTerminationSignal);
    }
}

void run();
