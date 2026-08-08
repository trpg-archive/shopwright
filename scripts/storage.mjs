import { MODULE_ID, SETTINGS, DEFAULT_IMAGE, DEFAULT_TRADE_CONFIG, THEMES } from "./constants.mjs";
import { ThemeService } from "./theme.mjs";
import { Compat } from "./compat.mjs";

const HISTORY_LIMIT = 1000;

let shopStateCacheRaw = null;
let shopStateCache = null;
let shopStateIndex = new Map();

function cacheShopState(raw, state) {
  shopStateCacheRaw = raw;
  shopStateCache = state;
  shopStateIndex = new Map(state.shops.map(shop => [shop.id, shop]));
  return state;
}

function invalidateShopStateCache() {
  shopStateCacheRaw = null;
  shopStateCache = null;
  shopStateIndex = new Map();
}

function now() {
  return Date.now();
}

function worldTimeNow() {
  const value = Number(game.time?.worldTime);
  return Number.isFinite(value) ? value : 0;
}

function nullableNonNegative(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

function normalizeProductGroup(group = {}) {
  const intervalValue = Number(group.intervalValue);
  const priceMultiplier = Number(group.priceMultiplier);
  const lastUpdateTime = Number(group.lastUpdateTime);
  return {
    id: String(group.id || Compat.randomID()),
    name: String(group.name || "Новая товарная группа").trim() || "Новая товарная группа",
    intervalValue: Number.isFinite(intervalValue) && intervalValue >= 1 ? Math.floor(intervalValue) : 1,
    intervalUnit: ["hour", "day", "week"].includes(group.intervalUnit) ? group.intervalUnit : "day",
    restockFormula: String(group.restockFormula ?? "").trim(),
    depletionFormula: String(group.depletionFormula ?? "").trim(),
    maxStock: nullableNonNegative(group.maxStock),
    priceMultiplier: Number.isFinite(priceMultiplier) && priceMultiplier > 0 ? priceMultiplier : 1,
    autoRestock: group.autoRestock !== false,
    lastUpdateTime: Number.isFinite(lastUpdateTime) ? lastUpdateTime : worldTimeNow()
  };
}

function normalizeItem(entry = {}) {
  const customPrice = entry.customPrice === "" || entry.customPrice == null
    ? null
    : Number(entry.customPrice);
  const quantity = entry.quantity === "" || entry.quantity == null
    ? null
    : Math.max(0, Number(entry.quantity));
  const groupId = String(entry.groupId ?? "").trim();

  return {
    id: String(entry.id ?? "").trim(),
    uuid: String(entry.uuid ?? "").trim(),
    kind: entry.kind === "service" ? "service" : "product",
    groupId: groupId || null,
    customPrice: Number.isFinite(customPrice) ? customPrice : null,
    quantity: Number.isFinite(quantity) ? quantity : null,
    overrideStockRules: entry.overrideStockRules === true,
    restockFormula: String(entry.restockFormula ?? "").trim(),
    depletionFormula: String(entry.depletionFormula ?? "").trim(),
    maxStock: nullableNonNegative(entry.maxStock)
  };
}

function normalizeWallet(wallet, fallbackCopper = 0) {
  if (wallet && typeof wallet === "object" && !Array.isArray(wallet)) return Compat.normalizeCurrencyMap(wallet);
  return Compat.copperToCurrency(fallbackCopper, { enabledOnly: false }).currency;
}

function normalizeShop(shop = {}) {
  const multiplier = Number(shop.priceMultiplier);
  const buybackMultiplier = Number(shop.buybackMultiplier);
  const legacyWalletCopper = Number(shop.walletCopper);
  const wallet = normalizeWallet(shop.wallet, Number.isFinite(legacyWalletCopper) ? legacyWalletCopper : 0);
  const walletCopper = Compat.currencyMapInCopper(wallet);
  const categoryId = String(shop.categoryId ?? "").trim();
  const productGroups = Array.isArray(shop.productGroups)
    ? shop.productGroups.map(normalizeProductGroup)
    : [];
  const validGroupIds = new Set(productGroups.map(group => group.id));
  const usedItemIds = new Set();
  const items = Array.isArray(shop.items)
    ? shop.items.map(normalizeItem).filter(entry => entry.uuid).map(entry => {
        let id = entry.id;
        if (!id || usedItemIds.has(id)) id = Compat.randomID();
        usedItemIds.add(id);
        return {
          ...entry,
          id,
          groupId: entry.kind === "service" || !validGroupIds.has(entry.groupId) ? null : entry.groupId
        };
      })
    : [];

  return {
    id: String(shop.id || Compat.randomID()),
    name: String(shop.name || "Новый магазин"),
    image: String(shop.image || DEFAULT_IMAGE),
    description: String(shop.description || ""),
    categoryId: categoryId || null,
    priceMultiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1,
    salesEnabled: shop.salesEnabled !== false,
    buybackMultiplier: Number.isFinite(buybackMultiplier) && buybackMultiplier >= 0 ? buybackMultiplier : 0.5,
    restockSoldItems: shop.restockSoldItems === true,
    walletEnabled: shop.walletEnabled === true,
    walletReceivesPayments: shop.walletReceivesPayments !== false,
    wallet,
    walletCopper,
    productGroups,
    items,
    revision: Math.max(0, Math.floor(Number(shop.revision) || 0)),
    createdAt: Number(shop.createdAt) || now(),
    updatedAt: Number(shop.updatedAt) || now()
  };
}

function normalizeCategory(category = {}) {
  return {
    id: String(category.id || Compat.randomID()),
    name: String(category.name || "Новая категория").trim() || "Новая категория",
    createdAt: Number(category.createdAt) || now(),
    updatedAt: Number(category.updatedAt) || now()
  };
}

function normalizeTradeConfig(config = {}) {
  const currencies = config?.currencies ?? {};
  return {
    initialized: config?.initialized === true,
    currencies: {
      pp: currencies.pp !== false,
      gp: currencies.gp !== false,
      ep: currencies.ep !== false,
      sp: currencies.sp !== false,
      cp: currencies.cp !== false
    },
    chatReceipts: config?.chatReceipts !== false
  };
}

function parseJsonSetting(key, fallback) {
  const raw = game.settings.get(MODULE_ID, key);
  try {
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch (error) {
    console.error(`${MODULE_ID} | Не удалось прочитать настройку ${key}`, error);
    return Compat.clone(fallback);
  }
}

function normalizeShopState(value) {
  if (Array.isArray(value)) {
    return { revision: 0, writeId: "", shops: value.map(normalizeShop) };
  }
  if (value && typeof value === "object" && Array.isArray(value.shops)) {
    return {
      revision: Math.max(0, Math.floor(Number(value.revision) || 0)),
      writeId: String(value.writeId ?? ""),
      shops: value.shops.map(normalizeShop)
    };
  }
  return { revision: 0, writeId: "", shops: [] };
}

function readShopState() {
  const raw = String(game.settings.get(MODULE_ID, SETTINGS.SHOPS) ?? "");
  if (shopStateCache && raw === shopStateCacheRaw) return shopStateCache;

  try {
    return cacheShopState(raw, normalizeShopState(JSON.parse(raw || "[]")));
  } catch (error) {
    console.error(`${MODULE_ID} | Не удалось прочитать магазины`, error);
    ui.notifications.error("Shopwright: повреждены данные магазинов. Подробности в консоли.");
    return cacheShopState(raw, normalizeShopState([]));
  }
}

export class ShopStore {
  static registerSettings() {
    game.settings.register(MODULE_ID, SETTINGS.SHOPS, {
      name: "Shopwright data",
      hint: "Internal JSON storage for Shopwright.",
      scope: "world",
      config: false,
      type: String,
      default: "[]",
      onChange: () => invalidateShopStateCache()
    });

    game.settings.register(MODULE_ID, SETTINGS.CATEGORIES, {
      name: "Shopwright categories",
      hint: "Internal JSON storage for shop categories.",
      scope: "world",
      config: false,
      type: String,
      default: "[]"
    });

    game.settings.register(MODULE_ID, SETTINGS.LAST_BUYER, {
      name: "Shopwright last buyer",
      hint: "Last explicitly selected buyer for this browser.",
      scope: "client",
      config: false,
      type: String,
      default: ""
    });

    game.settings.register(MODULE_ID, SETTINGS.TRADE_CONFIG, {
      name: "Shopwright trade config",
      hint: "Internal JSON storage for currency and receipt options.",
      scope: "world",
      config: false,
      type: String,
      default: JSON.stringify(DEFAULT_TRADE_CONFIG)
    });

    game.settings.register(MODULE_ID, SETTINGS.PURCHASE_HISTORY, {
      name: "Shopwright purchase history",
      hint: "Internal JSON storage for purchase history.",
      scope: "world",
      config: false,
      type: String,
      default: "[]"
    });

    game.settings.register(MODULE_ID, SETTINGS.THEME, {
      name: "SHOPWRIGHT.Theme.Name",
      hint: "SHOPWRIGHT.Theme.Hint",
      scope: "client",
      config: true,
      type: String,
      choices: {
        [THEMES.SYSTEM]: "SHOPWRIGHT.Theme.System",
        [THEMES.DARK]: "SHOPWRIGHT.Theme.Dark",
        [THEMES.LIGHT]: "SHOPWRIGHT.Theme.Light",
        [THEMES.COOL]: "SHOPWRIGHT.Theme.Cool"
      },
      default: THEMES.SYSTEM,
      requiresReload: false,
      onChange: () => ThemeService.applyToOpenWindows()
    });

    // Скрытые настройки старой версии нужны, чтобы миры 0.2.1 не теряли выбор
    // при первом открытии нового окна настроек.
    const legacyCurrencySettings = [
      SETTINGS.CURRENCY_PP,
      SETTINGS.CURRENCY_GP,
      SETTINGS.CURRENCY_EP,
      SETTINGS.CURRENCY_SP,
      SETTINGS.CURRENCY_CP
    ];

    for (const key of legacyCurrencySettings) {
      game.settings.register(MODULE_ID, key, {
        name: key,
        scope: "world",
        config: false,
        type: Boolean,
        default: true
      });
    }

    game.settings.register(MODULE_ID, SETTINGS.CHAT_RECEIPTS, {
      name: SETTINGS.CHAT_RECEIPTS,
      scope: "world",
      config: false,
      type: Boolean,
      default: true
    });
  }

  static invalidateCache() {
    invalidateShopStateCache();
  }

  static getAll() {
    return readShopState().shops.map(shop => Compat.clone(shop));
  }

  static get(id) {
    readShopState();
    const shop = shopStateIndex.get(String(id ?? ""));
    return shop ? Compat.clone(shop) : null;
  }

  static async ensureStableItemIds() {
    if (!game.user.isGM) return false;

    const raw = game.settings.get(MODULE_ID, SETTINGS.SHOPS);
    let parsed;
    try {
      parsed = JSON.parse(raw || "[]");
    } catch {
      return false;
    }

    const sourceShops = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.shops) ? parsed.shops : []);
    const needsMigration = sourceShops.some(shop => {
      const seen = new Set();
      return (Array.isArray(shop?.items) ? shop.items : []).some(entry => {
        const id = String(entry?.id ?? "").trim();
        if (!id || seen.has(id)) return true;
        seen.add(id);
        return false;
      });
    });
    if (!needsMigration) return false;

    const state = readShopState();
    await this.saveAll(state.shops, { expectedStoreRevision: state.revision });
    console.log(`${MODULE_ID} | Добавлены стабильные ID товарным позициям.`);
    return true;
  }

  static async saveAll(shops, { expectedStoreRevision = null } = {}) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const current = readShopState();
    if (expectedStoreRevision != null && current.revision !== expectedStoreRevision) {
      throw new Error("STORE_CONFLICT");
    }

    const normalized = shops.map(normalizeShop);
    const writeId = Compat.randomID();
    const next = {
      revision: current.revision + 1,
      writeId,
      shops: normalized
    };
    await game.settings.set(MODULE_ID, SETTINGS.SHOPS, JSON.stringify(next));
    invalidateShopStateCache();

    const stored = readShopState();
    if (stored.writeId && stored.writeId !== writeId) throw new Error("STORE_CONFLICT");
    return stored.shops.map(shop => Compat.clone(shop));
  }

  static async create(data = {}) {
    const state = readShopState();
    const shop = normalizeShop({
      ...data,
      id: Compat.randomID(),
      revision: 0,
      createdAt: now(),
      updatedAt: now()
    });
    const saved = await this.saveAll([...state.shops, shop], { expectedStoreRevision: state.revision });
    return saved.find(entry => entry.id === shop.id) ?? shop;
  }

  static async update(id, changes = {}, { expectedShopRevision = null } = {}) {
    const state = readShopState();
    const index = state.shops.findIndex(shop => shop.id === id);
    if (index < 0) throw new Error(`Shop not found: ${id}`);
    const current = state.shops[index];
    if (expectedShopRevision != null && current.revision !== expectedShopRevision) {
      throw new Error("STORE_CONFLICT");
    }

    const next = normalizeShop({
      ...current,
      ...changes,
      id,
      revision: current.revision + 1,
      updatedAt: now()
    });
    const shops = [...state.shops];
    shops[index] = next;
    const saved = await this.saveAll(shops, { expectedStoreRevision: state.revision });
    return saved.find(entry => entry.id === id) ?? next;
  }

  static async delete(id, { expectedShopRevision = null } = {}) {
    const state = readShopState();
    const current = state.shops.find(shop => shop.id === id);
    if (!current) return;
    if (expectedShopRevision != null && current.revision !== expectedShopRevision) {
      throw new Error("STORE_CONFLICT");
    }
    await this.saveAll(state.shops.filter(shop => shop.id !== id), { expectedStoreRevision: state.revision });
  }

  static async applyPurchase(
    id,
    entryId,
    amount = 1,
    incomeCopper = 0,
    incomeDenomination = null,
    { expectedShopRevision = null, expectedUuid = null } = {}
  ) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const shop = this.get(id);
    if (!shop) throw new Error("SHOP_NOT_FOUND");
    if (expectedShopRevision != null && shop.revision !== Number(expectedShopRevision)) throw new Error("STORE_CONFLICT");

    const entryIndex = shop.items.findIndex(item => item.id === String(entryId ?? ""));
    const entry = shop.items[entryIndex];
    if (!entry) throw new Error("ITEM_NOT_FOUND");
    if (expectedUuid && entry.uuid !== String(expectedUuid)) throw new Error("STORE_CONFLICT");

    const quantity = Math.max(1, Math.floor(Number(amount) || 1));
    if (entry.quantity != null && entry.quantity < quantity) throw new Error("SOLD_OUT");

    const items = entry.quantity == null
      ? shop.items
      : shop.items.map(item => item.id === entry.id
        ? { ...item, quantity: Math.max(0, item.quantity - quantity) }
        : item);
    const income = Math.max(0, Math.floor(Number(incomeCopper) || 0));
    const wallet = shop.walletEnabled && shop.walletReceivesPayments
      ? Compat.addCopperToCurrencyMap(shop.wallet, income, incomeDenomination)
      : shop.wallet;

    return this.update(id, { items, wallet }, { expectedShopRevision: shop.revision });
  }

  static async decrementStock(id, entryId, amount = 1) {
    return this.applyPurchase(id, entryId, amount, 0);
  }

  static async applySale(id, { sourceUuid = null, amount = 1, costCopper = 0 } = {}) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const shop = this.get(id);
    if (!shop) throw new Error("SHOP_NOT_FOUND");

    const quantity = Math.max(1, Math.floor(Number(amount) || 1));
    const cost = Math.max(0, Math.floor(Number(costCopper) || 0));
    if (shop.walletEnabled && shop.walletCopper < cost) throw new Error("MERCHANT_INSUFFICIENT_FUNDS");

    let items = shop.items;
    if (sourceUuid) {
      const index = shop.items.findIndex(entry => entry.kind !== "service" && entry.uuid === sourceUuid);
      if (index >= 0) {
        items = shop.items.map((entry, entryIndex) => {
          if (entryIndex !== index || entry.quantity == null) return entry;
          return { ...entry, quantity: entry.quantity + quantity };
        });
      } else {
        items = [...shop.items, {
          id: Compat.randomID(),
          uuid: sourceUuid,
          kind: "product",
          groupId: null,
          quantity,
          customPrice: null,
          overrideStockRules: false,
          restockFormula: "",
          depletionFormula: "",
          maxStock: null
        }];
      }
    }

    const wallet = shop.walletEnabled
      ? Compat.deductCopperFromCurrencyMap(shop.wallet, cost).next
      : shop.wallet;
    return this.update(id, { items, wallet }, { expectedShopRevision: shop.revision });
  }

  static async addStock(id, sourceUuid, amount = 1) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const shop = this.get(id);
    if (!shop) throw new Error("SHOP_NOT_FOUND");
    const quantity = Math.max(1, Math.floor(Number(amount) || 1));
    const index = shop.items.findIndex(entry => entry.kind !== "service" && entry.uuid === sourceUuid);
    let items;

    if (index >= 0) {
      items = shop.items.map((entry, entryIndex) => {
        if (entryIndex !== index || entry.quantity == null) return entry;
        return { ...entry, quantity: entry.quantity + quantity };
      });
    } else {
      items = [...shop.items, {
        id: Compat.randomID(),
        uuid: sourceUuid,
        kind: "product",
        groupId: null,
        quantity,
        customPrice: null,
        overrideStockRules: false,
        restockFormula: "",
        depletionFormula: "",
        maxStock: null
      }];
    }

    return this.update(id, { items }, { expectedShopRevision: shop.revision });
  }

  static async duplicate(id) {
    const source = this.get(id);
    if (!source) throw new Error(`Shop not found: ${id}`);
    return this.create({
      ...Compat.clone(source),
      name: `${source.name} — копия`,
      productGroups: (source.productGroups ?? []).map(group => ({ ...group, lastUpdateTime: worldTimeNow() })),
      id: undefined,
      revision: 0
    });
  }

  static getCategories() {
    const parsed = parseJsonSetting(SETTINGS.CATEGORIES, []);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeCategory);
  }

  static async saveCategories(categories) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const normalized = categories.map(normalizeCategory);
    await game.settings.set(MODULE_ID, SETTINGS.CATEGORIES, JSON.stringify(normalized));
    return normalized;
  }

  static async createCategory(name) {
    const categories = this.getCategories();
    const category = normalizeCategory({ name, id: Compat.randomID(), createdAt: now(), updatedAt: now() });
    categories.push(category);
    await this.saveCategories(categories);
    return category;
  }

  static async updateCategory(id, changes = {}) {
    const categories = this.getCategories();
    const index = categories.findIndex(category => category.id === id);
    if (index < 0) throw new Error(`Category not found: ${id}`);
    categories[index] = normalizeCategory({ ...categories[index], ...changes, id, updatedAt: now() });
    await this.saveCategories(categories);
    return categories[index];
  }

  static async deleteCategory(id) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const categories = this.getCategories().filter(category => category.id !== id);
    const state = readShopState();
    const shops = state.shops.map(shop => shop.categoryId === id
      ? normalizeShop({ ...shop, categoryId: null, revision: shop.revision + 1, updatedAt: now() })
      : shop);
    await this.saveAll(shops, { expectedStoreRevision: state.revision });
    await this.saveCategories(categories);
  }

  static getTradeConfig() {
    const stored = normalizeTradeConfig(parseJsonSetting(SETTINGS.TRADE_CONFIG, DEFAULT_TRADE_CONFIG));
    if (stored.initialized) return stored;

    // Однократное чтение старых отдельных настроек 0.2.1.
    try {
      return normalizeTradeConfig({
        initialized: false,
        currencies: {
          pp: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_PP),
          gp: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_GP),
          ep: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_EP),
          sp: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_SP),
          cp: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CP)
        },
        chatReceipts: game.settings.get(MODULE_ID, SETTINGS.CHAT_RECEIPTS)
      });
    } catch {
      return normalizeTradeConfig(DEFAULT_TRADE_CONFIG);
    }
  }

  static async saveTradeConfig(config) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const normalized = normalizeTradeConfig({ ...config, initialized: true });
    await game.settings.set(MODULE_ID, SETTINGS.TRADE_CONFIG, JSON.stringify(normalized));
    Hooks.callAll(`${MODULE_ID}.tradeConfigChanged`, normalized);
    return normalized;
  }

  static get historyLimit() {
    return HISTORY_LIMIT;
  }

  static getHistory() {
    const parsed = parseJsonSetting(SETTINGS.PURCHASE_HISTORY, []);
    return Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry === "object") : [];
  }

  static async saveHistory(entries) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const normalized = (Array.isArray(entries) ? entries : [])
      .filter(entry => entry && typeof entry === "object" && !Array.isArray(entry))
      .map(entry => ({
        ...Compat.clone(entry),
        id: String(entry.id || Compat.randomID()),
        timestamp: Number(entry.timestamp) || now()
      }))
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .slice(-HISTORY_LIMIT);
    await game.settings.set(MODULE_ID, SETTINGS.PURCHASE_HISTORY, JSON.stringify(normalized));
    Hooks.callAll(`${MODULE_ID}.historyChanged`);
    return normalized;
  }

  static async appendHistory(entry) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    const history = this.getHistory();
    history.push({
      id: String(entry.id || Compat.randomID()),
      timestamp: Number(entry.timestamp) || now(),
      ...Compat.clone(entry)
    });
    return this.saveHistory(history);
  }

  static async clearHistory() {
    return this.saveHistory([]);
  }
}
