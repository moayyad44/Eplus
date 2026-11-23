import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();

export type Client = ReturnType<typeof makeClient>;

/** A logged-in client (cookie jar) that sends the CSRF header on every request. */
export function makeClient() {
  const agent = request.agent(app);
  const h = { 'X-Requested-With': 'EmergencyPlus' };
  return {
    agent,
    get: (url: string) => agent.get(url).set(h),
    post: (url: string, body?: object) => agent.post(url).set(h).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set(h).send(body ?? {}),
    del: (url: string) => agent.delete(url).set(h),
  };
}

export async function login(username: string, password = username === 'admin' ? 'Admin@12345' : 'Test@12345') {
  const c = makeClient();
  const res = await c.post('/api/auth/login', { username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}
