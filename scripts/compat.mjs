/**
 * Слой совместимости Foundry VTT 13/14 и dnd5e 5.2.x/5.3.x.
 * Остальной модуль не должен обращаться к зависящим от версии API напрямую.
 */

import {
  MODULE_ID,
  SETTINGS,
  DEFAULT_TRADE_CONFIG
} from "./constants.mjs";

const CURRENCY_UNITS = Object.freeze({
  pp: 1000,
  gp: 100,
  ep: 50,
  sp: 10,
  cp: 1
});

const CURRENCY_LABELS = Object.freeze({
  pp: "пм",
  gp: "зм",
  ep: "эм",
  sp: "см",
  cp: "мм"
});

const MERGEABLE_ITEM_TYPES = new Set(["consumable", "equipment", "loot", "tool", "weapon", "container"]);
const UNSALEABLE_ITEM_TYPES = new Set(["background", "class", "subclass", "feat", "race", "species", "spell"]);

function asInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function currencyPath(denomination) {
  return `system.currency.${denomination}`;
}

/**
 * Не используем getFlag("core", "sourceId"): в Foundry 13 этот флаг уже
 * помечен устаревшим. Новые покупки получают собственный флаг модуля.
 * Старые предметы из 0.2.0 всё ещё распознаются по сырому значению флага.
 */
function sourceIdOf(item) {
  return item?.flags?.[MODULE_ID]?.sourceUuid
    ?? item?._stats?.compendiumSource
    ?? item?.flags?.core?.sourceId
    ?? null;
}

function localizedConfigLabel(collection, key) {
  if (!key) return null;
  const entry = collection?.[key];
  const candidate = typeof entry === "string" ? entry : entry?.label ?? entry?.name;
  if (!candidate) return null;
  const localized = game.i18n.localize(candidate);
  return localized && localized !== candidate ? localized : candidate;
}

function sanitizePreviewHTML(html) {
  const wrapper = document.createElement("div");
  const cleaned = typeof globalThis.foundry?.utils?.cleanHTML === "function"
    ? globalThis.foundry.utils.cleanHTML(String(html ?? ""))
    : String(html ?? "");
  wrapper.innerHTML = cleaned;

  const blockedTags = new Set([
    "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT",
    "TEXTAREA", "SELECT", "BUTTON", "VIDEO", "AUDIO", "SOURCE", "TRACK",
    "CANVAS", "SVG", "MATH", "LINK", "META", "BASE"
  ]);
  const allowedTags = new Set([
    "P", "BR", "STRONG", "B", "EM", "I", "U", "S", "SMALL", "SUB", "SUP",
    "UL", "OL", "LI", "DL", "DT", "DD", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "CODE", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD",
    "HR", "SPAN", "DIV", "SECTION", "ARTICLE", "A", "IMG"
  ]);
  const globalAttributes = new Set(["class", "title", "aria-label"]);
  const tableAttributes = new Set(["colspan", "rowspan", "scope"]);
  const imageAttributes = new Set(["src", "alt", "width", "height"]);

  const safeImageSource = value => {
    const source = String(value ?? "").trim();
    if (!source) return false;
    if (/^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(source)) return true;
    if (/^\/\//.test(source) || /^\\\\/.test(source)) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return false;
    return true; // Любой относительный путь остаётся на сервере Foundry.
  };

  for (const element of [...wrapper.querySelectorAll(".secret, [data-secret]")]) element.remove();

  for (const element of [...wrapper.querySelectorAll("*")].reverse()) {
    if (blockedTags.has(element.tagName)) {
      element.remove();
      continue;
    }
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }

    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const allowed = globalAttributes.has(name)
        || (["TH", "TD"].includes(element.tagName) && tableAttributes.has(name))
        || (element.tagName === "IMG" && imageAttributes.has(name));
      if (!allowed || name.startsWith("on") || name.startsWith("data-") || name === "style" || name === "id") {
        element.removeAttribute(attribute.name);
      }
    }

    if (element.hasAttribute("class")) {
      const classes = [...element.classList]
        .filter(name => /^[a-z0-9_-]+$/i.test(name))
        .filter(name => !["secret", "content-link", "inline-roll"].includes(name));
      element.className = classes.join(" ");
      if (!classes.length) element.removeAttribute("class");
    }

    if (element.tagName === "IMG") {
      if (!safeImageSource(element.getAttribute("src"))) {
        element.remove();
        continue;
      }
      for (const name of ["width", "height"]) {
        const value = element.getAttribute(name);
        if (value != null && !/^\d{1,4}$/.test(value)) element.removeAttribute(name);
      }
      element.setAttribute("loading", "lazy");
      element.setAttribute("decoding", "async");
    }
  }

  // Ссылки и броски в карточке только читаются. UUID закрытых документов,
  // активные переходы и выполнение inline-roll в результат не попадают.
  for (const anchor of [...wrapper.querySelectorAll("a")]) {
    const replacement = document.createElement("span");
    replacement.className = "sw-preview-reference";
    replacement.append(...anchor.childNodes);
    anchor.replaceWith(replacement);
  }
  for (const reference of wrapper.querySelectorAll(".content-link, .inline-roll")) {
    reference.classList.remove("content-link", "inline-roll");
    reference.classList.add("sw-preview-reference");
  }

  return wrapper.innerHTML;
}

