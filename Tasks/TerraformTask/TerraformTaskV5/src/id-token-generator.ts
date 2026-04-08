import tasks = require("azure-pipelines-task-lib/task");

export async function generateIdToken(serviceConnectionID: string): Promise<string> {
    const tokenGenerator = new TokenGenerator();
    return tokenGenerator.generate(serviceConnectionID);
}

export interface ITokenGenerator {
    generate(serviceConnectionID: string): Promise<string>;
}

export class TokenGenerator implements ITokenGenerator {
    private static readonly MAX_RETRIES = 3;
    private static readonly INITIAL_BACKOFF_MS = 200;

    public async generate(serviceConnectionID: string): Promise<string> {
        const oidcRequestUri = process.env["SYSTEM_OIDCREQUESTURI"];
        if (!oidcRequestUri) {
            throw new Error("SYSTEM_OIDCREQUESTURI is not set. Ensure the pipeline is running on an agent that supports OIDC token generation.");
        }

        const url = oidcRequestUri + "?api-version=7.1&serviceConnectionId=" + encodeURIComponent(serviceConnectionID);

        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= TokenGenerator.MAX_RETRIES; attempt++) {
            try {
                return await this.fetchToken(url, oidcRequestUri);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt < TokenGenerator.MAX_RETRIES) {
                    const delayMs = TokenGenerator.INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
                    tasks.debug(`OIDC token request attempt ${attempt} failed: ${lastError.message}. Retrying in ${delayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }
        throw lastError!;
    }

    private async fetchToken(url: string, oidcRequestUri: string): Promise<string> {
        let response: Response;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + tasks.getEndpointAuthorizationParameter('SystemVssConnection', 'AccessToken', false)!
                },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Timed out acquiring federated token from ${oidcRequestUri} (30s timeout).`);
            }
            throw new Error(`Failed to acquire federated token from ${oidcRequestUri}: ${error instanceof Error ? error.message : error}`);
        }

        if (!response.ok) {
            throw new Error(`Failed to acquire federated token: HTTP ${response.status} ${response.statusText}`);
        }

        const oidcObject = await response.json() as { oidcToken: string };
        if (!oidcObject?.oidcToken) {
            throw new Error(tasks.loc("Error_FederatedTokenAquisitionFailed"));
        }

        const oidcToken = oidcObject.oidcToken;
        tasks.setSecret(oidcToken);
        return oidcToken;
    }
}
