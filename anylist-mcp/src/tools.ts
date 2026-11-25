import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AnyListLoginError } from './anylist-client.js';
import { log } from './logging.js';
import { redact } from './redact.js';
import { type AnyListService, UserError } from './service.js';

export const SERVER_NAME = 'anylist-mcp';
export const SERVER_VERSION = '0.1.0';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const listName = z.string().min(1).describe('List name (case-insensitive; a unique partial name also works)');
const itemName = z.string().min(1).optional().describe('Item name (case-insensitive exact match)');
const itemId = z.string().min(1).optional().describe('Item id from get_list; use when several items share a name');

export function createMcpServer(service: AnyListService): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for the user\'s AnyList account: shopping lists, the meal planning calendar and recipes. ' +
        'Prefer check_item over remove_item when the user is done with something. ' +
        'Deleting requires confirm=true; only pass it when the user has clearly asked for the deletion.',
    },
  );

  const READ = { readOnlyHint: true, openWorldHint: true } as const;
  const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const DELETE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

  server.registerTool(
    'list_lists',
    {
      title: 'List AnyList lists',
      description: 'All lists in the AnyList account with total, unchecked and checked item counts.',
      inputSchema: {},
      annotations: READ,
    },
    () => run(() => service.listLists()),
  );

  server.registerTool(
    'get_list',
    {
      title: 'Get list items',
      description: 'Items on a list with checked state, quantity, category and notes.',
      inputSchema: {
        name: listName,
        include_checked: z.boolean().optional().describe('Include crossed-off items (default true)'),
      },
      annotations: READ,
    },
    ({ name, include_checked }) => run(() => service.getList(name, include_checked ?? true)),
  );

  server.registerTool(
    'add_item',
    {
      title: 'Add item to list',
      description:
        'Add an item to a list. If an item with the same name is already on the list crossed off, it is un-checked and reused ' +
        '(like the AnyList apps do) instead of creating a duplicate.',
      inputSchema: {
        list: listName,
        name: z.string().min(1).describe('Item name'),
        quantity: z.string().optional().describe('Quantity, e.g. "2" or "1 lb"'),
        notes: z.string().optional().describe('Notes shown under the item'),
        category: z.string().optional().describe('Category name as shown in AnyList, e.g. "Produce"'),
        allow_duplicate: z.boolean().optional().describe('Add a second copy even if the item is already on the list'),
      },
      annotations: WRITE,
    },
    args => run(() => service.addItem(args)),
  );

  server.registerTool(
    'update_item',
    {
      title: 'Update item',
      description: 'Change an item\'s name, quantity, notes, category or checked state. Pass an empty string to clear quantity or notes.',
      inputSchema: {
        list: listName,
        name: itemName,
        item_id: itemId,
        new_name: z.string().optional(),
        quantity: z.string().optional(),
        notes: z.string().optional(),
        category: z.string().optional(),
        checked: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    args => run(() => service.updateItem(args)),
  );

  server.registerTool(
    'check_item',
    {
      title: 'Check off item',
      description: 'Cross an item off a list (it stays in AnyList as a checked item).',
      inputSchema: { list: listName, name: itemName, item_id: itemId },
      annotations: { ...WRITE, idempotentHint: true },
    },
    args => run(() => service.setChecked(args, true)),
  );

  server.registerTool(
    'uncheck_item',
    {
      title: 'Uncheck item',
      description: 'Un-check a crossed-off item so it is active on the list again.',
      inputSchema: { list: listName, name: itemName, item_id: itemId },
      annotations: { ...WRITE, idempotentHint: true },
    },
    args => run(() => service.setChecked(args, false)),
  );

  server.registerTool(
    'remove_item',
    {
      title: 'Remove item (destructive)',
      description:
        'Permanently delete an item from a list. Requires confirm=true; without it nothing is deleted and the matching item is returned for review. ' +
        'Only set confirm=true when the user explicitly asked to delete.',
      inputSchema: {
        list: listName,
        name: itemName,
        item_id: itemId,
        confirm: z.boolean().optional().describe('Must be true to actually delete'),
      },
      annotations: DELETE,
    },
    args => run(() => service.removeItem(args)),
  );

  server.registerTool(
    'get_meal_plan',
    {
      title: 'Get meal plan',
      description: 'Meal planning calendar events between two dates (inclusive), with recipe, notes and label.',
      inputSchema: { start_date: date, end_date: date },
      annotations: READ,
    },
    ({ start_date, end_date }) => run(() => service.getMealPlan(start_date, end_date)),
  );

  server.registerTool(
    'add_meal_plan_event',
    {
      title: 'Add meal plan event',
      description:
        'Add an event to the meal planning calendar: a recipe from the recipe box, a free-text note (e.g. "Leftovers"), or a recipe with a note.',
      inputSchema: {
        date,
        recipe: z.string().optional().describe('Recipe name (exact, or a unique partial match)'),
        note: z.string().optional().describe('Event title when no recipe is given, otherwise a note on the recipe event'),
        label: z.string().optional().describe('Meal plan label, e.g. "Dinner" (must already exist in AnyList)'),
      },
      annotations: WRITE,
    },
    args => run(() => service.addMealPlanEvent(args)),
  );

  server.registerTool(
    'remove_meal_plan_event',
    {
      title: 'Remove meal plan event (destructive)',
      description:
        'Delete a meal planning calendar event by id (from get_meal_plan). Requires confirm=true; without it nothing is deleted.',
      inputSchema: {
        event_id: z.string().min(1),
        confirm: z.boolean().optional().describe('Must be true to actually delete'),
      },
      annotations: DELETE,
    },
    args => run(() => service.removeMealPlanEvent(args)),
  );

  server.registerTool(
    'get_recipes',
    {
      title: 'List recipes',
      description: 'Recipes in the AnyList recipe box, optionally filtered by a name substring.',
      inputSchema: { query: z.string().optional().describe('Case-insensitive name filter') },
      annotations: READ,
    },
    ({ query }) => run(() => service.getRecipes(query)),
  );

  server.registerTool(
    'get_recipe',
    {
      title: 'Get recipe',
      description: 'Full recipe: ingredients, steps, servings, times, source and notes.',
      inputSchema: { name: z.string().min(1).describe('Recipe name (exact, or a unique partial match)') },
      annotations: READ,
    },
    ({ name }) => run(() => service.getRecipe(name)),
  );

  return server;
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: redact(JSON.stringify(result, null, 2)) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: toSafeMessage(err) }] };
  }
}

/** Turn any error into a message that never includes credentials, tokens or request internals. */
export function toSafeMessage(err: unknown): string {
  if (err instanceof UserError || err instanceof AnyListLoginError) return redact(err.message);
  const status = (err as { response?: { statusCode?: number } })?.response?.statusCode;
  log.error('Tool call failed:', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
  if (status) return `AnyList API request failed (HTTP ${status}). Try again; if it keeps failing the unofficial API may have changed.`;
  return 'Unexpected error talking to AnyList. Check the server logs for details.';
}
