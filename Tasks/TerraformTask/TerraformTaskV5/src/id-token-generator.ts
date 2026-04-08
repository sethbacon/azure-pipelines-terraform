import tasks = require("azure-pipelines-task-lib/task");

export async function generateIdToken(serviceConnectionID: string): Promise<string> {
    const tokenGenerator = new TokenGenerator();
    return await tokenGenerator.generate(serviceConnectionID);
}

export interface ITokenGenerator {
    generate(serviceConnectionID: string): Promise<string>;
}

export class TokenGenerator implements ITokenGenerator {
    public async generate(serviceConnectionID: string): Promise<string> {
        const oidcRequestUri = process.env["SYSTEM_OIDCREQUESTURI"];
        if (!oidcRequestUri) {
            throw new Error("SYSTEM_OIDCREQUESTURI is not set. Ensure the pipeline is running on an agent that supports OIDC token generation.");
        }

        const url = oidcRequestUri + "?api-version=7.1&serviceConnectionId=" + encodeURIComponent(serviceConnectionID);

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
