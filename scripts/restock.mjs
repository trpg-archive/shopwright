import { MODULE_ID } from "./constants.mjs";
import { Compat } from "./compat.mjs";
import { ShopStore } from "./storage.mjs";

export const MAX_ACCUMULATED_RESTOCK_PERIODS = 100;

const UNIT_SECONDS = Object.freeze({
  hour: 3600,
  day: 86400,
  week: 604800
});

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function currentWorldTime() {
  const value = Number(game.time?.worldTime);
  return Number.isFinite(value) ? value : 0;
}

function groupIntervalSeconds(group) {
  const amount = Math.max(1, finiteInteger(group?.intervalValue, 1));
  return amount * (UNIT_SECONDS[group?.intervalUnit] ?? UNIT_SECONDS.day);
}

function stockMaximum(entry, group) {
  const value = entry?.overrideStockRules === true ? entry.maxStock : group?.maxStock;
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

function stockFormula(entry, group, field) {
  if (entry?.overrideStockRules === true) return String(entry?.[field] ?? "").trim();
  return String(group?.[field] ?? "").trim();
}

async function evaluateQuantity(formula) {
  const source = String(formula ?? "").trim();
  if (!source) return 0;
  if (typeof Roll?.validate === "function" && !Roll.validate(source)) throw new Error(`Некорректная формула: ${source}`);
  const roll = typeof Roll?.create === "function" ? Roll.create(source) : new Roll(source);
  const evaluated = await roll.evaluate({ allowInteractive: false });
  const total = Number(evaluated?.total);
  if (!Number.isFinite(total)) throw new Error(`Формула не вернула число: ${source}`);
  return Math.max(0, Math.floor(total));
}

export class RestockService {
  static get worldTime() {
    return currentWorldTime();
  }

  static get maxAccumulatedPeriods() {
    return MAX_ACCUMULATED_RESTOCK_PERIODS;
  }

  static intervalSeconds(group) {
    return groupIntervalSeconds(group);
  }

  static duePeriods(group, atTime = currentWorldTime()) {
    if (group?.autoRestock === false) return 0;
    const last = Number(group?.lastUpdateTime);
    if (!Number.isFinite(last)) return 0;
    const elapsed = atTime - last;
    if (elapsed <= 0) return 0;
    return Math.max(0, Math.floor(elapsed / groupIntervalSeconds(group)));
  }

  static formatDuration(seconds) {
    let remaining = Math.max(0, finiteInteger(seconds, 0));
    const days = Math.floor(remaining / UNIT_SECONDS.day);
    remaining %= UNIT_SECONDS.day;
    const hours = Math.floor(remaining / UNIT_SECONDS.hour);
    const parts = [];
    if (days) parts.push(`${days} дн.`);
    if (hours || !parts.length) parts.push(`${hours} ч.`);
    return parts.join(" ");
  }

  static groupStatus(group, atTime = currentWorldTime()) {
    const interval = groupIntervalSeconds(group);
    const last = Number.isFinite(Number(group?.lastUpdateTime)) ? Number(group.lastUpdateTime) : atTime;
    if (atTime < last) return { due: 0, remaining: interval, text: "Время мира было переведено назад" };
    const elapsed = atTime - last;
    const due = group?.autoRestock === false ? 0 : Math.floor(elapsed / interval);
    const remaining = group?.autoRestock === false ? null : Math.max(0, interval - (elapsed % interval));
    return {
      due,
      remaining,
      limited: due > MAX_ACCUMULATED_RESTOCK_PERIODS,
      text: group?.autoRestock === false
        ? "Автообновление выключено"
        : due > MAX_ACCUMULATED_RESTOCK_PERIODS
          ? `Накоплено периодов: ${due} · будет применено ${MAX_ACCUMULATED_RESTOCK_PERIODS}`
          : due > 0
            ? `Накоплено периодов: ${due}`
            : `До обновления: ${this.formatDuration(remaining)}`
    };
  }

  static async applyDue(shopId, { groupId = null, forcePeriods = null, resetTimer = false } = {}) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const shop = ShopStore.get(shopId);
    if (!shop) throw new Error("SHOP_NOT_FOUND");

    const now = currentWorldTime();
    const items = Compat.clone(shop.items);
    const groups = Compat.clone(shop.productGroups ?? []);
    const results = [];
    let changed = false;

    for (const group of groups) {
      if (groupId && group.id !== groupId) continue;

      const interval = groupIntervalSeconds(group);
      let requestedPeriods;
      if (forcePeriods != null) requestedPeriods = Math.max(0, finiteInteger(forcePeriods, 0));
      else requestedPeriods = this.duePeriods(group, now);
      const limited = requestedPeriods > MAX_ACCUMULATED_RESTOCK_PERIODS;
      const periods = Math.min(requestedPeriods, MAX_ACCUMULATED_RESTOCK_PERIODS);

      const last = Number(group.lastUpdateTime);
      if (Number.isFinite(last) && now < last) {
        group.lastUpdateTime = now;
        changed = true;
        results.push({ groupId: group.id, groupName: group.name, requestedPeriods, periods: 0, changedItems: 0, reset: true, limited });
        continue;
      }

      if (periods < 1) {
        if (!Number.isFinite(last)) {
          group.lastUpdateTime = now;
          changed = true;
        }
        continue;
      }

      const candidateItems = Compat.clone(items);
      const changedItemIndexes = new Set();
      const itemChanges = [];

      try {
        for (let period = 0; period < periods; period += 1) {
          for (let index = 0; index < candidateItems.length; index += 1) {
            const entry = candidateItems[index];
            if (entry.kind === "service" || entry.groupId !== group.id || entry.quantity == null) continue;

            const before = Math.max(0, finiteInteger(entry.quantity, 0));
            const added = await evaluateQuantity(stockFormula(entry, group, "restockFormula"));
            const removed = await evaluateQuantity(stockFormula(entry, group, "depletionFormula"));
            const maximum = stockMaximum(entry, group);
            let after = Math.max(0, before + added - removed);
            if (maximum != null) after = Math.min(maximum, after);
            entry.quantity = after;

            if (after !== before) {
              changedItemIndexes.add(index);
              itemChanges.push({ index, before, after, added, removed, period: period + 1 });
            }
          }
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Ошибка обновления товарной группы ${group.name}`, error);
        results.push({
          groupId: group.id,
          groupName: group.name,
          requestedPeriods,
          periods,
          changedItems: 0,
          limited,
          error: String(error?.message ?? error)
        });
        continue;
      }

      items.splice(0, items.length, ...candidateItems);
      group.lastUpdateTime = resetTimer || forcePeriods != null || limited
        ? now
        : (Number.isFinite(last) ? last : now) + periods * interval;
      changed = true;
      results.push({
        groupId: group.id,
        groupName: group.name,
        requestedPeriods,
        periods,
        changedItems: changedItemIndexes.size,
        itemChanges,
        limited
      });
    }

    if (changed) {
      await ShopStore.update(shopId, { items, productGroups: groups }, { expectedShopRevision: shop.revision });
    }

    return {
      ok: true,
      shopId,
      changed,
      results,
      errorCount: results.filter(result => result.error).length,
      periodCount: results.reduce((sum, result) => sum + (result.error ? 0 : (result.periods || 0)), 0),
      changedItems: results.reduce((sum, result) => sum + (result.changedItems || 0), 0),
      limitedGroupCount: results.filter(result => result.limited && !result.error).length
    };
  }
}
