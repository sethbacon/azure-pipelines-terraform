import * as http from 'http';
import * as net from 'net';

export interface ConnectSeen {
    target: string;
    proxyAuthorization?: string;
}

/**
 * A minimal HTTP CONNECT proxy for tests: accepts a CONNECT request, opens a
 * plain TCP connection to the requested host:port, and pipes bytes both ways
 * once the tunnel is established -- exercising the same wire protocol as a
 * real corporate forward proxy against the shared https-client.ts's
 * ProxyTunnelAgent. Optionally requires a specific Proxy-Authorization header
 * value and returns 407 otherwise. Records every CONNECT target/header seen
 * so tests can assert the tunnel was actually used.
 */
export function startConnectProxy(opts: { requireAuthHeader?: string } = {}): {
    server: http.Server;
    seen: ConnectSeen[];
} {
    const seen: ConnectSeen[] = [];
    const server = http.createServer();
    server.on('connect', (req, clientSocket, head) => {
        const target = req.url ?? '';
        const proxyAuthorization = req.headers['proxy-authorization'];
        seen.push({ target, proxyAuthorization });
        if (opts.requireAuthHeader && proxyAuthorization !== opts.requireAuthHeader) {
            clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            return;
        }
        const separatorIndex = target.lastIndexOf(':');
        const targetHost = target.slice(0, separatorIndex);
        const targetPort = Number(target.slice(separatorIndex + 1));
        const targetSocket = net.connect(targetPort, targetHost, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            targetSocket.write(head);
            targetSocket.pipe(clientSocket);
            clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => targetSocket.destroy());
    });
    return { server, seen };
}

/** A CONNECT proxy that always refuses the tunnel with the given status. */
export function startRefusingConnectProxy(statusCode: number): http.Server {
    const server = http.createServer();
    server.on('connect', (_req, clientSocket) => {
        clientSocket.end(`HTTP/1.1 ${statusCode} Refused\r\n\r\n`);
    });
    return server;
}

/**
 * A CONNECT proxy that accepts the TCP connection but never answers the CONNECT
 * request -- modelling a wedged/overloaded corporate proxy that leaves the
 * tunnel half-open. Lets a test assert the CONNECT + inner-TLS-handshake phase
 * is bounded by the request timeout rather than hanging until the agent job
 * timeout.
 */
export function startHangingConnectProxy(): http.Server {
    const server = http.createServer();
    server.on('connect', (_req, clientSocket) => {
        // Accept the socket and stall forever: never write a CONNECT response.
        // Swallow the error the client raises when it destroys the half-open
        // tunnel on timeout, so it never surfaces as an unhandled 'error'.
        clientSocket.on('error', () => { /* client tore down the stalled tunnel */ });
    });
    return server;
}