function getTradeConfig() {
  try {
    if (!game?.settings) return foundry.utils.deepClone(DEFAULT_TRADE_CONFIG);
    const raw = game.settings.get(MODULE_ID, SETTINGS.TRADE_CONFIG);
    const parsed = JSON.parse(raw || JSON.stringify(DEFAULT_TRADE_CONFIG));
    if (parsed?.initialized !== true) {
      return {
        initialized: false,
        currencies: {
          pp: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_PP) !== false,
          gp: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_GP) !== false,
          ep: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_EP) !== false,
          sp: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_SP) !== false,
          cp: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_CP) !== false
        },
        chatReceipts: game.settings.get(MODULE_ID, SETTINGS.CHAT_RECEIPTS) !== false
      };
    }

    const currencies = parsed?.currencies ?? {};
    return {
      initialized: true,
      currencies: {
        pp: currencies.pp !== false,
        gp: currencies.gp !== false,
        ep: currencies.ep !== false,
        sp: currencies.sp !== false,
        cp: currencies.cp !== false
      },
      chatReceipts: parsed?.chatReceipts !== false
    };
  } catch {
    return foundry.utils.deepClone(DEFAULT_TRADE_CONFIG);
  }
}

export const Compat = {
  get coreGeneration() {
    return Number(game.release?.generation ?? String(game.version ?? "0").split(".")[0]);
  },

  get systemVersion() {
    return String(game.system?.version ?? "0");
  },

  randomID(length = 16) {
    return foundry.utils.randomID(length);
  },

  clone(value) {
    return foundry.utils.deepClone(value);
  },

  escapeHTML(value) {
    return foundry.utils.escapeHTML(String(value ?? ""));
  },

  async fromUuid(uuid) {
    if (!uuid) return null;
    return foundry.utils.fromUuid(uuid);
  },

  async resolveUuids(uuids, { documentName = null } = {}) {
    const unique = [...new Set((Array.isArray(uuids) ? uuids : [])
      .map(uuid => String(uuid ?? "").trim())
      .filter(Boolean))];
    const resolved = new Map(unique.map(uuid => [uuid, null]));
    if (!unique.length) return resolved;

    const packGroups = new Map();
    const fallback = new Set();

    for (const uuid of unique) {
      let parsed = null;
      try {
        parsed = foundry.utils.parseUuid(uuid);
      } catch {
        fallback.add(uuid);
        continue;
      }

      const collection = parsed?.collection ?? null;
      const id = String(parsed?.id ?? parsed?.documentId ?? "").trim();
      const type = String(parsed?.type ?? parsed?.documentType ?? collection?.documentName ?? "");
      const embedded = Array.isArray(parsed?.embedded) ? parsed.embedded : [];
      const typeMatches = !documentName || !type || type === documentName;

      if (!id || embedded.length || !typeMatches) {
        fallback.add(uuid);
        continue;
      }

      if (collection === game.items) {
        resolved.set(uuid, game.items.get(id) ?? null);
        continue;
      }

      if (uuid.startsWith("Compendium.") && typeof collection?.getDocuments === "function") {
        let byId = packGroups.get(collection);
        if (!byId) {
          byId = new Map();
          packGroups.set(collection, byId);
        }
        const refs = byId.get(id) ?? [];
        refs.push(uuid);
        byId.set(id, refs);
        continue;
      }

      fallback.add(uuid);
    }

    await Promise.all([...packGroups.entries()].map(async ([pack, byId]) => {
      try {
        const documents = await pack.getDocuments({ _id__in: [...byId.keys()] });
        const byDocumentId = new Map(documents.map(document => [document.id, document]));
        for (const [id, refs] of byId) {
          const document = byDocumentId.get(id) ?? null;
          for (const uuid of refs) resolved.set(uuid, document);
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | Не удалось пакетно загрузить документы из ${pack.collection ?? "Compendium"}`, error);
        for (const refs of byId.values()) for (const uuid of refs) fallback.add(uuid);
      }
    }));

    await Promise.all([...fallback].map(async uuid => {
      try {
        resolved.set(uuid, await foundry.utils.fromUuid(uuid));
      } catch (error) {
        console.warn(`${MODULE_ID} | Не удалось получить документ ${uuid}`, error);
        resolved.set(uuid, null);
      }
    }));

    return resolved;
  },

  renderSheet(document) {
    const sheet = document?.sheet;
    if (!sheet) return;
    const ApplicationV2 = foundry.applications.api.ApplicationV2;
    if (sheet instanceof ApplicationV2) return sheet.render({ force: true });
    return sheet.render(true);
  },

  renderApplication(application) {
    return application.render({ force: true });
  },

  async copyText(text) {
    const value = String(text ?? "");
    if (!value) return false;

    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    }
  },

  getItemPrice(item) {
    const raw = item?.system?.price?.value;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  },

  getItemCurrency(item) {
    return String(item?.system?.price?.denomination ?? "gp");
  },

  getItemQuantity(item) {
    const value = Number(item?.system?.quantity);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  },

  getItemSourceUuid(item) {
    return sourceIdOf(item);
  },

  canSellItem(item) {
    if (!item || item.documentName !== "Item") return false;
    if (UNSALEABLE_ITEM_TYPES.has(String(item.type ?? ""))) return false;
    if (this.getItemPrice(item) <= 0 || this.getItemQuantity(item) <= 0) return false;
    const contents = item?.system?.container?.contents;
    if (Array.isArray(contents) && contents.length > 0) return false;
    return true;
  },

  getSellableItems(actor) {
    return Array.from(actor?.items ?? [])
      .filter(item => this.canSellItem(item))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  },

  getItemTypeLabel(item) {
    const type = String(item?.type ?? "");
    const key = CONFIG.Item?.typeLabels?.[type] ?? `TYPES.Item.${type}`;
    const localized = game.i18n.localize(key);
    return localized && localized !== key ? localized : type;
  },

  getItemRarityLabel(item) {
    const raw = item?.system?.rarity?.value ?? item?.system?.rarity;
    const rarity = typeof raw === "string" ? raw.trim() : "";
    if (!rarity) return null;

    const config = CONFIG.DND5E?.itemRarity
      ?? CONFIG.DND5E?.itemRarities
      ?? CONFIG.DND5E?.rarities;
    return localizedConfigLabel(config, rarity) ?? rarity;
  },

  getItemWeightText(item) {
    const raw = item?.system?.weight?.value ?? item?.system?.weight;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;

    const unitRaw = item?.system?.weight?.units;
    const unit = localizedConfigLabel(CONFIG.DND5E?.weightUnits, unitRaw)
      ?? (unitRaw ? String(unitRaw) : null);
    return unit ? `${value.toLocaleString(game.i18n.lang)} ${unit}` : value.toLocaleString(game.i18n.lang);
  },

  getItemPropertyLabels(item) {
    const prepared = Array.isArray(item?.labels?.properties)
      ? item.labels.properties
          .map(property => typeof property === "string" ? property : property?.label)
          .filter(Boolean)
      : [];
    if (prepared.length) return [...new Set(prepared)];

    const raw = item?.system?.properties;
    const values = raw instanceof Set
      ? [...raw]
      : Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object"
          ? Object.keys(raw).filter(key => raw[key])
          : [];

    return [...new Set(values.map(key => {
      return localizedConfigLabel(CONFIG.DND5E?.itemProperties, key) ?? String(key);
    }).filter(Boolean))];
  },

  async prepareItemPreviewDescription(item) {
    let raw = String(item?.system?.description?.value ?? "").trim();
    if (!raw) return '<p class="sw-preview-no-description">Описание не указано.</p>';

    // Встроенные документы не разворачиваем: они могли бы раскрыть содержимое
    // других закрытых компендиумов и заметно увеличить размер socket-ответа.
    raw = raw.replace(/@Embed\[[^\]]+\](?:\{[^}]*\})?/gi, "<em>Встроенный материал скрыт.</em>");

    const TextEditor = foundry.applications.ux.TextEditor;
    let rollData = {};
    try {
      if (typeof item?.getRollData === "function") rollData = item.getRollData() ?? {};
    } catch (error) {
      console.debug(`${MODULE_ID} | У предмета без владельца нет данных для бросков`, error);
    }

    const enriched = await TextEditor.enrichHTML(raw, {
      relativeTo: item,
      rollData,
      secrets: false,
      documents: true,
      embeds: false,
      links: true,
      rolls: true,
      custom: true
    });

    return sanitizePreviewHTML(enriched);
  },

  getProductGroup(shop, groupId) {
    if (!groupId) return null;
    return (shop?.productGroups ?? []).find(group => group.id === groupId) ?? null;
  },

  calculateShopPrice(shop, entry, item) {
    const basePrice = this.getItemPrice(item);
    const shopMultiplier = Number(shop?.priceMultiplier);
    const safeShopMultiplier = Number.isFinite(shopMultiplier) && shopMultiplier > 0 ? shopMultiplier : 1;
    const group = entry?.kind === "service" ? null : this.getProductGroup(shop, entry?.groupId);
    const groupMultiplier = Number(group?.priceMultiplier);
    const safeGroupMultiplier = Number.isFinite(groupMultiplier) && groupMultiplier > 0 ? groupMultiplier : 1;
    const customPrice = entry?.customPrice;
    const price = customPrice == null
      ? Math.round(basePrice * safeShopMultiplier * safeGroupMultiplier * 100) / 100
      : Number(customPrice);
    return Number.isFinite(price) ? Math.max(0, price) : 0;
  },

  calculateSaleUnitPrice(shop, item) {
    const multiplier = Number(shop?.buybackMultiplier);
    const safeMultiplier = Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 0.5;
    const price = Math.round(this.getItemPrice(item) * safeMultiplier * 100) / 100;
    return Number.isFinite(price) ? Math.max(0, price) : 0;
  },

  formatPrice(value, denomination = "gp") {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : 0;
    return `${safe.toLocaleString(game.i18n.lang)} ${CURRENCY_LABELS[denomination] ?? denomination}`;
  },

  /**
   * Структурная цена для интерфейса: номинал отделён от числа, чтобы
   * шаблон мог покрасить его по металлу. Для чата и уведомлений
   * по-прежнему используется formatPrice().
   */
  formatPriceParts(value, denomination = "gp") {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : 0;
    return {
      amount: safe.toLocaleString(game.i18n.lang),
      denom: denomination,
      label: CURRENCY_LABELS[denomination] ?? denomination
    };
  },

  /** Кошелёк в виде массива номиналов. Пустой массив = монет нет. */
  formatWalletParts(wallet = {}) {
    const enabled = new Set(this.getEnabledCurrencyKeys());
    return Object.keys(CURRENCY_UNITS)
      .filter(key => enabled.has(key) && asInteger(wallet?.[key]) > 0)
      .sort((a, b) => CURRENCY_UNITS[b] - CURRENCY_UNITS[a])
      .map(key => ({
        amount: asInteger(wallet[key]).toLocaleString(game.i18n.lang),
        denom: key,
        label: CURRENCY_LABELS[key]
      }));
  },

  /** Кошелёк актёра в виде массива номиналов. */
  formatActorWalletParts(actor) {
    return this.formatWalletParts(this.getActorCurrency(actor));
  },

  /**
   * Машинный ключ редкости для полосы слева у строки.
   * Именно ключ, а не локализованная подпись: по нему выбирается цвет.
   */
  getItemRarityKey(document) {
    const value = document?.system?.rarity;
    if (typeof value === "string") return value;
    if (typeof value?.value === "string") return value.value;
    return "";
  },

  formatCurrencyBreakdown(currency = {}, emptyText = "—") {
    const parts = Object.keys(CURRENCY_UNITS)
      .filter(key => asInteger(currency[key]) > 0)
      .map(key => `${asInteger(currency[key]).toLocaleString(game.i18n.lang)} ${CURRENCY_LABELS[key]}`);
    return parts.length ? parts.join(", ") : emptyText;
  },

  isCurrencyEnabled(denomination) {
    if (!Object.prototype.hasOwnProperty.call(CURRENCY_UNITS, denomination)) return false;
    return getTradeConfig().currencies[denomination] !== false;
  },

  getEnabledCurrencyKeys() {
    return Object.keys(CURRENCY_UNITS).filter(key => this.isCurrencyEnabled(key));
  },

  getCurrencyLabel(denomination) {
    return CURRENCY_LABELS[denomination] ?? denomination;
  },

  getCurrencyUnit(denomination) {
    return CURRENCY_UNITS[denomination] ?? null;
  },

  currencyMapInCopper(currency = {}, { enabledOnly = true } = {}) {
    const keys = enabledOnly ? this.getEnabledCurrencyKeys() : Object.keys(CURRENCY_UNITS);
    return keys.reduce((total, key) => total + asInteger(currency?.[key]) * CURRENCY_UNITS[key], 0);
  },

  copperToCurrency(totalCopper, { enabledOnly = true } = {}) {
    let remaining = Math.max(0, Math.floor(Number(totalCopper) || 0));
    const keys = (enabledOnly ? this.getEnabledCurrencyKeys() : Object.keys(CURRENCY_UNITS))
      .sort((a, b) => CURRENCY_UNITS[b] - CURRENCY_UNITS[a]);
    const currency = {};
    for (const key of keys) {
      const coins = Math.floor(remaining / CURRENCY_UNITS[key]);
      currency[key] = coins;
      remaining -= coins * CURRENCY_UNITS[key];
    }
    return { currency, remainder: remaining };
  },

  formatCopper(totalCopper, emptyText = "монет нет") {
    const { currency, remainder } = this.copperToCurrency(totalCopper);
    const text = this.formatCurrencyBreakdown(currency, emptyText);
    return remainder > 0 ? `${text} + ${remainder} мм экв.` : text;
  },

  getWalletCurrencyFields(wallet = {}) {
    return this.getEnabledCurrencyKeys().map(key => ({
      key,
      label: this.getCurrencyLabel(key),
      value: asInteger(wallet?.[key])
    }));
  },

  normalizeCurrencyMap(currency = {}) {
    return Object.fromEntries(Object.keys(CURRENCY_UNITS).map(key => [key, asInteger(currency?.[key])]));
  },

  addCopperToCurrencyMap(currency = {}, totalCopper = 0, preferredDenomination = null) {
    const next = this.normalizeCurrencyMap(currency);
    let remaining = Math.max(0, Math.floor(Number(totalCopper) || 0));
    const enabled = this.getEnabledCurrencyKeys();
    if (!enabled.length) throw new Error("NO_ENABLED_CURRENCY");

    const order = [];
    if (preferredDenomination && enabled.includes(preferredDenomination)) order.push(preferredDenomination);
    for (const key of [...enabled].sort((a, b) => CURRENCY_UNITS[b] - CURRENCY_UNITS[a])) {
      if (!order.includes(key)) order.push(key);
    }

    for (const key of order) {
      const unit = CURRENCY_UNITS[key];
      const coins = Math.floor(remaining / unit);
      if (coins <= 0) continue;
      next[key] += coins;
      remaining -= coins * unit;
    }
    if (remaining !== 0) throw new Error("CANNOT_MAKE_CHANGE");
    return next;
  },

  deductCopperFromCurrencyMap(currency = {}, costCopper = 0) {
    const original = this.normalizeCurrencyMap(currency);
    const cost = Math.max(0, Math.floor(Number(costCopper) || 0));
    const enabled = this.getEnabledCurrencyKeys();
    if (!enabled.length) throw new Error("NO_ENABLED_CURRENCY");
    if (this.currencyMapInCopper(original) < cost) throw new Error("MERCHANT_INSUFFICIENT_FUNDS");
    if (cost === 0) return { original, next: { ...original }, paid: {}, change: {} };

    const next = { ...original };
    const ascending = [...enabled].sort((a, b) => CURRENCY_UNITS[a] - CURRENCY_UNITS[b]);
    let remaining = cost;
    for (const key of ascending) {
      const unit = CURRENCY_UNITS[key];
      const spend = Math.min(next[key], Math.floor(remaining / unit));
      if (spend <= 0) continue;
      next[key] -= spend;
      remaining -= spend * unit;
      if (remaining === 0) break;
    }

    if (remaining > 0) {
      const breaking = ascending.find(key => CURRENCY_UNITS[key] > remaining && next[key] > 0);
      if (!breaking) throw new Error("MERCHANT_INSUFFICIENT_FUNDS");
      next[breaking] -= 1;
      let changeCopper = CURRENCY_UNITS[breaking] - remaining;
      remaining = 0;
      const descending = [...ascending].sort((a, b) => CURRENCY_UNITS[b] - CURRENCY_UNITS[a]);
      for (const key of descending) {
        const unit = CURRENCY_UNITS[key];
        const coins = Math.floor(changeCopper / unit);
        if (coins <= 0) continue;
        next[key] += coins;
        changeCopper -= coins * unit;
      }
      if (changeCopper !== 0) throw new Error("CANNOT_MAKE_CHANGE");
    }

    const paid = {};
    const change = {};
    for (const key of Object.keys(CURRENCY_UNITS)) {
      const delta = original[key] - next[key];
      if (delta > 0) paid[key] = delta;
      else if (delta < 0) change[key] = Math.abs(delta);
    }
    return { original, next, paid, change };
  },

  formatWallet(wallet = {}, emptyText = "монет нет") {
    const enabled = new Set(this.getEnabledCurrencyKeys());
    const filtered = Object.fromEntries(Object.keys(CURRENCY_UNITS).map(key => [key, enabled.has(key) ? asInteger(wallet?.[key]) : 0]));
    return this.formatCurrencyBreakdown(filtered, emptyText);
  },

  getActorCurrency(actor) {
    const currency = actor?.system?.currency ?? {};
    return Object.fromEntries(Object.keys(CURRENCY_UNITS).map(key => [key, asInteger(currency[key])]));
  },

  formatActorWallet(actor) {
    const currency = this.getActorCurrency(actor);
    const parts = this.getEnabledCurrencyKeys()
      .filter(key => currency[key] > 0)
      .map(key => `${currency[key].toLocaleString(game.i18n.lang)} ${CURRENCY_LABELS[key]}`);
    return parts.length ? parts.join(", ") : "монет нет";
  },

  getActorTypeLabel(actor) {
    const key = CONFIG.Actor?.typeLabels?.[actor?.type];
    if (key) return game.i18n.localize(key);
    return String(actor?.type ?? "Actor");
  },

  actorHasCurrency(actor) {
    return Boolean(actor?.system?.currency && typeof actor.system.currency === "object");
  },

  canPurchaseAs(actor, user = game.user) {
    if (!actor || actor.documentName !== "Actor" || !this.actorHasCurrency(actor) || !user) return false;
    if (user.isGM) return true;
    const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    return actor.testUserPermission(user, owner);
  },

  getPurchasableActors(user = game.user) {
    const candidates = [];
    for (const actor of game.actors?.contents ?? []) candidates.push(actor);

    // Независимые токены имеют синтетических актёров, которых нет в game.actors.
    for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
      const actor = token?.actor;
      if (actor?.isToken) candidates.push(actor);
    }

    const unique = new Map();
    for (const actor of candidates) {
      if (!actor?.uuid || unique.has(actor.uuid)) continue;
      if (!this.canPurchaseAs(actor, user)) continue;
      unique.set(actor.uuid, actor);
    }

    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  },

  priceInCopper(value, denomination = "gp") {
    const unit = CURRENCY_UNITS[denomination];
    const amount = Number(value);
    if (!unit || !Number.isFinite(amount) || amount < 0) return null;
    return Math.round(amount * unit);
  },

  actorWealthInCopper(actor) {
    const currency = this.getActorCurrency(actor);
    return this.getEnabledCurrencyKeys()
      .reduce((total, key) => total + currency[key] * CURRENCY_UNITS[key], 0);
  },

  canAfford(actor, value, denomination = "gp") {
    const cost = this.priceInCopper(value, denomination);
    return cost != null && this.actorWealthInCopper(actor) >= cost;
  },

  /**
   * Рассчитывает новые значения кошелька, не изменяя Actor.
   * Отключённые в настройках валюты полностью игнорируются: они не считаются
   * частью кошелька, не списываются и не выдаются как сдача.
   */
  getCurrencyDeduction(actor, value, denomination = "gp") {
    const cost = this.priceInCopper(value, denomination);
    if (cost == null) throw new Error("UNSUPPORTED_CURRENCY");

    const enabled = this.getEnabledCurrencyKeys();
    if (!enabled.length) throw new Error("NO_ENABLED_CURRENCY");

    const original = this.getActorCurrency(actor);
    if (cost === 0) return {
      original,
      next: { ...original },
      updates: {},
      costCopper: 0,
      paid: {},
      change: {}
    };
    if (this.actorWealthInCopper(actor) < cost) throw new Error("INSUFFICIENT_FUNDS");

    const next = { ...original };
    const ascending = enabled.sort((a, b) => CURRENCY_UNITS[a] - CURRENCY_UNITS[b]);
    let remaining = cost;

    // Оплачиваем максимально возможную часть монетами не крупнее остатка.
    for (const key of ascending) {
      const unit = CURRENCY_UNITS[key];
      const spend = Math.min(next[key], Math.floor(remaining / unit));
      if (spend <= 0) continue;
      next[key] -= spend;
      remaining -= spend * unit;
      if (remaining === 0) break;
    }

    // Если точной суммы не набралось, разбиваем наименьшую подходящую
    // разрешённую монету и выдаём сдачу только разрешёнными валютами.
    if (remaining > 0) {
      const breaking = ascending.find(key => CURRENCY_UNITS[key] > remaining && next[key] > 0);
      if (!breaking) throw new Error("INSUFFICIENT_FUNDS");
      next[breaking] -= 1;
      let change = CURRENCY_UNITS[breaking] - remaining;
      remaining = 0;

      const descending = [...ascending].sort((a, b) => CURRENCY_UNITS[b] - CURRENCY_UNITS[a]);
      for (const key of descending) {
        const unit = CURRENCY_UNITS[key];
        const coins = Math.floor(change / unit);
        if (coins <= 0) continue;
        next[key] += coins;
        change -= coins * unit;
      }

      if (change !== 0) throw new Error("CANNOT_MAKE_CHANGE");
    }

    const updates = {};
    for (const key of enabled) {
      if (next[key] !== original[key]) updates[currencyPath(key)] = next[key];
    }

    const paid = {};
    const change = {};
    for (const key of Object.keys(CURRENCY_UNITS)) {
      const delta = original[key] - next[key];
      if (delta > 0) paid[key] = delta;
      else if (delta < 0) change[key] = Math.abs(delta);
    }

    return { original, next, updates, costCopper: cost, paid, change };
  },

  getCurrencyAddition(actor, value, denomination = "gp") {
    const total = this.priceInCopper(value, denomination);
    if (total == null) throw new Error("UNSUPPORTED_CURRENCY");

    const enabled = this.getEnabledCurrencyKeys();
    if (!enabled.length) throw new Error("NO_ENABLED_CURRENCY");

    const original = this.getActorCurrency(actor);
    if (total === 0) return {
      original,
      next: { ...original },
      updates: {},
      totalCopper: 0,
      received: {}
    };

    const next = { ...original };
    let remaining = total;
    const descending = [...enabled].sort((a, b) => CURRENCY_UNITS[b] - CURRENCY_UNITS[a]);
    const received = {};

    for (const key of descending) {
      const unit = CURRENCY_UNITS[key];
      const coins = Math.floor(remaining / unit);
      if (coins <= 0) continue;
      next[key] += coins;
      received[key] = coins;
      remaining -= coins * unit;
    }

    if (remaining !== 0) throw new Error("CANNOT_MAKE_CHANGE");

    const updates = {};
    for (const key of enabled) {
      if (next[key] !== original[key]) updates[currencyPath(key)] = next[key];
    }
    return { original, next, updates, totalCopper: total, received };
  },

  currencyRestoreUpdates(currency) {
    return Object.fromEntries(Object.keys(CURRENCY_UNITS).map(key => [currencyPath(key), asInteger(currency?.[key])]));
  },

  async addPurchasedItem(actor, sourceItem, purchaseCount = 1) {
    const count = Math.max(1, Math.floor(Number(purchaseCount) || 1));
    const sourceQuantity = this.getItemQuantity(sourceItem) * count;
    const sourceUuid = sourceItem.uuid;
    const items = Array.from(actor.items ?? []);
    const hasContents = Array.isArray(sourceItem?.system?.container?.contents)
      && sourceItem.system.container.contents.length > 0;
    const canMerge = MERGEABLE_ITEM_TYPES.has(sourceItem.type) && !hasContents;

    const existing = canMerge
      ? items.find(item => sourceIdOf(item) === sourceUuid && item.type === sourceItem.type)
      : null;

    if (existing) {
      const previousQuantity = asInteger(existing.system?.quantity);
      await existing.update({ "system.quantity": previousQuantity + sourceQuantity });
      return { mode: "update", item: existing, previousQuantity };
    }

    const data = sourceItem.toObject();
    delete data._id;
    delete data.folder;
    delete data.sort;
    delete data.ownership;
    delete data._stats;

    data.flags ??= {};
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID].sourceUuid = sourceUuid;
    data.system ??= {};
    data.system.quantity = sourceQuantity;

    // Не переносим устаревший core.sourceId в новые документы.
    if (data.flags.core && Object.prototype.hasOwnProperty.call(data.flags.core, "sourceId")) {
      delete data.flags.core.sourceId;
    }

    const [created] = await actor.createEmbeddedDocuments("Item", [data]);
    if (!created) throw new Error("ITEM_CREATE_FAILED");
    return { mode: "create", item: created };
  },

  async rollbackPurchasedItem(receipt) {
    if (!receipt?.item) return;
    if (receipt.mode === "create") {
      await receipt.item.delete();
      return;
    }
    if (receipt.mode === "update") {
      await receipt.item.update({ "system.quantity": receipt.previousQuantity });
    }
  },

  async removeSoldItem(item, quantity = 1) {
    const amount = Math.max(1, Math.floor(Number(quantity) || 1));
    const available = this.getItemQuantity(item);
    if (amount > available) throw new Error("NOT_ENOUGH_ITEMS");

    if (amount < available) {
      await item.update({ "system.quantity": available - amount });
      return { mode: "update", item, previousQuantity: available };
    }

    const actor = item.parent;
    const data = item.toObject();
    await item.delete();
    return { mode: "delete", actor, data };
  },

  async rollbackSoldItem(receipt) {
    if (!receipt) return;
    if (receipt.mode === "update" && receipt.item) {
      await receipt.item.update({ "system.quantity": receipt.previousQuantity });
      return;
    }
    if (receipt.mode === "delete" && receipt.actor && receipt.data) {
      try {
        await receipt.actor.createEmbeddedDocuments("Item", [receipt.data], { keepId: true });
      } catch {
        const data = this.clone(receipt.data);
        delete data._id;
        await receipt.actor.createEmbeddedDocuments("Item", [data]);
      }
    }
  },

  getPrimaryActiveGM() {
    const active = (game.users?.contents ?? [])
      .filter(user => user.active && user.isGM)
      .sort((a, b) => a.id.localeCompare(b.id));
    return active[0] ?? null;
  },

  shouldPostChatReceipts() {
    return getTradeConfig().chatReceipts !== false;
  },

  async confirmPurchase({
    title = "Подтверждение покупки",
    content = "",
    quantity = 1,
    maxQuantity = null,
    showQuantity = true,
    privateLabel = "Приватная покупка",
    privateHint = "Чек увидите вы и ведущие. Остальные игроки не узнают об операции из чата."
  } = {}) {
    const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
    const safeMax = maxQuantity == null ? null : Math.max(1, Math.floor(Number(maxQuantity) || 1));
    const quantityBlock = !showQuantity || safeMax === 1 ? "" : `
      <label class="sw-transaction-quantity">
        <span><strong>Количество</strong><small>${safeMax == null ? "Можно указать любое положительное число." : `Доступно не больше ${safeMax}.`}</small></span>
        <input type="number" name="quantity" value="${Math.min(safeQuantity, safeMax ?? safeQuantity)}" min="1" ${safeMax == null ? "" : `max="${safeMax}"`} step="1">
      </label>`;

    const result = await foundry.applications.api.DialogV2.wait({
      classes: [MODULE_ID, "sw-dialog"],
      window: { title },
      content: `
        <div class="sw-purchase-confirm">
          <div class="sw-purchase-confirm-copy">${content}</div>
          ${quantityBlock}
          <label class="sw-private-purchase-option">
            <input type="checkbox" name="privatePurchase">
            <span>
              <strong><i class="fa-solid fa-user-secret"></i> ${this.escapeHTML(privateLabel)}</strong>
              <small>${this.escapeHTML(privateHint)}</small>
            </span>
          </label>
        </div>`,
      buttons: [
        {
          action: "confirm",
          label: "Подтвердить",
          icon: "fa-solid fa-check",
          default: true,
          callback: (event, button) => {
            const rawQuantity = Number(button.form?.elements?.quantity?.value ?? 1);
            const selectedQuantity = Math.max(1, Math.floor(Number.isFinite(rawQuantity) ? rawQuantity : 1));
            return {
              confirmed: true,
              quantity: safeMax == null ? selectedQuantity : Math.min(selectedQuantity, safeMax),
              privatePurchase: Boolean(button.form?.elements?.privatePurchase?.checked)
            };
          }
        },
        {
          action: "cancel",
          label: "Отмена",
          icon: "fa-solid fa-xmark",
          callback: () => null
        }
      ],
      rejectClose: false,
      modal: true
    });
    return result?.confirmed ? result : null;
  },

  async promptText({
    title = "Введите значение",
    label = "Значение",
    value = "",
    placeholder = "",
    confirmLabel = "Сохранить"
  } = {}) {
    const result = await foundry.applications.api.DialogV2.wait({
      classes: [MODULE_ID, "sw-dialog", "sw-prompt-dialog"],
      window: { title },
      content: `
        <div class="sw-dialog-form">
          <label>
            <span>${this.escapeHTML(label)}</span>
            <input type="text" name="value" value="${this.escapeHTML(value)}" placeholder="${this.escapeHTML(placeholder)}" autofocus>
          </label>
        </div>`,
      buttons: [
        {
          action: "confirm",
          label: confirmLabel,
          icon: "fa-solid fa-check",
          default: true,
          callback: (event, button) => String(button.form?.elements?.value?.value ?? "").trim()
        },
        {
          action: "cancel",
          label: "Отмена",
          icon: "fa-solid fa-xmark",
          callback: () => null
        }
      ],
      rejectClose: false,
      modal: true
    });
    return typeof result === "string" ? result : null;
  },

  async confirm({ title = "Подтверждение", content = "Вы уверены?" } = {}) {
    return foundry.applications.api.DialogV2.confirm({
      classes: [MODULE_ID, "sw-dialog"],
      window: { title },
      content,
      rejectClose: false,
      modal: true
    });
  }
};
