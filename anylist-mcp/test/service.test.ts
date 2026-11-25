import { beforeEach, describe, expect, it } from 'vitest';
import { AnyListService, UserError } from '../src/service.js';
import { makeFakeClient } from './fakes.js';

let f: ReturnType<typeof makeFakeClient>;
let svc: AnyListService;

beforeEach(() => {
  f = makeFakeClient();
  svc = new AnyListService(async () => f.asClient);
});

describe('lists', () => {
  it('list_lists returns counts', async () => {
    expect(await svc.listLists()).toEqual([
      { id: 'L1', name: 'Groceries', item_count: 4, unchecked_count: 2, checked_count: 2 },
      { id: 'L2', name: 'Hardware Store', item_count: 0, unchecked_count: 0, checked_count: 0 },
    ]);
  });

  it('get_list resolves names case-insensitively and maps categories', async () => {
    const list = await svc.getList('groceries');
    expect(list.items).toEqual([
      { id: 'I1', name: 'Milk', quantity: '2', notes: 'whole', category: 'Dairy', checked: false },
      { id: 'I2', name: 'Apples', quantity: null, notes: null, category: 'Produce', checked: true },
      // Category from the raw categoryAssignments, not categoryMatchId
      { id: 'I3', name: 'Eggs', quantity: '12', notes: null, category: 'Bakery & Eggs', checked: false },
      { id: 'I4', name: 'Eggs', quantity: '6', notes: null, category: null, checked: true },
    ]);
  });

  it('get_list accepts a unique partial name and can hide checked items', async () => {
    const list = await svc.getList('hardware');
    expect(list.name).toBe('Hardware Store');
    const unchecked = await svc.getList('Groceries', false);
    expect(unchecked.items.map(i => i.id)).toEqual(['I1', 'I3']);
  });

  it('unknown list lists the available ones', async () => {
    await expect(svc.getList('Costco')).rejects.toThrow(/Available lists: Groceries, Hardware Store/);
  });
});

describe('add_item', () => {
  it('adds a new item with quantity, notes and category', async () => {
    const res = await svc.addItem({ list: 'Groceries', name: 'Bananas', quantity: '6', notes: 'ripe', category: 'produce' });
    expect(res.action).toBe('added');
    expect(f.client.createItem).toHaveBeenCalledWith({ name: 'Bananas', quantity: '6', details: 'ripe', categoryMatchId: 'produce' });
    expect(f.groceries.addItem).toHaveBeenCalledOnce();
    expect(res.item).toMatchObject({ name: 'Bananas', quantity: '6', notes: 'ripe', category: 'Produce', checked: false });
  });

  it('custom categories without a system category use the category id', async () => {
    await svc.addItem({ list: 'Groceries', name: 'Paper towels', category: 'Costco Run' });
    expect(f.client.createItem).toHaveBeenCalledWith({ name: 'Paper towels', categoryMatchId: 'C-CUSTOM' });
  });

  it('rejects unknown categories', async () => {
    await expect(svc.addItem({ list: 'Groceries', name: 'X', category: 'Spaceship parts' })).rejects.toThrow(/Available: Dairy/);
    expect(f.groceries.addItem).not.toHaveBeenCalled();
  });

  it('reuses a checked-off item instead of duplicating', async () => {
    const res = await svc.addItem({ list: 'Groceries', name: 'apples', quantity: '3' });
    expect(res.action).toBe('reused_checked_item');
    expect(f.groceries.addItem).not.toHaveBeenCalled();
    expect(f.apples.checked).toBe(false);
    expect(f.apples._fieldsToUpdate).toEqual(['checked', 'quantity']);
    expect(f.apples.save).toHaveBeenCalledOnce();
  });

  it('does not duplicate an unchecked item unless allow_duplicate', async () => {
    const res = await svc.addItem({ list: 'Groceries', name: 'Milk' });
    expect(res.action).toBe('already_on_list');
    expect(f.milk.save).not.toHaveBeenCalled();

    const dup = await svc.addItem({ list: 'Groceries', name: 'Milk', allow_duplicate: true });
    expect(dup.action).toBe('added');
    expect(f.groceries.addItem).toHaveBeenCalledOnce();
  });

  it('rejects an empty name', async () => {
    await expect(svc.addItem({ list: 'Groceries', name: '   ' })).rejects.toBeInstanceOf(UserError);
  });
});

