/**
 * Runs the service against the REAL `anylist` library classes (List, Item, MealPlanningCalendarEvent,
 * protobuf encoding/decoding), with only its HTTP client replaced. The mocked
 * `data/user-data/get` response is a protobuf-encoded fixture, and the operations the library
 * would send to AnyList are decoded and asserted. No network access.
 */
import AnyList from 'anylist';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyListLike } from '../src/anylist-client.js';
import { AnyListService } from '../src/service.js';

type Post = (url: string, opts?: { body?: { getBuffer(): Buffer; getBoundary(): string } }) => Promise<{ body: Buffer }>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function fixture(pb: Any): Buffer {
  const userData = new pb.PBUserDataResponse({
    shoppingListsResponse: {
      newLists: [
        {
          identifier: 'L1',
          name: 'Groceries',
          items: [
            { identifier: 'I1', listId: 'L1', name: 'Milk', checked: false, quantityPb: { amount: '2' }, details: 'whole', categoryMatchId: 'dairy' },
            { identifier: 'I2', listId: 'L1', name: 'Apples', checked: true, categoryMatchId: 'produce' },
          ],
        },
      ],
      listResponses: [
        {
          listId: 'L1',
          categoryGroupResponses: [
            {
              categoryGroup: {
                identifier: 'G1',
                listId: 'L1',
                name: 'Default',
                categories: [
                  { identifier: 'C1', name: 'Dairy', systemCategory: 'dairy', listId: 'L1', categoryGroupId: 'G1' },
                  { identifier: 'C2', name: 'Produce', systemCategory: 'produce', listId: 'L1', categoryGroupId: 'G1' },
                ],
              },
            },
          ],
        },
      ],
    },
    starterListsResponse: {
      recentItemListsResponse: { listResponses: [] },
      favoriteItemListsResponse: { listResponses: [] },
    },
    mealPlanningCalendarResponse: {
      calendarId: 'CAL1',
      events: [{ identifier: 'E1', calendarId: 'CAL1', date: '2026-11-26', recipeId: 'R1', labelId: 'LB1', details: 'Thanksgiving' }],
      labels: [{ identifier: 'LB1', calendarId: 'CAL1', name: 'Dinner', hexColor: '#ff0000' }],
    },
    recipeDataResponse: {
      recipeDataId: 'RD1',
      recipes: [
        {
          identifier: 'R1',
          name: 'Roast Turkey',
          servings: '10',
          prepTime: 1800,
          cookTime: 10800,
          preparationSteps: ['Brine', 'Roast'],
          ingredients: [{ rawIngredient: '1 turkey (14 lb)', name: 'turkey', quantity: '1' }],
        },
      ],
    },
  });
  return userData.toBuffer();
}

/** Extract the protobuf payload from the multipart form the library posts. */
function operationsBytes(form: { getBuffer(): Buffer; getBoundary(): string }): Buffer {
  const buf = form.getBuffer();
  const start = buf.indexOf('\r\n\r\n') + 4;
  const end = buf.lastIndexOf(Buffer.from(`\r\n--${form.getBoundary()}--`));
  return buf.subarray(start, end);
}

let lib: Any;
let post: ReturnType<typeof vi.fn<Post>>;
let svc: AnyListService;

beforeEach(() => {
  lib = new AnyList({ email: 'test@example.com', password: 'not-a-real-password', credentialsFile: null });
  const userData = fixture(lib.protobuf);
  post = vi.fn<Post>(async url => (url === 'data/user-data/get' ? { body: userData } : { body: Buffer.alloc(0) }));
  lib.client = { post };
  svc = new AnyListService(async () => lib as AnyListLike);
});

function writes() {
  return post.mock.calls.filter(([url]) => url !== 'data/user-data/get');
}

function decodeListOps(call: Parameters<Post>) {
  const ops = lib.protobuf.PBListOperationList.decode(operationsBytes(call[1]!.body!));
  return ops.operations.map((o: Any) => ({
    handlerId: o.metadata.handlerId,
    listId: o.listId,
    itemId: o.listItemId,
    value: o.updatedValue,
    itemName: o.listItem?.name ?? null,
    itemQuantity: o.listItem?.quantityPb?.amount ?? null,
    itemDetails: o.listItem?.details ?? null,
    itemCategory: o.listItem?.categoryMatchId ?? null,
  }));
}

