import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

// Same app, reached two ways: through the HTTPS reverse proxy (the clinic's domain) and directly over plain
// http on the clinic network (IP address). Here the "proxy" is the test client on loopback.
const viaProxy = createApp();
viaProxy.set('trust proxy', 'loopback');
const direct = createApp(); // trusts no proxy, like a device calling http://<clinic-ip>:4080
const login = (app: ReturnType<typeof createApp>, headers: Record<string, string> = {}) =>
  request(app).post('/api/auth/login').set({ 'X-Requested-With': 'EmergencyPlus', ...headers }).send({ username: 'admin', password: 'Admin@12345' });

describe('HTTPS through the domain and plain http by IP both work', () => {
  it('HTTPS via the proxy: Secure cookies and HSTS', async () => {
    const r = await login(viaProxy, { 'X-Forwarded-Proto': 'https' });
    expect(r.status).toBe(200);
    const cookies = r.headers['set-cookie'] as unknown as string[];
    expect(cookies.length).toBe(2);
    for (const c of cookies) expect(c).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(r.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(r.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });

  it('plain http by IP: cookies without Secure (else sign-in would fail) and no HSTS', async () => {
    const r = await login(direct);
    expect(r.status).toBe(200);
    for (const c of r.headers['set-cookie'] as unknown as string[]) expect(c).not.toMatch(/Secure/);
    expect(r.headers['strict-transport-security']).toBeUndefined();
    expect(r.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });

  it('a device that is not the trusted proxy cannot pretend to be HTTPS', async () => {
    const r = await login(direct, { 'X-Forwarded-Proto': 'https' });
    for (const c of r.headers['set-cookie'] as unknown as string[]) expect(c).not.toMatch(/Secure/);
    expect(r.headers['strict-transport-security']).toBeUndefined();
  });
});
