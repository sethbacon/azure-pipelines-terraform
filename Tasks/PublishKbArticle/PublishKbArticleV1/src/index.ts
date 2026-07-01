import tasks = require('azure-pipelines-task-lib/task');
import path = require('path');
import { getOAuthToken, getAuthHeaders } from './auth';
import {
    getKnowledgeBases,
    getArticle,
    createKnowledgeArticle,
    updateKnowledgeArticle,
    changeWorkflowState,
    findArticleBySourceKey,
} from './servicenow-client';
import { validateHtmlContent, readHtmlFile } from './html-validate';
import { emitArticleOutput, findKbArticleJson, readFrontMatterKey } from './manifest';
import { DryRunPlan, PlannedAction, formatDryRunReport } from './dry-run';
import { processArticleImages } from './attachments';
import { updateArticleBody } from './servicenow-client';

async function run() {
    tasks.setResourcePath(path.join(__dirname, '..', 'task.json'));
    try {
        // -----------------------------------------------------------------
        // Resolve instance and auth from service connection or inline inputs
        // -----------------------------------------------------------------
        let instance = '';
        let authType = '';
        let clientId: string | undefined;
        let clientSecret: string | undefined;
        let username: string | undefined;
        let password: string | undefined;

        const serviceConnection = tasks.getInput('serviceConnection', false);
        if (serviceConnection) {
            const rawUrl = tasks.getEndpointUrl(serviceConnection, false) || '';
            // Extract instance name from URL like https://myinstance.service-now.com
            const urlMatch = rawUrl.match(/https?:\/\/([^.]+)\.service-now\.com/i);
            instance = urlMatch ? urlMatch[1] : rawUrl;

            const scheme = (tasks.getEndpointAuthorizationScheme(serviceConnection, false) || '').toLowerCase();
            if (scheme === 'usernamepassword' || scheme === 'basic') {
                authType = 'basic';
                username = tasks.getEndpointAuthorizationParameter(serviceConnection, 'username', false) || undefined;
                password = tasks.getEndpointAuthorizationParameter(serviceConnection, 'password', false) || undefined;
            } else {
                authType = 'oauth';
                clientId = tasks.getEndpointAuthorizationParameter(serviceConnection, 'clientId', false) || undefined;
                clientSecret = tasks.getEndpointAuthorizationParameter(serviceConnection, 'clientSecret', false) || undefined;
            }
        }

        // Inline inputs override / supplement service connection
        instance = tasks.getInput('instance', false) || instance;
        authType = tasks.getInput('authType', false) || authType;
        clientId = tasks.getInput('clientId', false) || clientId;
        clientSecret = tasks.getInput('clientSecret', false) || clientSecret;
        username = tasks.getInput('username', false) || username;
        password = tasks.getInput('password', false) || password;

        if (!instance) {
            throw new Error('ServiceNow instance is required (set "instance" input or provide a service connection).');
        }
        // Guard against URL injection: instance is interpolated into
        // https://<instance>.service-now.com, which carries the OAuth secret.
        if (!/^[a-z0-9-]+$/i.test(instance)) {
            throw new Error(
                `Invalid ServiceNow instance '${instance}'. Expected the instance name only ` +
                `(letters, digits, hyphens), e.g. 'mycompany' for mycompany.service-now.com.`,
            );
        }
        if (!authType) {
            throw new Error('authType is required.');
        }

        // -----------------------------------------------------------------
        // Obtain auth headers
        // -----------------------------------------------------------------
        let headers: Record<string, string>;
        if (authType === 'oauth') {
            if (!clientId || !clientSecret) {
                throw new Error('OAuth authentication requires clientId and clientSecret.');
            }
            const token = await getOAuthToken(instance, clientId, clientSecret);
            headers = getAuthHeaders('oauth', { accessToken: token });
        } else {
            if (!username || !password) {
                throw new Error('Basic authentication requires username and password.');
            }
            tasks.setSecret(password);
            headers = getAuthHeaders('basic', { username, password });
        }

        // -----------------------------------------------------------------
        // Read remaining inputs
        // -----------------------------------------------------------------
        const kbId = tasks.getInput('kbId', false) || undefined;
        const articleIdInput = tasks.getInput('articleId', false) || undefined;
        const title = tasks.getInput('title', false) || undefined;
        const htmlFile = tasks.getInput('htmlFile', false) || undefined;
        const author = tasks.getInput('author', false) || undefined;
        const category = tasks.getInput('category', false) || undefined;
        const subcategory = tasks.getInput('subcategory', false) || undefined;
        const workflowState = tasks.getInput('workflowState', false) || 'draft';
        let sourceKey = tasks.getInput('sourceKey', false) || undefined;
        const readKeyFrom = tasks.getInput('readKeyFrom', false) || undefined;
        const emitManifest = tasks.getInput('emitManifest', false) || undefined;
        const force = tasks.getBoolInput('force', false);
        const skipJsonLookup = tasks.getBoolInput('skipJsonLookup', false);
        const dryRun = tasks.getBoolInput('dryRun', false);
        const uploadImages = tasks.getBoolInput('uploadImages', false);
        const imageBaseDir = tasks.getInput('imageBaseDir', false) || undefined;

        // -----------------------------------------------------------------
        // List KB mode
        // -----------------------------------------------------------------
        if (kbId === 'list') {
            const kbs = await getKnowledgeBases(instance, headers);
            console.log('Available Knowledge Bases:');
            for (const kb of kbs as Array<Record<string, unknown>>) {
                console.log(`  Title: ${kb['title']} | KB ID: ${kb['sys_id']}`);
            }
            tasks.setResult(tasks.TaskResult.Succeeded, 'Knowledge base listing complete.');
            return;
        }

        // -----------------------------------------------------------------
        // Read HTML content
        // -----------------------------------------------------------------
        let articleContent: string | undefined;
        if (htmlFile) {
            articleContent = readHtmlFile(htmlFile);
            validateHtmlContent(articleContent, force);
        }

        // -----------------------------------------------------------------
        // Resolve source key
        // -----------------------------------------------------------------
        if (readKeyFrom) {
            sourceKey = readFrontMatterKey(readKeyFrom);
            console.log(`Source key from front-matter '${readKeyFrom}': ${sourceKey}`);
        }

        // -----------------------------------------------------------------
        // Resolve article ID
        // -----------------------------------------------------------------
        let articleId: string | undefined = articleIdInput;

        if (!articleId) {
            if (sourceKey) {
                const found = await findArticleBySourceKey(instance, headers, sourceKey, kbId);
                articleId = found || undefined;
            } else if (!skipJsonLookup) {
                console.log('No article-id provided. Looking for KB article JSON file...');
                const jsonData = findKbArticleJson();
                if (jsonData && jsonData['article_id']) {
                    articleId = jsonData['article_id'] as string;
                    console.log(`Using article ID from JSON file: ${articleId}`);
                }
            }
        }

        // Determine the action that would be taken (shared by dry-run and execute).
        const workflowOnly = Boolean(articleId) && Boolean(workflowState) &&
            !title && !articleContent && !category && !author;
        const plannedAction: PlannedAction = !articleId
            ? 'create'
            : workflowOnly ? 'workflow-only' : 'update';

        // -----------------------------------------------------------------
        // Dry-run: report the plan and exit without any write.
        // Read-only lookups above (source-key resolution) have already run; the
        // only additional read here is fetching the existing article's current
        // state. No POST/PATCH, category auto-create, or manifest write occurs.
        // -----------------------------------------------------------------
        if (dryRun) {
            let currentWorkflowState: string | undefined;
            if (articleId) {
                try {
                    const existing = await getArticle(instance, headers, articleId);
                    currentWorkflowState = existing.workflow_state;
                } catch {
                    // Non-fatal in dry-run: report what we can without the current state.
                    currentWorkflowState = undefined;
                }
            } else if (plannedAction === 'create') {
                // Surface the same required-field problems a real create would hit,
                // so a dry-run on a PR build catches misconfiguration early.
                const missing: string[] = [];
                if (!kbId) missing.push('kbId');
                if (!title) missing.push('title');
                if (!articleContent) missing.push('htmlFile (content)');
                if (!author) missing.push('author');
                if (missing.length > 0) {
                    throw new Error(
                        `Dry run: create would fail — missing required field(s): ${missing.join(', ')}.`,
                    );
                }
            }

            const plan: DryRunPlan = {
                action: plannedAction,
                instance,
                kbId,
                articleId,
                currentWorkflowState,
                title,
                author,
                category,
                subcategory,
                workflowState,
                sourceKey,
                contentBytes: articleContent ? Buffer.byteLength(articleContent, 'utf8') : undefined,
                sourceKeyMatched: sourceKey ? Boolean(articleId) : undefined,
            };

            console.log(formatDryRunReport(plan));
            tasks.setResult(tasks.TaskResult.Succeeded, 'Dry run complete — no changes made.');
            return;
        }

        // -----------------------------------------------------------------
        // Execute: update or create
        // -----------------------------------------------------------------
        let article: Record<string, unknown>;

        if (articleId) {
            console.log(`Updating knowledge article with ID '${articleId}'...`);

            if (workflowOnly) {
                console.log(`Changing workflow state to '${workflowState}'...`);
                article = await changeWorkflowState(instance, headers, articleId, workflowState) as unknown as Record<string, unknown>;
            } else {
                article = await updateKnowledgeArticle(
                    instance, headers, articleId,
                    title, articleContent, author,
                    category, subcategory, workflowState, sourceKey,
                ) as unknown as Record<string, unknown>;
            }
            console.log('Knowledge article updated successfully!');
        } else {
            // Create path — validate required fields
            if (!kbId) {
                throw new Error('Knowledge base ID (kbId) is required for creating an article.');
            }
            if (!title) {
                throw new Error('Article title is required for creating an article.');
            }
            if (!articleContent) {
                throw new Error('Article content is required (set htmlFile input).');
            }
            if (!author) {
                throw new Error('Author is required for creating an article.');
            }

            console.log(`Creating new knowledge article '${title}'...`);
            article = await createKnowledgeArticle(
                instance, headers, kbId, title, articleContent, author,
                category, subcategory, workflowState, sourceKey,
            ) as unknown as Record<string, unknown>;
            console.log('Knowledge article created successfully!');
        }

        console.log(`Article Number: ${article['number']}`);
        console.log(`Article ID: ${article['sys_id']}`);
        console.log(`Workflow State: ${article['workflow_state']}`);

        // -----------------------------------------------------------------
        // Phase 2: upload referenced images as attachments and rewrite the body.
        // Runs only when there is body content and image upload is enabled. The
        // article must already exist (we need its sys_id), which it does here.
        // -----------------------------------------------------------------
        if (uploadImages && articleContent) {
            const sysId = article['sys_id'] as string;
            // Resolve relative <img> paths against imageBaseDir, or the HTML
            // file's own directory when no base dir is given.
            const baseDir = imageBaseDir
                ? path.resolve(imageBaseDir)
                : htmlFile ? path.dirname(path.resolve(htmlFile)) : process.cwd();

            const result = await processArticleImages(
                instance, headers, sysId, articleContent, baseDir, /* failOnMissing */ !force,
            );

            if (result.uploaded > 0) {
                await updateArticleBody(instance, headers, sysId, result.html);
                console.log(`Rewrote ${result.uploaded} image reference(s) to ServiceNow attachments.`);
            }
            if (result.missing.length > 0) {
                console.log(`${result.missing.length} image(s) not found and left unchanged.`);
            }
        }

        // -----------------------------------------------------------------
        // Emit manifest line + output variables
        // -----------------------------------------------------------------
        emitArticleOutput(article, sourceKey, emitManifest, kbId);

        tasks.setVariable('kbArticleId', article['sys_id'] as string, false, true);
        tasks.setVariable('kbArticleNumber', article['number'] as string, false, true);
        tasks.setVariable('kbWorkflowState', article['workflow_state'] as string, false, true);

        tasks.setResult(tasks.TaskResult.Succeeded, '');
    } catch (error) {
        tasks.setResult(
            tasks.TaskResult.Failed,
            error instanceof Error ? error.message : String(error),
        );
    }
}

void run();
