import assert from 'node:assert/strict';
import { CLIENT_ID, requestDeviceCode, exchangeAuthorizationCode, refreshTokens } from '../src/oauth.mjs';

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  if (String(url).endsWith('/usercode')) return new Response(JSON.stringify({ device_auth_id: 'test-id', user_code: 'test-code' }), { status: 200 });
  return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', id_token: 'id' }), { status: 200 });
};
try {
  for (const clientId of [undefined, 'test-custom-client']) {
    const options = { issuer: 'https://example.invalid', clientId };
    const grant = await requestDeviceCode(options);
    assert.equal(grant.clientId, clientId ?? CLIENT_ID);
    assert.equal(JSON.parse(calls.at(-1).init.body).client_id, clientId ?? CLIENT_ID);
    await exchangeAuthorizationCode(grant, { authorizationCode: 'code', codeVerifier: 'verifier' });
    assert.equal(new URLSearchParams(calls.at(-1).init.body).get('client_id'), clientId ?? CLIENT_ID);
    await refreshTokens('refresh', options);
    assert.equal(new URLSearchParams(calls.at(-1).init.body).get('client_id'), clientId ?? CLIENT_ID);
  }
  console.log('ok   OAuth device, exchange and refresh share the same client ID');
} finally {
  globalThis.fetch = originalFetch;
}
