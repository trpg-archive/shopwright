import { MODULE_ID, SETTINGS } from "../constants.mjs";
import { Compat } from "../compat.mjs";
import { ShopStore } from "../storage.mjs";
import { RestockService } from "../restock.mjs";
import { PurchaseService } from "../purchase.mjs";
import { BuyerPickerApp } from "./buyer-picker.mjs";
import { ItemPreviewApp } from "./item-preview.mjs";
import { ShopEditorApp } from "./shop-editor.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function positiveInteger(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sortShopItems(items, key = "name", direction = "asc") {
  const sign = direction === "desc" ? -1 : 1;
  const locale = game.i18n.lang;
  return items.slice().sort((a, b) => {
    if (Boolean(a.missing) !== Boolean(b.missing)) return a.missing ? 1 : -1;

    let result = 0;
    if (key === "price") {
      const left = Number.isFinite(a.sortPriceCopper) ? a.sortPriceCopper : Number.POSITIVE_INFINITY;
      const right = Number.isFinite(b.sortPriceCopper) ? b.sortPriceCopper : Number.POSITIVE_INFINITY;
      result = left - right;
    } else if (key === "quantity") {
      const left = Number.isFinite(a.sortQuantity) ? a.sortQuantity : Number.POSITIVE_INFINITY;
      const right = Number.isFinite(b.sortQuantity) ? b.sortQuantity : Number.POSITIVE_INFINITY;
      result = left - right;
    } else {
      result = String(a.name ?? "").localeCompare(String(b.name ?? ""), locale, { sensitivity: "base", numeric: true });
    }

    if (!result) result = String(a.name ?? "").localeCompare(String(b.name ?? ""), locale, { sensitivity: "base", numeric: true });
    if (!result) result = Number(a.index ?? 0) - Number(b.index ?? 0);
    return result * sign;
  });
}

export class StorefrontApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ shopId, ...options } = {}) {
    super(options);
    this.shopId = shopId;
    this.buyerUuid = game.settings.get(MODULE_ID, SETTINGS.LAST_BUYER) || null;
    this.transactionPending = false;
    this.currentTab = "products";
    this.searchQuery = "";
    this.sortKey = "name";
    this.sortDirection = "asc";
    this.restockCheckedAt = null;
    this.restockCheckPromise = null;
    this.performanceLogged = false;

    this.stockHook = Hooks.on(`${MODULE_ID}.stockChanged`, changedShopId => {
      if (changedShopId !== this.shopId || !this.rendered) return;
      this.restockCheckedAt = null;
      this.render({ force: true });
    });

    this.actorHook = Hooks.on("updateActor", actor => {
      if (actor.uuid === this.buyerUuid && this.rendered) this.render({ force: true });
    });

    this.itemHooks = ["createItem", "updateItem", "deleteItem"].map(hookName => Hooks.on(hookName, item => {
      if (item?.parent?.uuid === this.buyerUuid && this.rendered) this.render({ force: true });
    }));

