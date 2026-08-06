import { MODULE_ID } from "./constants.mjs";
import { Compat } from "./compat.mjs";
import { ShopStore } from "./storage.mjs";

export const BACKUP_FORMAT = "shopwright-backup";
export const BACKUP_SCHEMA_VERSION = 1;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

function worldTimeNow() {
  const value = Number(game.time?.worldTime);
  return Number.isFinite(value) ? value : 0;
}

function safeSlug(value, fallback = "world") {
  const slug = String(value ?? "")
    .trim()
    .toLocaleLowerCase(game.i18n.lang)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

function timestampSlug() {
  const date = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function categoryNameKey(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase(game.i18n.lang);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("INVALID_BACKUP");
  if (payload.format !== BACKUP_FORMAT) throw new Error("WRONG_FORMAT");

  const schemaVersion = Number(payload.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error("INVALID_SCHEMA");
  if (schemaVersion > BACKUP_SCHEMA_VERSION) throw new Error("NEWER_SCHEMA");
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new Error("INVALID_BACKUP");

  const hasShops = Array.isArray(payload.data.shops);
  const hasHistory = Array.isArray(payload.data.history);
  if (!hasShops && !hasHistory) throw new Error("EMPTY_BACKUP");
  if (payload.data.categories != null && !Array.isArray(payload.data.categories)) throw new Error("INVALID_BACKUP");

  return payload;
}

function normalizedHistoryEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const cloned = Compat.clone(entry);
  return {
    ...cloned,
    id: String(cloned.id || Compat.randomID()),
    timestamp: Number(cloned.timestamp) || Date.now()
  };
}

export class ShopBackup {
  static create({ includeShops = true, includeHistory = true } = {}) {
    const data = {};
    if (includeShops) {
      data.shops = Compat.clone(ShopStore.getAll());
      data.categories = Compat.clone(ShopStore.getCategories());
    }
    if (includeHistory) data.history = Compat.clone(ShopStore.getHistory());

    return {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      module: {
        id: MODULE_ID,
        version: String(game.modules.get(MODULE_ID)?.version ?? "")
      },
      foundry: {
        version: String(game.version ?? "")
      },
      system: {
        id: String(game.system?.id ?? ""),
        version: String(game.system?.version ?? "")
      },
      world: {
        id: String(game.world?.id ?? ""),
        title: String(game.world?.title ?? "")
      },
      data
    };
  }

  static download(kind = "all") {
    const includeShops = kind === "shops" || kind === "all";
    const includeHistory = kind === "history" || kind === "all";
    const payload = this.create({ includeShops, includeHistory });
    const world = safeSlug(game.world?.id || game.world?.title, "world");
    const suffix = kind === "shops" ? "shops" : kind === "history" ? "history" : "full";
    const filename = `shopwright_${world}_${suffix}_${timestampSlug()}.json`;
    foundry.utils.saveDataToFile(JSON.stringify(payload, null, 2), "application/json", filename);
    return filename;
  }

  static async readFile(file) {
    if (!(file instanceof File)) throw new Error("NO_FILE");
    if (file.size > MAX_IMPORT_BYTES) throw new Error("FILE_TOO_LARGE");
    const text = await foundry.utils.readTextFromFile(file);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("INVALID_JSON");
    }
    return validatePayload(parsed);
  }

  static summarize(payload) {
    validatePayload(payload);
    const shops = asArray(payload.data.shops);
    const categories = asArray(payload.data.categories);
    const history = asArray(payload.data.history);
    const exportedAt = Date.parse(payload.exportedAt);
    return {
      hasShops: Array.isArray(payload.data.shops),
      hasHistory: Array.isArray(payload.data.history),
      shopCount: shops.length,
      categoryCount: categories.length,
      historyCount: history.length,
      exportedAtText: Number.isFinite(exportedAt)
        ? new Date(exportedAt).toLocaleString(game.i18n.lang)
        : "не указано",
      moduleVersion: String(payload.module?.version || "не указана"),
      foundryVersion: String(payload.foundry?.version || "не указана"),
      systemId: String(payload.system?.id || "не указана"),
      systemVersion: String(payload.system?.version || "не указана"),
      worldTitle: String(payload.world?.title || payload.world?.id || "не указан")
    };
  }

  static async import(payload, { shopsMode = "skip", historyMode = "skip" } = {}) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    validatePayload(payload);

    const validShopModes = new Set(["skip", "merge", "replace"]);
    const validHistoryModes = new Set(["skip", "merge", "replace"]);
    if (!validShopModes.has(shopsMode) || !validHistoryModes.has(historyMode)) throw new Error("INVALID_IMPORT_MODE");

    const sourceShops = asArray(payload.data.shops);
    const sourceCategories = asArray(payload.data.categories);
    const sourceHistory = asArray(payload.data.history);
    const shopIdMap = new Map();
    const result = {
      shopsAdded: 0,
      shopsReplaced: false,
      categoriesAdded: 0,
      historyAdded: 0,
      historyReplaced: false
    };

    if (shopsMode !== "skip" && Array.isArray(payload.data.shops)) {
      if (shopsMode === "replace") {
        await ShopStore.saveCategories(Compat.clone(sourceCategories));
        await ShopStore.saveAll(Compat.clone(sourceShops));
        result.shopsAdded = sourceShops.length;
        result.categoriesAdded = sourceCategories.length;
        result.shopsReplaced = true;
      } else {
        const currentCategories = ShopStore.getCategories();
        const nextCategories = Compat.clone(currentCategories);
        const categoryIdMap = new Map();
        const targetByName = new Map(
          nextCategories.map(category => [categoryNameKey(category.name), category.id])
        );
        const existingCategoryIds = new Set(nextCategories.map(category => category.id));
        const importedCategoryIds = new Set(sourceCategories.map(category => String(category?.id ?? "")));
        const now = Date.now();

        for (const source of sourceCategories) {
          if (!source || typeof source !== "object" || Array.isArray(source)) continue;
          const sourceId = String(source.id ?? "");
          const name = String(source.name ?? "").trim() || "Новая категория";
          const key = categoryNameKey(name);
          let targetId = targetByName.get(key);
          if (!targetId) {
            targetId = Compat.randomID();
            nextCategories.push({
              ...Compat.clone(source),
              id: targetId,
              name,
              createdAt: now,
              updatedAt: now
            });
            targetByName.set(key, targetId);
            existingCategoryIds.add(targetId);
            result.categoriesAdded += 1;
          }
          if (sourceId) categoryIdMap.set(sourceId, targetId);
        }

        const importedShops = sourceShops
          .filter(shop => shop && typeof shop === "object" && !Array.isArray(shop))
          .map(source => {
            const shop = Compat.clone(source);
            const oldShopId = String(shop.id ?? "");
            const newShopId = Compat.randomID();
            if (oldShopId) shopIdMap.set(oldShopId, newShopId);
            const oldCategoryId = String(shop.categoryId ?? "");
            let categoryId = categoryIdMap.get(oldCategoryId) ?? null;
            if (!categoryId && oldCategoryId && !importedCategoryIds.has(oldCategoryId) && existingCategoryIds.has(oldCategoryId)) {
              categoryId = oldCategoryId;
            }
            return {
              ...shop,
              id: newShopId,
              categoryId,
              revision: 0,
              createdAt: now,
              updatedAt: now,
              productGroups: asArray(shop.productGroups).map(group => ({
                ...Compat.clone(group),
                lastUpdateTime: worldTimeNow()
              }))
            };
          });

        await ShopStore.saveCategories(nextCategories);
        await ShopStore.saveAll([...ShopStore.getAll(), ...importedShops]);
        result.shopsAdded = importedShops.length;
      }
    }

    if (historyMode !== "skip" && Array.isArray(payload.data.history)) {
      const importedHistory = sourceHistory.map(normalizedHistoryEntry).filter(Boolean).map(entry => {
        const oldShopId = String(entry.shopId ?? "");
        return oldShopId && shopIdMap.has(oldShopId)
          ? { ...entry, shopId: shopIdMap.get(oldShopId) }
          : entry;
      });
      if (historyMode === "replace") {
        const saved = await ShopStore.saveHistory(importedHistory);
        result.historyAdded = saved.length;
        result.historyReplaced = true;
      } else {
        const current = ShopStore.getHistory();
        const knownIds = new Set(current.map(entry => String(entry.id ?? "")).filter(Boolean));
        const additions = [];
        for (const entry of importedHistory) {
          if (knownIds.has(entry.id)) continue;
          knownIds.add(entry.id);
          additions.push(entry);
        }
        const saved = await ShopStore.saveHistory([...current, ...additions]);
        const savedIds = new Set(saved.map(entry => String(entry.id ?? "")));
        result.historyAdded = additions.filter(entry => savedIds.has(entry.id)).length;
      }
    }

    return result;
  }
}
