import { beforeAll, describe, expect, it } from 'vitest';
import { login, type Client } from './helpers';

let admin: Client, doctor: Client, reception: Client;
beforeAll(async () => {
  [admin, doctor, reception] = await Promise.all([login('admin'), login('dr.ahmad'), login('reception')]);
});

describe('fixes from the full review', () => {
  it('doctors keep seeing invoices (also of other doctors’ patients) but not insurance company payments', async () => {
    expect((await doctor.get('/api/billing/invoices')).status).toBe(200);
    expect((await doctor.get('/api/insurance/payments')).status).toBe(403);
    expect((await reception.get('/api/insurance/payments')).status).toBe(403);
    expect((await admin.get('/api/insurance/payments')).status).toBe(200);
  });
});