    this.addEventListener("close", () => {
      Hooks.off(`${MODULE_ID}.stockChanged`, this.stockHook);
      Hooks.off("updateActor", this.actorHook);
      for (const [index, hookName] of ["createItem", "updateItem", "deleteItem"].entries()) {
        Hooks.off(hookName, this.itemHooks[index]);
      }
    }, { once: true });
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "sw-storefront"],
    window: {
      resizable: true,
      title: "Магазин",
      icon: "fa-solid fa-basket-shopping"
    },
    position: {
      width: 860,
      height: 720
    }
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/storefront.hbs`,
      scrollable: [".sw-store-items"]
    }
  };

  async _ensureRestockChecked(shop = null) {
    const worldTime = Number(game.time?.worldTime) || 0;
    if (this.restockCheckedAt === worldTime) return { ok: true, changed: false, cached: true };
    if (this.restockCheckPromise) return this.restockCheckPromise;

    const currentShop = shop ?? ShopStore.get(this.shopId);
    if (!currentShop || !RestockService.hasDueRestock(currentShop, worldTime)) {
      this.restockCheckedAt = worldTime;
      return { ok: true, changed: false, skipped: true };
    }

    this.restockCheckedAt = worldTime;
    this.restockCheckPromise = PurchaseService.requestRestock({ shopId: this.shopId })
      .then(result => {
        if (!result?.ok) this.restockCheckedAt = null;
        return result;
      })
      .catch(error => {
        this.restockCheckedAt = null;
        console.warn(`${MODULE_ID} | Не удалось проверить пополнение магазина`, error);
      })
      .finally(() => { this.restockCheckPromise = null; });
    return this.restockCheckPromise;
  }

  async _resolveBuyer() {
    if (!this.buyerUuid) return null;
    const actor = await Compat.fromUuid(this.buyerUuid);
    if (Compat.canPurchaseAs(actor, game.user)) return actor;
    this.buyerUuid = null;
    await game.settings.set(MODULE_ID, SETTINGS.LAST_BUYER, "");
    return null;
  }

  async _prepareContext(options) {
    const performanceStart = performance.now();
    const timings = {};
    const context = await super._prepareContext(options);

    let started = performance.now();
    let shop = ShopStore.get(this.shopId);
    timings.shopLookupMs = performance.now() - started;
    if (!shop) {
      if (!this.performanceLogged) {
        this.performanceLogged = true;
        console.info(`${MODULE_ID} | Подготовка витрины`, { shopId: this.shopId, missing: true, totalMs: Math.round((performance.now() - performanceStart) * 10) / 10 });
      }
      return { ...context, missing: true };
    }

    started = performance.now();
    const restockResult = await this._ensureRestockChecked(shop);
    timings.restockMs = performance.now() - started;
    timings.restockSkipped = restockResult?.skipped === true || restockResult?.cached === true;

    // Ресток мог изменить остатки и revision, поэтому после него берём свежую
    // версию только этого магазина из быстрого индекса ShopStore.
    shop = ShopStore.get(this.shopId);
    if (!shop) return { ...context, missing: true };

    let buyerResolveMs = 0;
    let itemResolveMs = 0;
    const buyerPromise = (async () => {
      const at = performance.now();
      const actor = await this._resolveBuyer();
      buyerResolveMs = performance.now() - at;
      return actor;
    })();
    const itemPromise = (async () => {
      const at = performance.now();
      const documents = await Compat.resolveUuids(shop.items.map(entry => entry.uuid), { documentName: "Item" });
      itemResolveMs = performance.now() - at;
      return documents;
    })();
    const [buyerActor, resolvedItems] = await Promise.all([buyerPromise, itemPromise]);
    timings.buyerResolveMs = buyerResolveMs;
    timings.itemResolveMs = itemResolveMs;

    const buyer = buyerActor ? {
      uuid: buyerActor.uuid,
      name: buyerActor.name,
      image: buyerActor.img,
      type: Compat.getActorTypeLabel(buyerActor),
      wallet: Compat.formatActorWallet(buyerActor),
      walletParts: Compat.formatActorWalletParts(buyerActor)
    } : null;

    const items = [];
    for (let index = 0; index < shop.items.length; index += 1) {
      const entry = shop.items[index];
      const document = resolvedItems.get(entry.uuid) ?? null;
      const kind = entry.kind === "service" ? "service" : "product";
      const isService = kind === "service";
      if (!document) {
        if (game.user.isGM) {
          items.push({
            index,
            entryId: entry.id,
            expectedUuid: entry.uuid,
            shopRevision: shop.revision,
            kind,
            isService,
            groupId: entry.groupId ?? null,
            groupName: Compat.getProductGroup(shop, entry.groupId)?.name ?? "Без товарной группы",
            name: isService ? "Сломанная ссылка на услугу" : "Сломанная ссылка",
            image: "icons/svg/hazard.svg",
            missing: true,
            rarity: "",
            priceText: "—",
            priceParts: null,
            sortPriceCopper: null,
            sortQuantity: entry.quantity == null ? Number.POSITIVE_INFINITY : Number(entry.quantity),
            quantityText: entry.quantity == null ? "∞" : entry.quantity,
            maxQuantity: entry.quantity,
            hasMaxQuantity: entry.quantity != null,
            soldOut: entry.quantity === 0,
            canBuy: false,
            buyText: "Недоступно",
            buyTitle: "Исходный предмет не найден"
          });
        }
        continue;
      }

      const denomination = Compat.getItemCurrency(document);
      const price = Compat.calculateShopPrice(shop, entry, document);
      const soldOut = entry.quantity === 0;
      const affordable = buyerActor ? Compat.canAfford(buyerActor, price, denomination) : false;
      const canBuy = Boolean(buyerActor) && !soldOut && affordable && !this.transactionPending;

      let buyText = isService ? "Оплатить" : "Купить";
      let buyTitle = `${isService ? "Оплатить услугу" : "Купить"} за ${Compat.formatPrice(price, denomination)}`;
      if (!buyerActor) {
        buyText = "Выберите персонажа";
        buyTitle = "Сначала выберите персонажа или NPC";
      } else if (soldOut) {
        buyText = isService ? "Недоступно" : "Нет в наличии";
        buyTitle = isService ? "Услуга временно недоступна" : "Товар закончился";
      } else if (!affordable) {
        buyText = "Не хватает денег";
        buyTitle = `${buyerActor.name}: недостаточно денег даже на одну единицу`;
      } else if (this.transactionPending) {
        buyText = "Операция...";
        buyTitle = "Запрос уже выполняется";
      }

      items.push({
        index,
        entryId: entry.id,
        expectedUuid: entry.uuid,
        shopRevision: shop.revision,
        kind,
        isService,
        groupId: entry.groupId ?? null,
        groupName: Compat.getProductGroup(shop, entry.groupId)?.name ?? "Без товарной группы",
        name: document.name,
        image: document.img,
        type: Compat.getItemTypeLabel(document),
        missing: false,
        price,
        denomination,
        priceText: Compat.formatPrice(price, denomination),
        priceParts: Compat.formatPriceParts(price, denomination),
        sortPriceCopper: Compat.priceInCopper(price, denomination),
        sortQuantity: entry.quantity == null ? Number.POSITIVE_INFINITY : Number(entry.quantity),
        rarity: Compat.getItemRarityKey(document),
        quantityText: entry.quantity == null ? "∞" : entry.quantity,
        maxQuantity: entry.quantity,
        hasMaxQuantity: entry.quantity != null,
        soldOut,
        affordable,
        canBuy,
        buyText,
        buyTitle,
        quantityDisabled: soldOut || this.transactionPending
      });
    }

    const products = sortShopItems(items.filter(item => !item.isService), this.sortKey, this.sortDirection);
    const services = sortShopItems(items.filter(item => item.isService), this.sortKey, this.sortDirection);
    const productSections = [];
    for (const group of shop.productGroups ?? []) {
      const groupedProducts = products.filter(item => item.groupId === group.id);
      if (!groupedProducts.length) continue;
      productSections.push({
        id: group.id,
        name: group.name,
        priceMultiplier: group.priceMultiplier,
        products: groupedProducts
      });
    }
    const ungroupedProducts = products.filter(item => !item.groupId || !Compat.getProductGroup(shop, item.groupId));
    if (ungroupedProducts.length) productSections.push({ id: "", name: "Прочие товары", priceMultiplier: 1, products: ungroupedProducts });

    const sales = buyerActor && shop.salesEnabled !== false
      ? Compat.getSellableItems(buyerActor).map(item => {
          const quantity = Compat.getItemQuantity(item);
          const denomination = Compat.getItemCurrency(item);
          const unitPrice = Compat.calculateSaleUnitPrice(shop, item);
          const unitCopper = Compat.priceInCopper(unitPrice, denomination) ?? 0;
          const sellable = unitCopper > 0;
          const walletLimit = shop.walletEnabled && unitCopper > 0
            ? Math.floor(shop.walletCopper / unitCopper)
            : quantity;
          const maxQuantity = Math.max(0, Math.min(quantity, walletLimit));
          const merchantCanAfford = !shop.walletEnabled || maxQuantity > 0;
          let sellTitle = sellable ? `Продать за ${Compat.formatPrice(unitPrice, denomination)} за единицу` : "Цена скупки слишком мала";
          let sellText = "Продать";
          if (sellable && !merchantCanAfford) {
            sellTitle = "У торговца недостаточно денег даже на одну единицу";
            sellText = "Нет денег";
          }
          return {
            itemId: item.id,
            name: item.name,
            image: item.img,
            type: Compat.getItemTypeLabel(item),
            quantity,
            quantityText: quantity,
            maxQuantity,
            quantityDisabled: maxQuantity < 1 || this.transactionPending,
            denomination,
            unitPrice,
            sortPriceCopper: unitCopper,
            sortQuantity: quantity,
            priceText: Compat.formatPrice(unitPrice, denomination),
            priceParts: Compat.formatPriceParts(unitPrice, denomination),
            rarity: Compat.getItemRarityKey(item),
            canSell: sellable && merchantCanAfford && !this.transactionPending,
            sellText,
            sellTitle,
            sourceKnown: Boolean(Compat.getItemSourceUuid(item))
          };
        })
      : [];
    const sortedSales = sortShopItems(sales, this.sortKey, this.sortDirection);

    const prepared = {
      ...context,
      shop,
      buyer,
      hasBuyer: Boolean(buyer),
      products,
      productSections,
      services,
      sales: sortedSales,
      hasProducts: products.length > 0,
      hasServices: services.length > 0,
      hasSales: sales.length > 0,
      salesEnabled: shop.salesEnabled !== false,
      productCount: products.length,
      serviceCount: services.length,
      saleCount: sales.length,
      productsActive: this.currentTab === "products",
      servicesActive: this.currentTab === "services",
      salesActive: this.currentTab === "sales",
      searchQuery: this.searchQuery,
      sortOptions: [
        { value: "name", label: "По названию", selected: this.sortKey === "name" },
        { value: "price", label: "По цене", selected: this.sortKey === "price" },
        { value: "quantity", label: "По количеству", selected: this.sortKey === "quantity" }
      ],
      sortDirectionIcon: this.sortDirection === "asc" ? "fa-arrow-up-a-z" : "fa-arrow-down-z-a",
      sortDirectionTitle: this.sortDirection === "asc" ? "По возрастанию. Нажмите для убывания" : "По убыванию. Нажмите для возрастания",
      buybackPercent: Math.round(Number(shop.buybackMultiplier ?? 0.5) * 100),
      walletEnabled: shop.walletEnabled === true,
      walletBalanceText: Compat.formatWallet(shop.wallet),
      walletBalanceParts: Compat.formatWalletParts(shop.wallet),
      isGM: game.user.isGM
    };

    if (!this.performanceLogged) {
      this.performanceLogged = true;
      timings.totalMs = performance.now() - performanceStart;
      const rounded = Object.fromEntries(Object.entries(timings).map(([key, value]) => [
        key,
        typeof value === "number" ? Math.round(value * 10) / 10 : value
      ]));
      console.info(`${MODULE_ID} | Подготовка витрины «${shop.name}»`, rounded);
    }

    return prepared;
  }

  _switchTab(tab) {
    this.currentTab = ["products", "services", "sales"].includes(tab) ? tab : "products";
    const root = this.element;
    for (const button of root.querySelectorAll("[data-store-tab]")) {
      const active = button.dataset.storeTab === this.currentTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const panel of root.querySelectorAll("[data-store-panel]")) {
      panel.hidden = panel.dataset.storePanel !== this.currentTab;
    }

    const note = root.querySelector("[data-store-note]");
    if (note) note.textContent = note.dataset[this.currentTab] ?? "";
    const role = root.querySelector("[data-role-label]");
    if (role) role.textContent = this.currentTab === "sales" ? "Продавец" : "Покупатель";
    this._applySearch();
  }

  _applySearch() {
    const root = this.element;
    const query = this.searchQuery.trim().toLocaleLowerCase(game.i18n.lang);
    for (const card of root.querySelectorAll(".sw-product")) {
      const inActivePanel = card.closest("[data-store-panel]")?.dataset.storePanel === this.currentTab;
      const name = card.dataset.name?.toLocaleLowerCase(game.i18n.lang) ?? "";
      card.hidden = inActivePanel && Boolean(query) && !name.includes(query);
    }
    for (const section of root.querySelectorAll(".sw-product-group-section")) {
      const cards = [...section.querySelectorAll(".sw-product")];
      section.hidden = cards.length > 0 && cards.every(card => card.hidden);
    }
  }

  /**
   * Описание магазина обрезается двумя строками. Кнопка раскрытия
   * показывается только когда текст действительно не поместился —
   * иначе она мозолит глаза у коротких описаний.
   */
  #setupDescriptionToggle() {
    const description = this.element.querySelector("[data-store-description]");
    const toggle = this.element.querySelector("[data-action='toggle-description']");
    if (!description || !toggle) return;

    const overflows = description.scrollHeight > description.clientHeight + 1;
    toggle.hidden = !overflows;
    if (!overflows) return;

    toggle.addEventListener("click", () => {
      const expanded = description.classList.toggle("is-expanded");
      toggle.textContent = expanded ? "Свернуть" : "Читать полностью";
    });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#setupDescriptionToggle();
    const root = this.element;
    const search = root.querySelector("[data-search]");
    search?.addEventListener("input", event => {
      this.searchQuery = event.currentTarget.value;
      this._applySearch();
    });

    root.querySelector("[data-sort-key]")?.addEventListener("change", async event => {
      this.sortKey = ["name", "price", "quantity"].includes(event.currentTarget.value) ? event.currentTarget.value : "name";
      await this.render({ force: true });
    });
    root.querySelector("[data-action='toggle-sort-direction']")?.addEventListener("click", async () => {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
      await this.render({ force: true });
    });
    root.querySelector("[data-action='edit-shop']")?.addEventListener("click", () => {
      if (!game.user.isGM) return;
      return Compat.renderApplication(new ShopEditorApp({ shopId: this.shopId }));
    });

    for (const tab of root.querySelectorAll("[data-store-tab]")) {
      tab.addEventListener("click", event => this._switchTab(event.currentTarget.dataset.storeTab));
    }
    this._switchTab(this.currentTab);

    root.querySelector("[data-action='choose-buyer']")?.addEventListener("click", () => {
      return Compat.renderApplication(new BuyerPickerApp({
        selectedUuid: this.buyerUuid,
        onSelect: async actor => {
          this.buyerUuid = actor.uuid;
          await game.settings.set(MODULE_ID, SETTINGS.LAST_BUYER, actor.uuid);
          await this.render({ force: true });
        }
      }));
    });

    for (const button of root.querySelectorAll("[data-action='open-item']")) {
      button.addEventListener("click", event => {
        const source = event.currentTarget.dataset;
        return Compat.renderApplication(new ItemPreviewApp({
          shopId: this.shopId,
          entryId: source.entryId,
          expectedUuid: source.itemUuid,
          shopRevision: source.shopRevision
        }));
      });
    }

    for (const button of root.querySelectorAll("[data-action='buy']")) {
      button.addEventListener("click", event => this._buy(event.currentTarget));
    }

    for (const button of root.querySelectorAll("[data-action='sell']")) {
      button.addEventListener("click", event => this._sell(event.currentTarget));
    }
  }

  async _buy(button) {
    if (this.transactionPending) return;
    const buyer = await this._resolveBuyer();
    if (!buyer) {
      ui.notifications.warn("Сначала выберите покупателя.");
      return;
    }

    const entryId = String(button.dataset.entryId ?? "");
    const expectedUuid = String(button.dataset.itemUuid ?? "");
    const shopRevision = Number(button.dataset.shopRevision);
    const shop = ShopStore.get(this.shopId);
    const entry = shop?.items?.find(item => item.id === entryId);
    const stale = !shop
      || !Number.isFinite(shopRevision)
      || shop.revision !== shopRevision
      || !entry
      || entry.uuid !== expectedUuid;
    if (stale) {
      ui.notifications.warn("Магазин изменился. Витрина будет обновлена.");
      return this.render({ force: true });
    }

    const item = await Compat.fromUuid(entry.uuid);
    if (!item) {
      ui.notifications.warn("Позиция больше не найдена.");
      return this.render({ force: true });
    }

    const card = button.closest(".sw-product");
    const input = card?.querySelector("[data-quantity]");
    const requested = positiveInteger(input?.value, 1);
    const max = entry.quantity == null ? null : Math.max(0, Number(entry.quantity));
    const quantity = max == null ? requested : Math.min(requested, max);
    if (quantity < 1) return ui.notifications.warn("Товар закончился.");

    const isService = entry.kind === "service";
    const unitPrice = Compat.calculateShopPrice(shop, entry, item);
    const denomination = Compat.getItemCurrency(item);
    const totalPrice = money(unitPrice * quantity);
    if (!Compat.canAfford(buyer, totalPrice, denomination)) {
      ui.notifications.warn(`${buyer.name}: недостаточно денег для покупки выбранного количества.`);
      return;
    }
    const confirmation = await Compat.confirmPurchase({
      title: isService ? "Подтвердить оплату услуги" : "Подтвердить покупку",
      quantity,
      maxQuantity: quantity,
      showQuantity: false,
      content: `
        <p><strong>${Compat.escapeHTML(buyer.name)}</strong> ${isService ? "оплачивает услугу" : "покупает"} <strong>${Compat.escapeHTML(item.name)}</strong>${quantity > 1 ? ` ×${quantity}` : ""}.</p>
        ${quantity > 1 ? `<p>Цена за единицу: <strong>${Compat.escapeHTML(Compat.formatPrice(unitPrice, denomination))}</strong>.</p>` : ""}
        <p>Итого: <strong>${Compat.escapeHTML(Compat.formatPrice(totalPrice, denomination))}</strong>.</p>
        ${isService ? "<p><small>Услуга не будет добавлена в инвентарь.</small></p>" : ""}`
    });
    if (!confirmation) return;

    this.transactionPending = true;
    await this.render({ force: true });

    const result = await PurchaseService.requestPurchase({
      shopId: this.shopId,
      entryId,
      expectedUuid,
      shopRevision,
      actorUuid: buyer.uuid,
      quantity,
      privatePurchase: confirmation.privatePurchase === true
    });

    this.transactionPending = false;
    if (result.ok) {
      ui.notifications.info(result.kind === "service"
        ? `${result.buyerName} оплачивает услугу «${result.itemName}»${result.quantity > 1 ? ` ×${result.quantity}` : ""} за ${result.priceText}.`
        : `${result.buyerName} покупает «${result.itemName}»${result.quantity > 1 ? ` ×${result.quantity}` : ""} за ${result.priceText}.`);
    } else {
      ui.notifications.warn(result.message);
    }
    await this.render({ force: true });
  }

  async _sell(button) {
    if (this.transactionPending) return;
    const seller = await this._resolveBuyer();
    if (!seller) {
      ui.notifications.warn("Сначала выберите продавца.");
      return;
    }

    const shop = ShopStore.get(this.shopId);
    const item = seller.items?.get(button.dataset.itemId);
    if (!shop || !item || !Compat.canSellItem(item)) {
      ui.notifications.warn("Предмет больше нельзя продать.");
      return this.render({ force: true });
    }

    const card = button.closest(".sw-product");
    const input = card?.querySelector("[data-quantity]");
    const available = Compat.getItemQuantity(item);
    const denomination = Compat.getItemCurrency(item);
    const unitPrice = Compat.calculateSaleUnitPrice(shop, item);
    const unitCopper = Compat.priceInCopper(unitPrice, denomination) ?? 0;
    const walletLimit = shop.walletEnabled && unitCopper > 0
      ? Math.floor(shop.walletCopper / unitCopper)
      : available;
    const maxQuantity = Math.max(0, Math.min(available, walletLimit));
    if (maxQuantity < 1) return ui.notifications.warn("У торговца недостаточно денег для этой покупки.");
    const quantity = Math.min(positiveInteger(input?.value, 1), maxQuantity);
    const totalPrice = money(unitPrice * quantity);
    let walletAfterText = null;
    if (shop.walletEnabled) {
      try {
        walletAfterText = Compat.formatWallet(Compat.deductCopperFromCurrencyMap(shop.wallet, unitCopper * quantity).next);
      } catch (error) {
        const message = String(error?.message ?? error) === "CANNOT_MAKE_CHANGE"
          ? "Торговец не может выдать эту сумму доступными номиналами."
          : "У торговца недостаточно денег для этой покупки.";
        ui.notifications.warn(message);
        return;
      }
    }

    const confirmation = await Compat.confirmPurchase({
      title: "Подтвердить продажу",
      quantity,
      maxQuantity: quantity,
      showQuantity: false,
      privateLabel: "Приватная продажа",
      privateHint: "Чек увидите вы и ведущие. Остальные игроки не узнают о продаже из чата.",
      content: `
        <p><strong>${Compat.escapeHTML(seller.name)}</strong> продаёт магазину <strong>${Compat.escapeHTML(item.name)}</strong>${quantity > 1 ? ` ×${quantity}` : ""}.</p>
        ${quantity > 1 ? `<p>Цена за единицу: <strong>${Compat.escapeHTML(Compat.formatPrice(unitPrice, denomination))}</strong>.</p>` : ""}
        <p>Будет получено: <strong>${Compat.escapeHTML(Compat.formatPrice(totalPrice, denomination))}</strong>.</p>
        ${shop.walletEnabled ? `<p><small>В кошельке торговца останется: <strong>${Compat.escapeHTML(walletAfterText)}</strong>.</small></p>` : ""}`
    });
    if (!confirmation) return;

    this.transactionPending = true;
    await this.render({ force: true });

    const result = await PurchaseService.requestSale({
      shopId: this.shopId,
      actorUuid: seller.uuid,
      actorItemId: item.id,
      quantity,
      privatePurchase: confirmation.privatePurchase === true
    });

    this.transactionPending = false;
    if (result.ok) {
      ui.notifications.info(`${result.sellerName} продаёт «${result.itemName}»${result.quantity > 1 ? ` ×${result.quantity}` : ""} за ${result.priceText}.`);
    } else {
      ui.notifications.warn(result.message);
    }
    await this.render({ force: true });
  }
}
