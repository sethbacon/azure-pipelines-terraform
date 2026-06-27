import { describe, it } from 'mocha';
import assert = require('assert');
import * as net from 'net';
import { fetchWithTimeout } from '../src/http-client';

// Direct (non-MockTestRunner) unit tests for the http-client timeout guard.
// These run in the mocha parent process; the MockTestRunner integration tests in
// L0.ts run in child processes and are unaffected.

describe('http-client: fetchWithTimeout', () => {
    it('rejects a non-https URL before opening a connection', async () => {
        await assert.rejects(
            fetchWithTimeout('http://insecure.example.com/x', 1000, async (r) => r.text()),
            /InsecureUrlRejected|insecure/i,
        );
    });

    it('aborts a hung connection and reports the timeout', async () => {
        // A bare TCP server that accepts the socket but never completes the TLS
        // handshake — the AbortController must fire and surface a timeout error.
        const server = net.createServer(() => { /* accept and stall */ });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        try {
            await assert.rejects(
                fetchWithTimeout(`https://127.0.0.1:${port}/x`, 150, async (r) => r.text()),
                /timed out after 150ms/,
            );
        } finally {
            server.close();
        }
    });
});
