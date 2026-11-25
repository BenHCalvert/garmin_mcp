import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AnyListLoginError } from '../src/anylist-client.js';
import { clearSecretSources, registerSecrets } from '../src/redact.js';
import { AnyListService } from '../src/service.js';
import { createMcpServer } from '../src/tools.js';
import { makeFakeClient } from './fakes.js';

async function connect(service: AnyListService) {
  const server = createMcpServer(service);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0].text);

afterEach(() => clearSecretSources());

describe('MCP tools', () => {
  it('exposes all tools with destructive hints on deletes', async () => {
    const client = await connect(new AnyListService(async () => makeFakeClient().asClient));
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'add_item', 'add_meal_plan_event', 'check_item', 'get_list', 'get_meal_plan', 'get_recipe', 'get_recipes',
      'list_lists', 'remove_item', 'remove_meal_plan_event', 'uncheck_item', 'update_item',
    ]);
    for (const t of tools) {
      expect(t.annotations?.destructiveHint ?? false).toBe(t.name.startsWith('remove_'));
    }
    const remove = tools.find(t => t.name === 'remove_item')!;
    expect(remove.inputSchema.properties).toHaveProperty('confirm');
  });

  it('calls through to the service and returns JSON', async () => {
    const client = await connect(new AnyListService(async () => makeFakeClient().asClient));
    const res = await client.callTool({ name: 'get_list', arguments: { name: 'Groceries' } });
    expect(JSON.parse(text(res)).items).toHaveLength(4);
  });

  it('remove_item without confirm deletes nothing', async () => {
    const f = makeFakeClient();
    const client = await connect(new AnyListService(async () => f.asClient));
    const res = await client.callTool({ name: 'remove_item', arguments: { list: 'Groceries', name: 'Milk' } });
    expect(JSON.parse(text(res)).action).toBe('confirmation_required');
    expect(f.groceries.removeItem).not.toHaveBeenCalled();
  });

  it('rejects bad dates at the schema level', async () => {
    const client = await connect(new AnyListService(async () => makeFakeClient().asClient));
    const res = await client.callTool({ name: 'get_meal_plan', arguments: { start_date: 'tomorrow', end_date: '2026-12-01' } });
    expect(res.isError).toBe(true);
  });

  it('user errors are returned as tool errors', async () => {
    const client = await connect(new AnyListService(async () => makeFakeClient().asClient));
    const res = await client.callTool({ name: 'get_list', arguments: { name: 'Nope' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/No list named "Nope"/);
  });

  it('never leaks credentials or tokens from library errors', async () => {
    registerSecrets(() => ['hunter2-password', 'me@example.com', 'secret-access-token-123']);
    const leaky = Object.assign(
      new Error('Request failed for me@example.com with password=hunter2-password, Authorization: Bearer secret-access-token-123'),
      { response: { statusCode: 500, request: { options: { headers: { authorization: 'Bearer secret-access-token-123' } } } } },
    );
    const f = makeFakeClient();
    f.client.getLists.mockRejectedValueOnce(leaky);
    const client = await connect(new AnyListService(async () => f.asClient));
    const res = await client.callTool({ name: 'list_lists', arguments: {} });
    expect(res.isError).toBe(true);
    const out = JSON.stringify(res);
    expect(out).toContain('HTTP 500');
    for (const s of ['hunter2', 'me@example.com', 'secret-access-token']) expect(out).not.toContain(s);
  });

  it('login failures give a clear message', async () => {
    const client = await connect(
      new AnyListService(async () => {
        throw new AnyListLoginError({ response: { statusCode: 401 } });
      }),
    );
    const res = await client.callTool({ name: 'list_lists', arguments: {} });
    expect(text(res)).toMatch(/rejected the email\/password/);
  });
});
