import { vi } from 'vitest';
import type { AnyListLike } from '../src/anylist-client.js';

/** Mimics the library's Item: setters queue field updates, save() sends them. */
export class FakeItem {
  _fieldsToUpdate: string[] = [];
  constructor(
    public identifier: string,
    private _name: string,
    private _quantity?: string,
    private _details?: string,
    private _checked = false,
    private _categoryMatchId?: string,
    public listId = 'L1',
  ) {}
  save = vi.fn(async () => {});
  get name() { return this._name; }
  set name(v) { this._name = v; this._fieldsToUpdate.push('name'); }
  get quantity() { return this._quantity; }
  set quantity(v) { this._quantity = v; this._fieldsToUpdate.push('quantity'); }
  get details() { return this._details; }
  set details(v) { this._details = v; this._fieldsToUpdate.push('details'); }
  get checked() { return this._checked; }
  set checked(v: boolean) { this._checked = v; this._fieldsToUpdate.push('checked'); }
  get categoryMatchId() { return this._categoryMatchId; }
  set categoryMatchId(v) { this._categoryMatchId = v; this._fieldsToUpdate.push('categoryMatchId'); }
  toJSON() { return {}; }
}

export function makeFakeClient() {
  const milk = new FakeItem('I1', 'Milk', '2', 'whole', false, 'dairy');
  const apples = new FakeItem('I2', 'Apples', undefined, undefined, true, 'produce');
  const eggs1 = new FakeItem('I3', 'Eggs', '12', undefined, false);
  const eggs2 = new FakeItem('I4', 'Eggs', '6', undefined, true);
  const groceries = {
    identifier: 'L1',
    parentId: 'P1',
    name: 'Groceries',
    items: [milk, apples, eggs1, eggs2] as unknown[],
    addItem: vi.fn(async (item: unknown) => {
      groceries.items.push(item);
      return item;
    }),
    removeItem: vi.fn(async (item: { identifier: string }) => {
      groceries.items = groceries.items.filter(i => (i as FakeItem).identifier !== item.identifier);
    }),
  };
  const hardware = { identifier: 'L2', parentId: 'P2', name: 'Hardware Store', items: [] as unknown[], addItem: vi.fn(), removeItem: vi.fn() };

  const tacos = {
    identifier: 'R1', name: 'Fish Tacos', rating: 5, servings: '4', prepTime: 900, cookTime: 600,
    sourceName: 'Serious Eats', sourceUrl: 'https://example.com/tacos', note: '', nutritionalInfo: undefined,
    ingredients: [{ rawIngredient: '1 lb cod', name: 'cod', quantity: '1 lb', note: '' }],
    preparationSteps: ['Season fish', 'Grill'],
  };
  const soup = { identifier: 'R2', name: 'Tomato Soup', ingredients: [], preparationSteps: [] };
  const soupBread = { identifier: 'R3', name: 'Tomato Soup with Bread', ingredients: [], preparationSteps: [] };

  const dinner = { identifier: 'LB1', name: 'Dinner' };
  const events = [
    { identifier: 'E2', date: new Date('2026-11-27'), title: undefined, details: 'double batch', recipeId: 'R1', recipe: tacos, label: dinner, save: vi.fn(), delete: vi.fn(async () => {}) },
    { identifier: 'E1', date: new Date('2026-11-25'), title: 'Leftovers', details: undefined, recipe: null, label: null, save: vi.fn(), delete: vi.fn() },
    { identifier: 'E3', date: new Date('2026-12-05'), title: 'Out', recipe: null, label: null, save: vi.fn(), delete: vi.fn() },
  ];

  const createdEvents: Array<Record<string, unknown>> = [];
  const client = {
    _userData: {
      shoppingListsResponse: {
        newLists: [{ identifier: 'L1', items: [{ identifier: 'I3', categoryAssignments: [{ categoryId: 'C-BAKERY' }] }] }],
        listResponses: [
          {
            listId: 'L1',
            categoryGroupResponses: [
              {
                categoryGroup: {
                  categories: [
                    { identifier: 'C-DAIRY', name: 'Dairy', systemCategory: 'dairy' },
                    { identifier: 'C-PRODUCE', name: 'Produce', systemCategory: 'produce' },
                    { identifier: 'C-BAKERY', name: 'Bakery & Eggs', systemCategory: 'bakery' },
                    { identifier: 'C-CUSTOM', name: 'Costco Run', systemCategory: null },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
    mealPlanningCalendarEventLabels: [dinner],
    getLists: vi.fn(async () => [groceries, hardware]),
    createItem: vi.fn((o: { name: string; quantity?: string; details?: string; categoryMatchId?: string }) =>
      new FakeItem('NEW', o.name, o.quantity, o.details, false, o.categoryMatchId)),
    getMealPlanningCalendarEvents: vi.fn(async () => events),
    createEvent: vi.fn(async (o: Record<string, unknown>) => {
      const e = { identifier: 'ENEW', ...o, save: vi.fn(async () => {}) };
      createdEvents.push(e);
      return e;
    }),
    getRecipes: vi.fn(async () => [tacos, soup, soupBread]),
    teardown: vi.fn(),
  };

  return {
    client,
    asClient: client as unknown as AnyListLike,
    groceries,
    milk, apples, eggs1, eggs2,
    events,
    createdEvents,
  };
}
