import { MODULE_ID, DEFAULT_IMAGE } from "../constants.mjs";
import { Compat } from "../compat.mjs";
import { ShopStore } from "../storage.mjs";
import { TokenShopBinding } from "../token-shops.mjs";
import { RestockService } from "../restock.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function parseDroppedData(event) {
  try {
    return foundry.applications.ux.TextEditor.getDragEventData(event);
  } catch (error) {
    console.warn(`${MODULE_ID} | Не удалось прочитать drag-and-drop через TextEditor`, error);
    return {};
  }
}

function droppedUuid(data) {
  const direct = String(data?.uuid ?? "").trim();
  if (direct) return direct;

  const id = String(data?.id ?? data?._id ?? "").trim();
  const documentName = String(data?.documentName ?? data?.type ?? "").trim();
  if (!id || !documentName) return null;

  try {
    return foundry.utils.buildUuid({
      documentName,
      id,
      pack: data?.pack ?? null
    });
  } catch (error) {
    console.warn(`${MODULE_ID} | Не удалось собрать UUID перетаскиваемого документа`, error);
    return null;
  }
}

function nullableNumber(input, { integer = false } = {}) {
  if (!input || input.value === "") return null;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return null;
  return integer ? Math.max(0, Math.floor(value)) : value;
}

function newProductGroup() {
  return {
    id: Compat.randomID(),
    name: "Новая товарная группа",
    intervalValue: 1,
    intervalUnit: "day",
    restockFormula: "1d4",
    depletionFormula: "",
    maxStock: null,
    priceMultiplier: 1,
    autoRestock: true,
    lastUpdateTime: RestockService.worldTime
  };
}

function sortEditorItems(items, key = "name", direction = "asc") {
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

function reportRestock(result, forced = false) {
  if (!result?.ok) return ui.notifications.warn("Не удалось обновить ассортимент.");
  if (result.errorCount) {
    ui.notifications.warn(`Ассортимент обновлён частично. Ошибок формул: ${result.errorCount}. Подробности в консоли.`);
    return;
  }
  if (!result.periodCount) {
    ui.notifications.info("Для выбранных товарных групп ещё не наступил срок обновления.");
    return;
  }
  ui.notifications.info(`${forced ? "Ручное обновление" : "Обновление ассортимента"}: циклов ${result.periodCount}, изменённых позиций ${result.changedItems}.`);
}

export class ShopEditorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ shopId, manager = null, ...options } = {}) {
    super(options);
    this.shopId = shopId;
    this.manager = manager;
    this.currentTab = "products";
    this.newItemGroupId = "";
    this.sortKey = "name";
    this.sortDirection = "asc";
    this.renderRevision = null;

