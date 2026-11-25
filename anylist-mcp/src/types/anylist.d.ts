// Minimal typings for the unofficial `anylist` package (codetheweb/anylist, now kevdliu/anylist).
// Only the parts this server uses are declared.
declare module 'anylist' {
  import { EventEmitter } from 'node:events';

  export interface AnyListOptions {
    email: string;
    password: string;
    credentialsFile?: string | null;
  }

  export interface Item {
    readonly identifier: string;
    readonly listId: string;
    name: string;
    quantity: string | undefined;
    details: string | undefined;
    checked: boolean | undefined;
    categoryMatchId: string | undefined;
    save(isFavorite?: boolean): Promise<void>;
    toJSON(): Record<string, unknown>;
  }

  export interface List {
    identifier: string;
    parentId: string;
    name: string;
    items: Item[];
    addItem(item: Item, isFavorite?: boolean): Promise<Item>;
    removeItem(item: Item, isFavorite?: boolean): Promise<void>;
  }

  export interface Ingredient {
    rawIngredient?: string;
    name?: string;
    quantity?: string;
    note?: string;
  }

  export interface Recipe {
    identifier: string;
    name: string;
    note?: string;
    sourceName?: string;
    sourceUrl?: string;
    ingredients: Ingredient[];
    preparationSteps: string[];
    rating?: number;
    nutritionalInfo?: string;
    cookTime?: number;
    prepTime?: number;
    servings?: string;
  }

  export interface MealPlanningCalendarEventLabel {
    identifier: string;
    name: string;
    hexColor?: string;
  }

  export interface MealPlanningCalendarEvent {
    identifier: string;
    date: Date;
    title?: string;
    details?: string;
    labelId?: string;
    recipeId?: string;
    recipeScaleFactor?: number;
    recipe: Recipe | null;
    label: MealPlanningCalendarEventLabel | null | undefined;
    save(): Promise<void>;
    delete(): Promise<void>;
  }

  export interface CreateEventOptions {
    date: string | Date;
    title?: string;
    details?: string;
    recipeId?: string;
    labelId?: string;
  }

  export default class AnyList extends EventEmitter {
    constructor(options: AnyListOptions);
    lists: List[];
    recipes: Recipe[];
    mealPlanningCalendarEventLabels?: MealPlanningCalendarEventLabel[];
    login(connectWebSocket?: boolean): Promise<void>;
    teardown(): void;
    getLists(refreshCache?: boolean): Promise<List[]>;
    createItem(item: { name: string; quantity?: string; details?: string; categoryMatchId?: string }): Item;
    getMealPlanningCalendarEvents(refreshCache?: boolean): Promise<MealPlanningCalendarEvent[]>;
    createEvent(event: CreateEventOptions): Promise<MealPlanningCalendarEvent>;
    getRecipes(refreshCache?: boolean): Promise<Recipe[]>;
  }
}