describe('real anylist library, mocked HTTP', () => {
  it('decodes lists, quantities and categories', async () => {
    expect(await svc.listLists()).toEqual([{ id: 'L1', name: 'Groceries', item_count: 2, unchecked_count: 1, checked_count: 1 }]);
    const list = await svc.getList('Groceries');
    expect(list.items).toEqual([
      { id: 'I1', name: 'Milk', quantity: '2', notes: 'whole', category: 'Dairy', checked: false },
      { id: 'I2', name: 'Apples', quantity: null, notes: null, category: 'Produce', checked: true },
    ]);
    expect(writes()).toHaveLength(0);
  });

  it('check_item sends set-list-item-checked=y', async () => {
    await svc.setChecked({ list: 'Groceries', name: 'Milk' }, true);
    const [call] = writes();
    expect(call[0]).toBe('data/shopping-lists/update');
    expect(decodeListOps(call)).toEqual([
      expect.objectContaining({ handlerId: 'set-list-item-checked', listId: 'L1', itemId: 'I1', value: 'y' }),
    ]);
  });

  it('add_item sends add-shopping-list-item with the encoded item', async () => {
    await svc.addItem({ list: 'Groceries', name: 'Bananas', quantity: '6', notes: 'ripe', category: 'Produce' });
    const [call] = writes();
    expect(decodeListOps(call)).toEqual([
      expect.objectContaining({
        handlerId: 'add-shopping-list-item',
        listId: 'L1',
        itemName: 'Bananas',
        itemQuantity: '6',
        itemDetails: 'ripe',
        itemCategory: 'produce',
      }),
    ]);
  });

  it('add_item on a checked item un-checks it and updates quantity', async () => {
    await svc.addItem({ list: 'Groceries', name: 'Apples', quantity: '4' });
    const [call] = writes();
    expect(decodeListOps(call).map((o: Any) => [o.handlerId, o.value])).toEqual([
      ['set-list-item-checked', 'n'],
      ['set-list-item-quantity', '4'],
    ]);
  });

  it('update_item sends one op per changed field', async () => {
    await svc.updateItem({ list: 'Groceries', name: 'Milk', new_name: 'Oat milk', notes: '', category: 'produce' });
    const [call] = writes();
    expect(decodeListOps(call).map((o: Any) => [o.handlerId, o.value])).toEqual([
      ['set-list-item-name', 'Oat milk'],
      ['set-list-item-details', ''],
      ['set-list-item-category-match-id', 'produce'],
    ]);
  });

  it('remove_item without confirm makes no request; with confirm sends remove-shopping-list-item', async () => {
    await svc.removeItem({ list: 'Groceries', name: 'Milk' });
    expect(writes()).toHaveLength(0);
    await svc.removeItem({ list: 'Groceries', name: 'Milk', confirm: true });
    const [call] = writes();
    expect(decodeListOps(call)).toEqual([expect.objectContaining({ handlerId: 'remove-shopping-list-item', itemId: 'I1' })]);
  });

  it('reads the meal plan with recipe and label attached', async () => {
    const plan = await svc.getMealPlan('2026-11-20', '2026-11-30');
    expect(plan.events).toEqual([
      { id: 'E1', date: '2026-11-26', title: 'Roast Turkey', recipe: { id: 'R1', name: 'Roast Turkey' }, notes: 'Thanksgiving', label: 'Dinner' },
    ]);
  });

  it('add_meal_plan_event sends new-event with the right date, recipe and label', async () => {
    await svc.addMealPlanEvent({ date: '2026-11-27', recipe: 'turkey', note: 'leftovers', label: 'Dinner' });
    const [call] = writes();
    expect(call[0]).toBe('data/meal-planning-calendar/update');
    const ops = lib.protobuf.PBCalendarOperationList.decode(operationsBytes(call[1]!.body!));
    const op = ops.operations[0];
    expect(op.metadata.handlerId).toBe('new-event');
    expect(op.calendarId).toBe('CAL1');
    expect(op.updatedEvent).toMatchObject({ date: '2026-11-27', recipeId: 'R1', labelId: 'LB1', details: 'leftovers', calendarId: 'CAL1' });
  });

  it('remove_meal_plan_event with confirm sends delete-event', async () => {
    await svc.removeMealPlanEvent({ event_id: 'E1', confirm: true });
    const [call] = writes();
    const ops = lib.protobuf.PBCalendarOperationList.decode(operationsBytes(call[1]!.body!));
    expect(ops.operations[0].metadata.handlerId).toBe('delete-event');
    expect(ops.operations[0].updatedEvent.identifier).toBe('E1');
  });

  it('reads recipes', async () => {
    const r = await svc.getRecipe('Roast Turkey');
    expect(r).toMatchObject({
      servings: '10',
      prep_time_minutes: 30,
      cook_time_minutes: 180,
      steps: ['Brine', 'Roast'],
      ingredients: [{ text: '1 turkey (14 lb)', name: 'turkey', quantity: '1', note: null }],
    });
  });
});