    this.addEventListener("close", () => {
      if (this.manager?.rendered) this.manager.render({ force: true });
    }, { once: true });
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "sw-editor"],
    window: {
      resizable: true,
      title: "Редактор магазина",
      icon: "fa-solid fa-hammer"
    },
    position: {
      width: 920,
      height: 780
    }
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/shop-editor.hbs`,
      scrollable: [".sw-editor-body", ".sw-editor-header", ".sw-editor-panel"]
    }
  };

  get shop() {
    return ShopStore.get(this.shopId);
  }

  _readFormState() {
    const shop = this.shop;
    if (!shop) return null;

    const root = this.element;
    const form = root?.querySelector?.("form") ?? root;
    if (!form?.querySelector) return Compat.clone(shop);

    const productGroups = (shop.productGroups ?? []).map((group, index) => {
      const intervalValue = Number(form.querySelector(`[name='productGroups.${index}.intervalValue']`)?.value);
      const priceMultiplier = Number(form.querySelector(`[name='productGroups.${index}.priceMultiplier']`)?.value);
      return {
        ...group,
        name: form.querySelector(`[name='productGroups.${index}.name']`)?.value?.trim() || "Новая товарная группа",
        intervalValue: Number.isFinite(intervalValue) && intervalValue >= 1 ? Math.floor(intervalValue) : 1,
        intervalUnit: form.querySelector(`[name='productGroups.${index}.intervalUnit']`)?.value || "day",
        restockFormula: form.querySelector(`[name='productGroups.${index}.restockFormula']`)?.value?.trim() ?? "",
        depletionFormula: form.querySelector(`[name='productGroups.${index}.depletionFormula']`)?.value?.trim() ?? "",
        maxStock: nullableNumber(form.querySelector(`[name='productGroups.${index}.maxStock']`), { integer: true }),
        priceMultiplier: Number.isFinite(priceMultiplier) && priceMultiplier > 0 ? priceMultiplier : 1,
        autoRestock: Boolean(form.querySelector(`[name='productGroups.${index}.autoRestock']`)?.checked)
      };
    });

    const validGroupIds = new Set(productGroups.map(group => group.id));
    const items = shop.items.map((entry, index) => {
      const quantityInput = form.querySelector(`[name='items.${index}.quantity']`);
      const priceInput = form.querySelector(`[name='items.${index}.customPrice']`);
      const kindInput = form.querySelector(`[name='items.${index}.kind']`);
      const kind = kindInput?.value === "service" ? "service" : "product";
      const selectedGroupId = form.querySelector(`[name='items.${index}.groupId']`)?.value || null;
      return {
        ...entry,
        kind,
        groupId: kind === "product" && validGroupIds.has(selectedGroupId) ? selectedGroupId : null,
        quantity: quantityInput
          ? (quantityInput.value === "" ? null : Number(quantityInput.value))
          : entry.quantity,
        customPrice: priceInput
          ? (priceInput.value === "" ? null : Number(priceInput.value))
          : entry.customPrice,
        overrideStockRules: Boolean(form.querySelector(`[name='items.${index}.overrideStockRules']`)?.checked),
        restockFormula: form.querySelector(`[name='items.${index}.restockFormula']`)?.value?.trim() ?? entry.restockFormula ?? "",
        depletionFormula: form.querySelector(`[name='items.${index}.depletionFormula']`)?.value?.trim() ?? entry.depletionFormula ?? "",
        maxStock: nullableNumber(form.querySelector(`[name='items.${index}.maxStock']`), { integer: true })
      };
    });

    const priceMultiplier = Number(form.querySelector("[name='priceMultiplier']")?.value);
    const buybackPercent = Number(form.querySelector("[name='buybackPercent']")?.value);
    const enabledWalletKeys = Compat.getEnabledCurrencyKeys();
    const walletCurrency = enabledWalletKeys.length
      ? Object.fromEntries(enabledWalletKeys.map(key => [
          key,
          Number(form.querySelector(`[name='wallet.${key}']`)?.value) || 0
        ]))
      : Compat.clone(shop.wallet ?? {});

    return {
      name: form.querySelector("[name='name']")?.value?.trim() || "Новый магазин",
      image: form.querySelector("[name='image']")?.value?.trim() || DEFAULT_IMAGE,
      description: form.querySelector("[name='description']")?.value ?? "",
      categoryId: form.querySelector("[name='categoryId']")?.value || null,
      priceMultiplier: Number.isFinite(priceMultiplier) && priceMultiplier > 0 ? priceMultiplier : 1,
      salesEnabled: Boolean(form.querySelector("[name='salesEnabled']")?.checked),
      buybackMultiplier: Number.isFinite(buybackPercent) && buybackPercent >= 0 ? buybackPercent / 100 : 0.5,
      restockSoldItems: Boolean(form.querySelector("[name='restockSoldItems']")?.checked),
      walletEnabled: Boolean(form.querySelector("[name='walletEnabled']")?.checked),
      walletReceivesPayments: Boolean(form.querySelector("[name='walletReceivesPayments']")?.checked),
      wallet: Compat.normalizeCurrencyMap(walletCurrency),
      productGroups,
      items
    };
  }

  async _commitFormState(overrides = {}, { notify = false, rerender = true } = {}) {
    const formState = this._readFormState();
    if (!formState) return null;

    let updated;
    try {
      updated = await ShopStore.update(
        this.shopId,
        { ...formState, ...overrides },
        { expectedShopRevision: this.renderRevision }
      );
    } catch (error) {
      if (String(error?.message ?? error) === "STORE_CONFLICT") {
        ui.notifications.warn("Магазин изменился в другом окне. Форма обновлена без перезаписи новых данных.");
        await this.render({ force: true });
        return null;
      }
      throw error;
    }
    this.renderRevision = updated.revision;
    await TokenShopBinding.syncShopTokens(this.shopId);
    Hooks.callAll(`${MODULE_ID}.stockChanged`, this.shopId);

    if (notify) ui.notifications.info(game.i18n.localize("SHOPWRIGHT.Notifications.Saved"));
    if (rerender) await this.render({ force: true });
    return updated;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const shop = this.shop;
    if (!shop) return { ...context, missing: true };
    this.renderRevision = shop.revision;

    const groupOptionsBase = [
      { id: "", name: "Без товарной группы" },
      ...(shop.productGroups ?? []).map(group => ({ id: group.id, name: group.name }))
    ];

    const resolvedItems = await Compat.resolveUuids(shop.items.map(entry => entry.uuid), { documentName: "Item" });
    const items = [];
    for (let index = 0; index < shop.items.length; index += 1) {
      const entry = shop.items[index];
      const document = resolvedItems.get(entry.uuid) ?? null;
      const calculated = document ? Compat.calculateShopPrice(shop, entry, document) : 0;
      const denomination = document ? Compat.getItemCurrency(document) : "gp";
      const kind = entry.kind === "service" ? "service" : "product";
      const group = Compat.getProductGroup(shop, entry.groupId);
      items.push({
        index,
        kind,
        isService: kind === "service",
        name: document?.name ?? "Не найдено",
        image: document?.img ?? "icons/svg/hazard.svg",
        type: document?.type ?? "—",
        missing: !document,
        quantity: entry.quantity,
        quantityText: entry.quantity == null ? "∞" : entry.quantity,
        customPrice: entry.customPrice,
        priceText: Compat.formatPrice(calculated, denomination),
        sortPriceCopper: document ? Compat.priceInCopper(calculated, denomination) : null,
        sortQuantity: entry.quantity == null ? Number.POSITIVE_INFINITY : Number(entry.quantity),
        rarity: document ? Compat.getItemRarityKey(document) : "",
        groupName: group?.name ?? "Без товарной группы",
        groupId: entry.groupId ?? "",
        groupOptions: groupOptionsBase.map(option => ({ ...option, selected: option.id === (entry.groupId ?? "") })),
        overrideStockRules: entry.overrideStockRules === true,
        restockFormula: entry.restockFormula ?? "",
        depletionFormula: entry.depletionFormula ?? "",
        maxStock: entry.maxStock,
        kindOptions: [
          { value: "product", label: "Товар", selected: kind === "product" },
          { value: "service", label: "Услуга", selected: kind === "service" }
        ]
      });
    }

    const categories = ShopStore.getCategories()
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    const categoryOptions = [
      { id: "", name: "Без категории", selected: !shop.categoryId },
      ...categories.map(category => ({
        id: category.id,
        name: category.name,
        selected: shop.categoryId === category.id
      }))
    ];

    const products = sortEditorItems(items.filter(item => !item.isService), this.sortKey, this.sortDirection);
    const services = sortEditorItems(items.filter(item => item.isService), this.sortKey, this.sortDirection);
    const validProductGroupIds = new Set((shop.productGroups ?? []).map(group => group.id));
    if (!validProductGroupIds.has(this.newItemGroupId)) this.newItemGroupId = "";

    const newItemGroupOptions = groupOptionsBase.map(option => ({
      ...option,
      selected: option.id === this.newItemGroupId
    }));
    const batchTargetGroupOptions = groupOptionsBase.map(option => ({ ...option }));
    const batchSourceGroupOptions = [
      { id: "*", name: "Любая группа" },
      { id: "", name: "Без товарной группы" },
      ...(shop.productGroups ?? []).map(group => ({ id: group.id, name: group.name }))
    ];
    const productTypes = [...new Set(products.map(item => item.type).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, game.i18n.lang));
    const batchTypeOptions = [
      { value: "*", label: "Любой тип" },
      ...productTypes.map(type => ({ value: type, label: type }))
    ];

    const productGroups = (shop.productGroups ?? []).map((group, index) => {
      const status = RestockService.groupStatus(group);
      return {
        ...group,
        index,
        itemCount: shop.items.filter(entry => entry.kind !== "service" && entry.groupId === group.id).length,
        statusText: status.text,
        duePeriods: status.due,
        effectiveMultiplier: Math.round(
          Number(shop.priceMultiplier ?? 1) * Number(group.priceMultiplier ?? 1) * 100
        ) / 100,
        intervalUnitOptions: [
          { value: "hour", label: "часов", selected: group.intervalUnit === "hour" },
          { value: "day", label: "дней", selected: group.intervalUnit === "day" },
          { value: "week", label: "недель", selected: group.intervalUnit === "week" }
        ]
      };
    });

    return {
      ...context,
      shop,
      products,
      services,
      productGroups,
      hasProducts: products.length > 0,
      hasServices: services.length > 0,
      hasProductGroups: productGroups.length > 0,
      productCount: products.length,
      serviceCount: services.length,
      groupCount: productGroups.length,
      categoryOptions,
      newItemGroupOptions,
      batchTargetGroupOptions,
      batchSourceGroupOptions,
      batchTypeOptions,
      sortOptions: [
        { value: "name", label: "По названию", selected: this.sortKey === "name" },
        { value: "price", label: "По цене", selected: this.sortKey === "price" },
        { value: "quantity", label: "По количеству", selected: this.sortKey === "quantity" }
      ],
      sortDirectionIcon: this.sortDirection === "asc" ? "fa-arrow-up-a-z" : "fa-arrow-down-z-a",
      sortDirectionTitle: this.sortDirection === "asc" ? "По возрастанию. Нажмите для убывания" : "По убыванию. Нажмите для возрастания",
      productsActive: this.currentTab === "products",
      servicesActive: this.currentTab === "services",
      groupsActive: this.currentTab === "groups",
      salesActive: this.currentTab === "sales",
      salesEnabled: shop.salesEnabled !== false,
      buybackPercent: Math.round(Number(shop.buybackMultiplier ?? 0.5) * 10000) / 100,
      restockSoldItems: shop.restockSoldItems === true,
      walletEnabled: shop.walletEnabled === true,
      walletReceivesPayments: shop.walletReceivesPayments !== false,
      walletBalanceText: Compat.formatWallet(shop.wallet),
      walletBalanceParts: Compat.formatWalletParts(shop.wallet),
      walletCurrencies: Compat.getWalletCurrencyFields(shop.wallet),
      defaultImage: DEFAULT_IMAGE
    };
  }

  _switchTab(tab) {
    this.currentTab = ["products", "services", "groups", "sales"].includes(tab) ? tab : "products";
    const root = this.element;
    for (const button of root.querySelectorAll("[data-editor-tab]")) {
      const active = button.dataset.editorTab === this.currentTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const panel of root.querySelectorAll("[data-editor-panel]")) {
      panel.hidden = panel.dataset.editorPanel !== this.currentTab;
    }
  }

  async _runRestock({ groupId = null, forcePeriods = null, resetTimer = false } = {}) {
    await this._commitFormState({}, { rerender: false });
    const result = await RestockService.applyDue(this.shopId, { groupId, forcePeriods, resetTimer });
    reportRestock(result, forcePeriods != null);
    await this.render({ force: true });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    const form = root.querySelector("form.sw-editor-form");
    form?.addEventListener("submit", event => {
      event.preventDefault();
      void this._save();
    });

    const imageInput = root.querySelector("[name='image']");
    const imagePreview = root.querySelector("[data-image-preview]");

    const refreshImagePreview = () => {
      if (imagePreview) imagePreview.src = imageInput?.value?.trim() || DEFAULT_IMAGE;
    };

    imageInput?.addEventListener("input", refreshImagePreview);
    imageInput?.addEventListener("change", refreshImagePreview);

    for (const button of root.querySelectorAll("[data-action='pick-image']")) {
      button.addEventListener("click", async event => {
        event.preventDefault();
        const FilePicker = foundry.applications.apps.FilePicker;
        const picker = FilePicker.fromButton(event.currentTarget);
        picker.callback = path => {
          if (imageInput) imageInput.value = path;
          refreshImagePreview();
        };
        await picker.render({ force: true });
      });
    }

    for (const tab of root.querySelectorAll("[data-editor-tab]")) {
      tab.addEventListener("click", event => this._switchTab(event.currentTarget.dataset.editorTab));
    }
    this._switchTab(this.currentTab);

    for (const select of root.querySelectorAll("[data-editor-sort-key]")) {
      select.addEventListener("change", async event => {
        const nextSortKey = ["name", "price", "quantity"].includes(event.currentTarget.value) ? event.currentTarget.value : "name";
        const saved = await this._commitFormState({}, { rerender: false });
        if (!saved) return;
        this.sortKey = nextSortKey;
        await this.render({ force: true });
      });
    }
    for (const button of root.querySelectorAll("[data-action='toggle-editor-sort-direction']")) {
      button.addEventListener("click", async () => {
        const saved = await this._commitFormState({}, { rerender: false });
        if (!saved) return;
        this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
        await this.render({ force: true });
      });
    }

    for (const dropZone of root.querySelectorAll(".sw-drop-zone[data-kind]")) {
      dropZone.addEventListener("dragover", event => {
        event.preventDefault();
        dropZone.classList.add("is-dragging");
      });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
      dropZone.addEventListener("drop", async event => {
        event.preventDefault();
        dropZone.classList.remove("is-dragging");
        const data = parseDroppedData(event);
        const uuid = droppedUuid(data);
        const document = await Compat.fromUuid(uuid);
        if (!uuid || document?.documentName !== "Item") {
          return ui.notifications.warn(game.i18n.localize("SHOPWRIGHT.Notifications.InvalidDrop"));
        }

        const kind = dropZone.dataset.kind === "service" ? "service" : "product";
        const formState = this._readFormState();
        const items = formState?.items ?? this.shop?.items ?? [];
        if (items.some(item => item.uuid === uuid && item.kind === kind)) {
          return ui.notifications.warn(kind === "service"
            ? "Эта услуга уже добавлена в магазин."
            : "Этот товар уже добавлен в магазин.");
        }

        this.currentTab = kind === "service" ? "services" : "products";
        await this._commitFormState({
          items: [...items, {
            id: Compat.randomID(),
            uuid,
            kind,
            groupId: kind === "product" && (formState?.productGroups ?? []).some(group => group.id === this.newItemGroupId)
              ? this.newItemGroupId
              : null,
            quantity: null,
            customPrice: null,
            overrideStockRules: false,
            restockFormula: "",
            depletionFormula: "",
            maxStock: null
          }]
        });
      });
    }

    const newItemGroupSelect = root.querySelector("[data-new-item-group]");
    newItemGroupSelect?.addEventListener("change", event => {
      this.newItemGroupId = event.currentTarget.value || "";
    });

    const selectedCountText = count => `${count} выбрано`;

    for (const batchPanel of root.querySelectorAll("[data-batch-panel]")) {
      const editorPanel = batchPanel.closest("[data-editor-panel]");
      const batchButtons = () => [...(editorPanel?.querySelectorAll("[data-batch-item]") ?? [])];
      const isBatchSelected = button => button.getAttribute("aria-pressed") === "true";
      const setBatchSelected = (button, selected) => {
        button.setAttribute("aria-pressed", String(Boolean(selected)));
        button.classList.toggle("is-selected", Boolean(selected));
      };
      const selectedIndices = () => new Set(batchButtons()
        .filter(isBatchSelected)
        .map(button => Number(button.dataset.itemIndex))
        .filter(Number.isInteger));
      const updateSelectionCount = () => {
        const selected = batchButtons().filter(isBatchSelected).length;
        const counter = batchPanel.querySelector("[data-selection-count]");
        if (counter) counter.textContent = selectedCountText(selected);
      };

      for (const button of batchButtons()) {
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          setBatchSelected(button, !isBatchSelected(button));
          updateSelectionCount();
        });
      }
      updateSelectionCount();

      batchPanel.querySelector("[data-action='select-all-items']")?.addEventListener("click", () => {
        for (const button of batchButtons()) setBatchSelected(button, true);
        updateSelectionCount();
      });

      batchPanel.querySelector("[data-action='clear-item-selection']")?.addEventListener("click", () => {
        for (const button of batchButtons()) setBatchSelected(button, false);
        updateSelectionCount();
      });

      batchPanel.querySelector("[data-action='select-matching-items']")?.addEventListener("click", () => {
        const sourceGroup = batchPanel.querySelector("[data-batch-source-group]")?.value ?? "*";
        const sourceType = batchPanel.querySelector("[data-batch-source-type]")?.value ?? "*";
        for (const button of batchButtons()) {
          const card = button.closest("[data-product-index]");
          const groupMatches = sourceGroup === "*" || (card?.dataset.productGroup ?? "") === sourceGroup;
          const typeMatches = sourceType === "*" || (card?.dataset.productType ?? "") === sourceType;
          setBatchSelected(button, Boolean(card) && groupMatches && typeMatches);
        }
        updateSelectionCount();
      });

      batchPanel.querySelector("[data-action='apply-batch-group']")?.addEventListener("click", async () => {
        const indices = selectedIndices();
        if (!indices.size) return ui.notifications.warn("Сначала выберите товары.");

        const state = this._readFormState();
        if (!state) return;
        const productIndices = new Set([...indices].filter(index => state.items[index]?.kind !== "service"));
        if (!productIndices.size) return ui.notifications.warn("Среди выбранных позиций нет товаров для назначения группы.");

        const targetGroupId = batchPanel.querySelector("[data-batch-target-group]")?.value || null;
        const validGroupIds = new Set(state.productGroups.map(group => group.id));
        const normalizedTarget = targetGroupId && validGroupIds.has(targetGroupId) ? targetGroupId : null;
        const items = state.items.map((entry, index) => productIndices.has(index)
          ? { ...entry, groupId: normalizedTarget }
          : entry);
        await this._commitFormState({ items });
      });

      batchPanel.querySelector("[data-action='move-selected-items']")?.addEventListener("click", async () => {
        const indices = selectedIndices();
        if (!indices.size) return ui.notifications.warn("Сначала выберите позиции.");

        const state = this._readFormState();
        if (!state) return;
        const targetKind = batchPanel.querySelector("[data-batch-target-kind]")?.value === "service"
          ? "service"
          : "product";
        const changed = [...indices].some(index => state.items[index]?.kind !== targetKind);
        if (!changed) {
          return ui.notifications.info(targetKind === "service"
            ? "Все выбранные позиции уже находятся в разделе «Услуги»."
            : "Все выбранные позиции уже находятся в разделе «Покупка».");
        }

        const items = state.items.map((entry, index) => {
          if (!indices.has(index)) return entry;
          if (targetKind === "service") {
            return {
              ...entry,
              kind: "service",
              groupId: null,
              overrideStockRules: false,
              restockFormula: "",
              depletionFormula: "",
              maxStock: null
            };
          }
          return { ...entry, kind: "product", groupId: null };
        });
        this.currentTab = targetKind === "service" ? "services" : "products";
        await this._commitFormState({ items });
      });

      batchPanel.querySelector("[data-action='delete-selected-items']")?.addEventListener("click", async () => {
        const indices = selectedIndices();
        if (!indices.size) return ui.notifications.warn("Сначала выберите позиции.");

        const confirmed = await Compat.confirm({
          title: "Удалить выбранные позиции",
          content: `<p>Удалить из магазина выбранные позиции: <strong>${indices.size}</strong>?</p><p>Исходные предметы в компендиумах и инвентарях не изменятся.</p>`
        });
        if (!confirmed) return;

        const state = this._readFormState();
        if (!state) return;
        const items = state.items.filter((_, index) => !indices.has(index));
        await this._commitFormState({ items });
      });
    }

    root.querySelector("[data-action='copy-id']")?.addEventListener("click", async () => {
      const copied = await Compat.copyText(this.shopId);
      copied
        ? ui.notifications.info(`ID магазина скопирован: ${this.shopId}`)
        : ui.notifications.warn("Не удалось скопировать ID магазина.");
    });

    root.querySelector("[data-action='add-product-group']")?.addEventListener("click", async () => {
      const state = this._readFormState();
      this.currentTab = "groups";
      await this._commitFormState({ productGroups: [...(state?.productGroups ?? []), newProductGroup()] });
    });
    root.querySelector("[data-action='restock-due']")?.addEventListener("click", () => this._runRestock());
    root.querySelector("[data-action='restock-all-once']")?.addEventListener("click", async () => {
      const confirmed = await Compat.confirm({
        title: "Ручное обновление ассортимента",
        content: "<p>Применить по одному периоду ко всем товарным группам и начать отсчёт заново от текущего игрового времени?</p>"
      });
      if (confirmed) await this._runRestock({ forcePeriods: 1, resetTimer: true });
    });

    for (const button of root.querySelectorAll("[data-group-index]")) {
      button.addEventListener("click", async event => {
        const action = event.currentTarget.dataset.action;
        const index = Number(event.currentTarget.dataset.groupIndex);
        const state = this._readFormState();
        const group = state?.productGroups?.[index];
        if (!group) return;

        if (action === "restock-group-once") {
          await this._runRestock({ groupId: group.id, forcePeriods: 1, resetTimer: true });
          return;
        }

        if (action === "delete-product-group") {
          const confirmed = await Compat.confirm({
            title: "Удалить товарную группу",
            content: `<p>Удалить группу <strong>${Compat.escapeHTML(group.name)}</strong>? Товары останутся в магазине, но станут без группы.</p>`
          });
          if (!confirmed) return;
          const productGroups = state.productGroups.filter((_, groupIndex) => groupIndex !== index);
          const items = state.items.map(entry => entry.groupId === group.id ? { ...entry, groupId: null } : entry);
          await this._commitFormState({ productGroups, items });
        }
      });
    }

    for (const button of root.querySelectorAll("[data-item-index]")) {
      button.addEventListener("click", async event => {
        const action = event.currentTarget.dataset.action;
        const index = Number(event.currentTarget.dataset.itemIndex);
        const shop = this.shop;
        const entry = shop?.items?.[index];
        if (!entry) return;

        if (action === "open-item") {
          const document = await Compat.fromUuid(entry.uuid);
          if (!document) return ui.notifications.warn(game.i18n.localize("SHOPWRIGHT.Notifications.ItemMissing"));
          return Compat.renderSheet(document);
        }

        if (action === "remove-item") {
          const formState = this._readFormState();
          const items = (formState?.items ?? shop.items).filter((_, itemIndex) => itemIndex !== index);
          await this._commitFormState({ items });
        }
      });
    }
  }

  async _save() {
    await this._commitFormState({}, { notify: true });
  }
}
