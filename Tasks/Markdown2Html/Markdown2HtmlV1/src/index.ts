import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { processFrontMatterDriven, processFileList, parseFileList } from './converter';

async function run(): Promise<void> {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));
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
                throw new Error('No input files provided.');
            }

            await processFileList(inputFiles, outPath, {
                title,
                addSections: sections,
                addDividers: dividers,
                debug,
            });
        }

        tasks.setVariable('htmlFilePath', outPath, false, true);
        tasks.setResult(tasks.TaskResult.Succeeded, `HTML written to '${outPath}'`);
    } catch (error) {
        tasks.setResult(
            tasks.TaskResult.Failed,
            error instanceof Error ? error.message : String(error)
        );
    }
}

void run();