describe('update / check / uncheck', () => {
  it('only sends fields that changed', async () => {
    const res = await svc.updateItem({ list: 'Groceries', name: 'Milk', quantity: '2', notes: 'oat', new_name: 'Oat milk' });
    expect(res.action).toBe('updated');
    expect(f.milk._fieldsToUpdate).toEqual(['name', 'details']);
    expect(f.milk.save).toHaveBeenCalledOnce();
  });

  it('can clear notes with an empty string', async () => {
    await svc.updateItem({ list: 'Groceries', name: 'Milk', notes: '' });
    expect(f.milk.details).toBe('');
    expect(f.milk.save).toHaveBeenCalledOnce();
  });

  it('is a no-op when nothing changes', async () => {
    const res = await svc.updateItem({ list: 'Groceries', name: 'Milk', quantity: '2' });
    expect(res.action).toBe('unchanged');
    expect(f.milk.save).not.toHaveBeenCalled();
  });

  it('check_item checks and saves', async () => {
    const res = await svc.setChecked({ list: 'Groceries', name: 'MILK' }, true);
    expect(res.action).toBe('checked');
    expect(f.milk.checked).toBe(true);
    expect(f.milk.save).toHaveBeenCalledOnce();
  });

  it('check_item is idempotent', async () => {
    const res = await svc.setChecked({ list: 'Groceries', name: 'Apples' }, true);
    expect(res.action).toBe('unchanged');
    expect(f.apples.save).not.toHaveBeenCalled();
  });

  it('with duplicate names, check prefers the unchecked copy and uncheck the checked one', async () => {
    await svc.setChecked({ list: 'Groceries', name: 'Eggs' }, true);
    expect(f.eggs1.save).toHaveBeenCalledOnce();
    expect(f.eggs2.save).not.toHaveBeenCalled();

    f = makeFakeClient();
    svc = new AnyListService(async () => f.asClient);
    await svc.setChecked({ list: 'Groceries', name: 'Eggs' }, false);
    expect(f.eggs2.save).toHaveBeenCalledOnce();
  });

  it('ambiguous names in update require item_id', async () => {
    await expect(svc.updateItem({ list: 'Groceries', name: 'Eggs', quantity: '1' })).rejects.toThrow(/I3 \(unchecked, qty 12\); I4/);
    const res = await svc.updateItem({ list: 'Groceries', item_id: 'I4', quantity: '1' });
    expect(res.item.id).toBe('I4');
  });

  it('missing items give a helpful error', async () => {
    await expect(svc.setChecked({ list: 'Groceries', name: 'Caviar' }, true)).rejects.toThrow(/No item named "Caviar"/);
    await expect(svc.setChecked({ list: 'Groceries' }, true)).rejects.toThrow(/Provide the item name/);
  });
});

describe('remove_item requires confirm', () => {
  it('without confirm nothing is deleted', async () => {
    const res = await svc.removeItem({ list: 'Groceries', name: 'Milk' });
    expect(res.action).toBe('confirmation_required');
    expect(f.groceries.removeItem).not.toHaveBeenCalled();
  });

  it('confirm=false is not enough', async () => {
    await svc.removeItem({ list: 'Groceries', name: 'Milk', confirm: false });
    expect(f.groceries.removeItem).not.toHaveBeenCalled();
  });

  it('confirm=true deletes', async () => {
    const res = await svc.removeItem({ list: 'Groceries', name: 'Milk', confirm: true });
    expect(res.action).toBe('removed');
    expect(f.groceries.removeItem).toHaveBeenCalledWith(f.milk);
  });
});

