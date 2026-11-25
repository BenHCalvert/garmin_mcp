import type { Item, List, MealPlanningCalendarEvent, Recipe } from 'anylist';
import type { AnyListLike, AnyListProvider } from './anylist-client.js';

/** An error whose message is safe and useful to show to the model/user. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export interface ItemView {
  id: string;
  name: string;
  quantity: string | null;
  notes: string | null;
  category: string | null;
  checked: boolean;
}

export interface ItemRef {
  name?: string;
  item_id?: string;
}

interface CategoryInfo {
  id: string;
  name: string;
  systemCategory?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const norm = (s: string | undefined | null) => (s ?? '').trim().toLocaleLowerCase();
const blankToNull = (s: string | undefined | null) => (s === undefined || s === null || s === '' ? null : s);

export class AnyListService {
  constructor(private readonly getClient: AnyListProvider) {}

  // ---------------------------------------------------------------- lists

  async listLists() {
    const client = await this.getClient();
    const lists = await client.getLists();
    return lists.map(l => {
      const unchecked = l.items.filter(i => !i.checked).length;
      return {
        id: l.identifier,
        name: l.name,
        item_count: l.items.length,
        unchecked_count: unchecked,
        checked_count: l.items.length - unchecked,
      };
    });
  }

  async getList(listName: string, includeChecked = true) {
    const { client, list } = await this.loadList(listName);
    const categories = categoryIndex(client, list.identifier);
    const assignments = rawAssignments(client, list.identifier);
    const items = list.items
      .filter(i => includeChecked || !i.checked)
      .map(i => toView(i, categories, assignments));
    return { id: list.identifier, name: list.name, item_count: items.length, items };
  }

  async addItem(args: {
    list: string;
    name: string;
    quantity?: string;
    notes?: string;
    category?: string;
    allow_duplicate?: boolean;
  }) {
    const name = args.name.trim();
    if (!name) throw new UserError('Item name must not be empty.');
    const { client, list } = await this.loadList(args.list);
    const categories = categoryIndex(client, list.identifier);
    const categoryMatchId = args.category !== undefined ? resolveCategory(categories, args.category) : undefined;

    const existing = list.items.filter(i => norm(i.name) === norm(name));
    if (existing.length > 0 && !args.allow_duplicate) {
      // Like the official apps: reuse a crossed-off item instead of creating a duplicate.
      const item = existing.find(i => i.checked) ?? existing[0];
      const wasChecked = !!item.checked;
      if (wasChecked) item.checked = false;
      applyEdits(item, { quantity: args.quantity, notes: args.notes, categoryMatchId });
      if (hasPendingChanges(item)) await item.save();
      return {
        action: wasChecked ? 'reused_checked_item' : 'already_on_list',
        list: list.name,
        item: toView(item, categories, rawAssignments(client, list.identifier)),
        note: wasChecked
          ? 'An existing crossed-off item was un-checked instead of adding a duplicate.'
          : 'Item was already on the list (unchecked); any quantity/notes/category given were applied. Pass allow_duplicate=true to add a second copy.',
      };
    }

    const item = client.createItem({
      name,
      ...(args.quantity !== undefined && args.quantity !== '' ? { quantity: args.quantity } : {}),
      ...(args.notes !== undefined && args.notes !== '' ? { details: args.notes } : {}),
      ...(categoryMatchId !== undefined ? { categoryMatchId } : {}),
    });
    const saved = await list.addItem(item);
    return { action: 'added', list: list.name, item: toView(saved, categories, new Map()) };
  }

  async updateItem(args: ItemRef & {
    list: string;
    new_name?: string;
    quantity?: string;
    notes?: string;
    category?: string;
    checked?: boolean;
  }) {
    const { client, list } = await this.loadList(args.list);
    const item = resolveItem(list, args);
    const categories = categoryIndex(client, list.identifier);
    const categoryMatchId = args.category !== undefined ? resolveCategory(categories, args.category) : undefined;
    if (args.new_name !== undefined) {
      const n = args.new_name.trim();
      if (!n) throw new UserError('new_name must not be empty.');
      if (n !== item.name) item.name = n;
    }
    applyEdits(item, { quantity: args.quantity, notes: args.notes, categoryMatchId });
    if (args.checked !== undefined && args.checked !== !!item.checked) item.checked = args.checked;
    if (!hasPendingChanges(item)) {
      return { action: 'unchanged', list: list.name, item: toView(item, categories, rawAssignments(client, list.identifier)) };
    }
    await item.save();
    return { action: 'updated', list: list.name, item: toView(item, categories, rawAssignments(client, list.identifier)) };
  }

  async setChecked(args: ItemRef & { list: string }, checked: boolean) {
    const { client, list } = await this.loadList(args.list);
    // When checking off, prefer the unchecked copy of a duplicated name, and vice versa.
    const item = resolveItem(list, args, checked ? 'unchecked' : 'checked');
    const categories = categoryIndex(client, list.identifier);
    if (!!item.checked === checked) {
      return { action: 'unchanged', list: list.name, item: toView(item, categories, rawAssignments(client, list.identifier)) };
    }
    item.checked = checked;
    await item.save();
    return {
      action: checked ? 'checked' : 'unchecked',
      list: list.name,
      item: toView(item, categories, rawAssignments(client, list.identifier)),
    };
  }

  async removeItem(args: ItemRef & { list: string; confirm?: boolean }) {
    const { client, list } = await this.loadList(args.list);
    const item = resolveItem(list, args);
    const view = toView(item, categoryIndex(client, list.identifier), rawAssignments(client, list.identifier));
    if (args.confirm !== true) {
      return {
        action: 'confirmation_required',
        list: list.name,
        item: view,
        note: 'Nothing was deleted. Call remove_item again with confirm=true to permanently remove this item. (To just cross it off, use check_item.)',
      };
    }
    await list.removeItem(item);
    return { action: 'removed', list: list.name, item: view };
  }

  // ---------------------------------------------------------------- meal plan

  async getMealPlan(startDate: string, endDate: string) {
    assertDate(startDate, 'start_date');
    assertDate(endDate, 'end_date');
    if (startDate > endDate) throw new UserError('start_date must be on or before end_date.');
    const client = await this.getClient();
    const events = await client.getMealPlanningCalendarEvents();
    const inRange = events
      .map(e => ({ e, date: eventDate(e) }))
      .filter((x): x is { e: MealPlanningCalendarEvent; date: string } => !!x.date && x.date >= startDate && x.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      start_date: startDate,
      end_date: endDate,
      event_count: inRange.length,
      events: inRange.map(({ e, date }) => eventView(e, date)),
    };
  }

  async addMealPlanEvent(args: { date: string; recipe?: string; note?: string; label?: string }) {
    assertDate(args.date, 'date');
    const recipeName = args.recipe?.trim();
    const note = args.note?.trim();
    if (!recipeName && !note) throw new UserError('Provide a recipe name, a note, or both.');
    const client = await this.getClient();

    let recipe: Recipe | undefined;
    if (recipeName) recipe = findRecipe(await client.getRecipes(), recipeName);

    let labelId: string | undefined;
    if (args.label?.trim()) {
      // Labels (Breakfast/Lunch/Dinner/...) are loaded alongside the calendar events.
      await client.getMealPlanningCalendarEvents();
      const labels = client.mealPlanningCalendarEventLabels ?? [];
      const label = labels.find(l => norm(l.name) === norm(args.label));
      if (!label) {
        throw new UserError(
          `No meal plan label named "${args.label}". Available: ${labels.map(l => l.name).join(', ') || '(none)'}.`,
        );
      }
      labelId = label.identifier;
    }

    const event = await client.createEvent({
      date: args.date,
      ...(recipe ? { recipeId: recipe.identifier } : { title: note }),
      ...(recipe && note ? { details: note } : {}),
      ...(labelId ? { labelId } : {}),
    });
    await event.save();
    return {
      action: 'added',
      event: {
        id: event.identifier,
        date: args.date,
        title: recipe ? recipe.name : note ?? null,
        recipe: recipe ? { id: recipe.identifier, name: recipe.name } : null,
        notes: recipe && note ? note : null,
        label: args.label ?? null,
      },
    };
  }

  async removeMealPlanEvent(args: { event_id: string; confirm?: boolean }) {
    const client = await this.getClient();
    const events = await client.getMealPlanningCalendarEvents();
    const event = events.find(e => e.identifier === args.event_id);
    if (!event) throw new UserError(`No meal plan event with id "${args.event_id}". Use get_meal_plan to find ids.`);
    const view = eventView(event, eventDate(event));
    if (args.confirm !== true) {
      return {
        action: 'confirmation_required',
        event: view,
        note: 'Nothing was deleted. Call remove_meal_plan_event again with confirm=true to permanently delete this event.',
      };
    }
    await event.delete();
    return { action: 'removed', event: view };
  }

  // ---------------------------------------------------------------- recipes

  async getRecipes(query?: string) {
    const client = await this.getClient();
    const q = norm(query);
    const recipes = (await client.getRecipes())
      .filter(r => !q || norm(r.name).includes(q))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    return {
      recipe_count: recipes.length,
      recipes: recipes.map(r => ({
        id: r.identifier,
        name: r.name,
        rating: r.rating || null,
        servings: blankToNull(r.servings),
        prep_time_minutes: secondsToMinutes(r.prepTime),
        cook_time_minutes: secondsToMinutes(r.cookTime),
        source: blankToNull(r.sourceName),
      })),
    };
  }

  async getRecipe(name: string) {
    const client = await this.getClient();
    const r = findRecipe(await client.getRecipes(), name);
    return {
      id: r.identifier,
      name: r.name,
      rating: r.rating || null,
      servings: blankToNull(r.servings),
      prep_time_minutes: secondsToMinutes(r.prepTime),
      cook_time_minutes: secondsToMinutes(r.cookTime),
      source_name: blankToNull(r.sourceName),
      source_url: blankToNull(r.sourceUrl),
      note: blankToNull(r.note),
      nutritional_info: blankToNull(r.nutritionalInfo),
      ingredients: (r.ingredients ?? []).map(i => ({
        text: blankToNull(i.rawIngredient) ?? [i.quantity, i.name, i.note].filter(Boolean).join(' '),
        name: blankToNull(i.name),
        quantity: blankToNull(i.quantity),
        note: blankToNull(i.note),
      })),
      steps: r.preparationSteps ?? [],
    };
  }

  // ---------------------------------------------------------------- helpers

  private async loadList(name: string): Promise<{ client: AnyListLike; list: List }> {
    const client = await this.getClient();
    const lists = await client.getLists();
    const list = lists.find(l => norm(l.name) === norm(name)) ?? uniquePartial(lists, name, l => l.name);
    if (!list) {
      throw new UserError(`No list named "${name}". Available lists: ${lists.map(l => l.name).join(', ') || '(none)'}.`);
    }
    return { client, list };
  }
}

// ------------------------------------------------------------------ pure helpers

function uniquePartial<T>(items: T[], query: string, key: (t: T) => string): T | undefined {
  const q = norm(query);
  if (!q) return undefined;
  const matches = items.filter(i => norm(key(i)).includes(q));
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveItem(list: List, ref: ItemRef, prefer?: 'checked' | 'unchecked'): Item {
  if (ref.item_id) {
    const item = list.items.find(i => i.identifier === ref.item_id);
    if (!item) throw new UserError(`No item with id "${ref.item_id}" on list "${list.name}".`);
    return item;
  }
  if (!ref.name?.trim()) throw new UserError('Provide the item name (or item_id).');
  const matches = list.items.filter(i => norm(i.name) === norm(ref.name));
  if (matches.length === 0) {
    throw new UserError(`No item named "${ref.name}" on list "${list.name}". Use get_list to see its items.`);
  }
  if (matches.length === 1) return matches[0];
  if (prefer) {
    const preferred = matches.filter(i => (prefer === 'checked' ? !!i.checked : !i.checked));
    if (preferred.length === 1) return preferred[0];
  }
  throw new UserError(
    `"${ref.name}" matches ${matches.length} items on "${list.name}". Pass item_id instead: ` +
      matches.map(i => `${i.identifier} (${i.checked ? 'checked' : 'unchecked'}${i.quantity ? `, qty ${i.quantity}` : ''})`).join('; '),
  );
}

function applyEdits(item: Item, e: { quantity?: string; notes?: string; categoryMatchId?: string }) {
  // Setters on the library's Item queue an update operation; only touch fields that actually change.
  if (e.quantity !== undefined && e.quantity !== (item.quantity ?? '')) item.quantity = e.quantity;
  if (e.notes !== undefined && e.notes !== (item.details ?? '')) item.details = e.notes;
  if (e.categoryMatchId !== undefined && e.categoryMatchId !== item.categoryMatchId) item.categoryMatchId = e.categoryMatchId;
}

function hasPendingChanges(item: Item): boolean {
  const pending = (item as unknown as { _fieldsToUpdate?: unknown[] })._fieldsToUpdate;
  return Array.isArray(pending) ? pending.length > 0 : true;
}

/** Category ID -> info for one list, from the raw user data the library already fetched. */
function categoryIndex(client: AnyListLike, listId: string): Map<string, CategoryInfo> {
  const map = new Map<string, CategoryInfo>();
  const data = client._userData as RawUserData | undefined;
  const response = data?.shoppingListsResponse?.listResponses?.find(r => r?.listId === listId);
  for (const group of response?.categoryGroupResponses ?? []) {
    for (const c of group?.categoryGroup?.categories ?? []) {
      if (c?.identifier && c.name) {
        map.set(c.identifier, { id: c.identifier, name: c.name, systemCategory: c.systemCategory ?? undefined });
      }
    }
  }
  for (const c of data?.userCategoriesResponse?.categories ?? []) {
    // Legacy per-user categories keyed by categoryMatchId.
    if (c?.categoryMatchId && c.name && !map.has(c.categoryMatchId)) {
      map.set(c.categoryMatchId, { id: c.categoryMatchId, name: c.name, systemCategory: c.systemCategory ?? undefined });
    }
  }
  return map;
}

