/**
 * READ-ONLY check against your real AnyList account. Makes no changes.
 *
 *   ANYLIST_EMAIL=... ANYLIST_PASSWORD=... npm run smoke
 *
 * Logs in, then prints list names with item counts, this week's meal plan event count and
 * the number of recipes. It never calls add/update/check/remove.
 */
import { installSafeConsole } from '../src/logging.js';
installSafeConsole();

import { createAnyListProvider } from '../src/anylist-client.js';
import { loadAnyListConfig } from '../src/config.js';
import { AnyListService } from '../src/service.js';

const out = (s: string) => process.stderr.write(`${s}\n`);

async function main() {
  const provider = createAnyListProvider(loadAnyListConfig());
  const svc = new AnyListService(provider);

  const lists = await svc.listLists();
  out(`OK  login + lists: ${lists.length} list(s)`);
  for (const l of lists) out(`    - ${l.name}: ${l.item_count} items (${l.unchecked_count} unchecked)`);

  if (lists[0]) {
    const first = await svc.getList(lists[0].name);
    const withCategory = first.items.filter(i => i.category).length;
    out(`OK  get_list("${first.name}"): ${first.items.length} items, ${withCategory} with a category name resolved`);
  }

  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 6 * 86400_000).toISOString().slice(0, 10);
  const plan = await svc.getMealPlan(start, end);
  out(`OK  meal plan ${start}..${end}: ${plan.event_count} event(s)`);

  const recipes = await svc.getRecipes();
  out(`OK  recipes: ${recipes.recipe_count}`);

  (await provider()).teardown();
  out('Read-only smoke test passed. Nothing in your account was changed.');
}

main().catch(err => {
  out(`FAILED: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
});