describe('meal plan', () => {
  it('returns events in range, sorted, inclusive', async () => {
    const res = await svc.getMealPlan('2026-11-25', '2026-11-30');
    expect(res.events).toEqual([
      { id: 'E1', date: '2026-11-25', title: 'Leftovers', recipe: null, notes: null, label: null },
      { id: 'E2', date: '2026-11-27', title: 'Fish Tacos', recipe: { id: 'R1', name: 'Fish Tacos' }, notes: 'double batch', label: 'Dinner' },
    ]);
  });

  it('validates dates', async () => {
    await expect(svc.getMealPlan('2026-11-30', '2026-11-01')).rejects.toThrow(/on or before/);
    await expect(svc.getMealPlan('11/25/2026', '2026-11-30')).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('adds a recipe event with note and label', async () => {
    const res = await svc.addMealPlanEvent({ date: '2026-11-28', recipe: 'fish tacos', note: 'use halibut', label: 'dinner' });
    expect(f.client.createEvent).toHaveBeenCalledWith({ date: '2026-11-28', recipeId: 'R1', details: 'use halibut', labelId: 'LB1' });
    expect(f.createdEvents[0].save).toHaveBeenCalledOnce();
    expect(res.event).toMatchObject({ title: 'Fish Tacos', notes: 'use halibut' });
  });

  it('adds a note-only event', async () => {
    await svc.addMealPlanEvent({ date: '2026-11-29', note: 'Eat out' });
    expect(f.client.createEvent).toHaveBeenCalledWith({ date: '2026-11-29', title: 'Eat out' });
  });

  it('rejects ambiguous recipes and unknown labels', async () => {
    await expect(svc.addMealPlanEvent({ date: '2026-11-29', recipe: 'tomato' })).rejects.toThrow(/matches several recipes/);
    await expect(svc.addMealPlanEvent({ date: '2026-11-29', note: 'x', label: 'Brunch' })).rejects.toThrow(/Available: Dinner/);
    expect(f.client.createEvent).not.toHaveBeenCalled();
  });

  it('exact recipe name wins over partial matches', async () => {
    await svc.addMealPlanEvent({ date: '2026-11-29', recipe: 'Tomato Soup' });
    expect(f.client.createEvent).toHaveBeenCalledWith({ date: '2026-11-29', recipeId: 'R2' });
  });

  it('requires a recipe or note', async () => {
    await expect(svc.addMealPlanEvent({ date: '2026-11-29' })).rejects.toThrow(/recipe name, a note/);
  });

  it('remove_meal_plan_event requires confirm', async () => {
    const preview = await svc.removeMealPlanEvent({ event_id: 'E2' });
    expect(preview.action).toBe('confirmation_required');
    expect(f.events[0].delete).not.toHaveBeenCalled();
    await svc.removeMealPlanEvent({ event_id: 'E2', confirm: true });
    expect(f.events[0].delete).toHaveBeenCalledOnce();
  });
});

describe('recipes', () => {
  it('lists and filters recipes', async () => {
    const all = await svc.getRecipes();
    expect(all.recipes.map(r => r.name)).toEqual(['Fish Tacos', 'Tomato Soup', 'Tomato Soup with Bread']);
    const filtered = await svc.getRecipes('TACO');
    expect(filtered.recipes).toEqual([
      { id: 'R1', name: 'Fish Tacos', rating: 5, servings: '4', prep_time_minutes: 15, cook_time_minutes: 10, source: 'Serious Eats' },
    ]);
  });

  it('gets a full recipe', async () => {
    const r = await svc.getRecipe('fish tacos');
    expect(r.ingredients).toEqual([{ text: '1 lb cod', name: 'cod', quantity: '1 lb', note: null }]);
    expect(r.steps).toEqual(['Season fish', 'Grill']);
    expect(r.source_url).toBe('https://example.com/tacos');
  });
});