/** Item ID -> assigned category ID, from raw list items (the library's Item doesn't expose assignments). */
function rawAssignments(client: AnyListLike, listId: string): Map<string, string> {
  const map = new Map<string, string>();
  const data = client._userData as RawUserData | undefined;
  const list = data?.shoppingListsResponse?.newLists?.find(l => l?.identifier === listId);
  for (const item of list?.items ?? []) {
    const categoryId = item?.categoryAssignments?.[0]?.categoryId;
    if (item?.identifier && categoryId) map.set(item.identifier, categoryId);
  }
  return map;
}

function categoryName(item: Item, categories: Map<string, CategoryInfo>, assignments: Map<string, string>): string | null {
  const assigned = assignments.get(item.identifier);
  if (assigned && categories.has(assigned)) return categories.get(assigned)!.name;
  const match = item.categoryMatchId;
  if (!match) return null;
  if (categories.has(match)) return categories.get(match)!.name;
  for (const c of categories.values()) if (c.systemCategory === match) return c.name;
  return match === 'other' ? null : match;
}

/** Map a category name the user gave to the categoryMatchId the library sends. */
function resolveCategory(categories: Map<string, CategoryInfo>, name: string): string {
  const wanted = norm(name);
  if (!wanted) return '';
  for (const c of categories.values()) {
    if (norm(c.name) === wanted) return c.systemCategory || c.id;
  }
  for (const c of categories.values()) {
    if (norm(c.systemCategory) === wanted) return c.systemCategory!;
  }
  const names = [...new Set([...categories.values()].map(c => c.name))];
  if (names.length === 0) {
    // No category data for this list; pass the value through as a match ID (e.g. "produce").
    return wanted;
  }
  throw new UserError(`Unknown category "${name}" for this list. Available: ${names.join(', ')}.`);
}

function toView(item: Item, categories: Map<string, CategoryInfo>, assignments: Map<string, string>): ItemView {
  return {
    id: item.identifier,
    name: item.name,
    quantity: blankToNull(item.quantity),
    notes: blankToNull(item.details),
    category: categoryName(item, categories, assignments),
    checked: !!item.checked,
  };
}

function eventDate(e: MealPlanningCalendarEvent): string | null {
  const d = e.date instanceof Date ? e.date : e.date ? new Date(e.date as unknown as string) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  // The library parses "YYYY-MM-DD" as UTC midnight and writes back with toISOString, so use UTC here too.
  return d.toISOString().slice(0, 10);
}

function eventView(e: MealPlanningCalendarEvent, date: string | null) {
  return {
    id: e.identifier,
    date,
    title: e.recipe?.name ?? blankToNull(e.title),
    recipe: e.recipe ? { id: e.recipe.identifier, name: e.recipe.name } : e.recipeId ? { id: e.recipeId, name: null } : null,
    notes: blankToNull(e.details),
    label: e.label?.name ?? null,
  };
}

function findRecipe(recipes: Recipe[], name: string): Recipe {
  const exact = recipes.filter(r => norm(r.name) === norm(name));
  if (exact.length >= 1) return exact[0];
  const partial = recipes.filter(r => norm(r.name).includes(norm(name)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new UserError(
      `"${name}" matches several recipes: ${partial.slice(0, 15).map(r => r.name).join(', ')}. Use the exact name.`,
    );
  }
  throw new UserError(`No recipe named "${name}". Use get_recipes to search.`);
}

function assertDate(value: string, field: string) {
  if (!DATE_RE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new UserError(`${field} must be a date in YYYY-MM-DD format.`);
  }
}

function secondsToMinutes(s: number | undefined): number | null {
  return typeof s === 'number' && s > 0 ? Math.round(s / 60) : null;
}

// Shape of the parts of the raw protobuf user data read above (all optional: decoded data can omit anything).
interface RawUserData {
  shoppingListsResponse?: {
    newLists?: Array<{ identifier?: string; items?: Array<{ identifier?: string; categoryAssignments?: Array<{ categoryId?: string }> }> }>;
    listResponses?: Array<{
      listId?: string;
      categoryGroupResponses?: Array<{
        categoryGroup?: { categories?: Array<{ identifier?: string; name?: string; systemCategory?: string | null }> };
      }>;
    }>;
  };
  userCategoriesResponse?: {
    categories?: Array<{ name?: string; categoryMatchId?: string; systemCategory?: string | null }>;
  };
}
