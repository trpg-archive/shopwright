import { MODULE_ID } from "../constants.mjs";
import { Compat } from "../compat.mjs";
import { ShopStore } from "../storage.mjs";
import { ShopEditorApp } from "./shop-editor.mjs";
import { StorefrontApp } from "./storefront.mjs";
import { TokenShopBinding } from "../token-shops.mjs";
import { ShopBackup } from "../backup.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const ALL_CATEGORIES = "all";
const UNCATEGORIZED = "uncategorized";

export class ShopManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.currentTab = "shops";
    this.selectedCategory = ALL_CATEGORIES;
    this.shopSearch = "";
    this.historySearch = "";
    this.pendingImport = null;
    this.pendingImportFileName = "";
    this.historyHook = Hooks.on(`${MODULE_ID}.historyChanged`, () => {
      if (this.currentTab === "history" && this.rendered) this.render({ force: true });
    });
    this.addEventListener("close", () => Hooks.off(`${MODULE_ID}.historyChanged`, this.historyHook), { once: true });
  }

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-manager`,
    classes: [MODULE_ID, "sw-manager"],
    window: {
      resizable: true,
      title: "Менеджер магазинов",
      icon: "fa-solid fa-store"
    },
    position: {
      width: 920,
      height: 680
    }
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/manager.hbs`,
      scrollable: [".sw-manager-workspace", ".sw-shop-list", ".sw-history-list", ".sw-category-list", ".sw-transfer-panel"]
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const allShops = ShopStore.getAll();
    const selectedToken = TokenShopBinding.getSelectedTokenDocument();
    const selectedTokenShopId = TokenShopBinding.getShopId(selectedToken);
    const selectedTokenShop = selectedTokenShopId ? allShops.find(shop => shop.id === selectedTokenShopId) : null;
    const rawCategories = ShopStore.getCategories()
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    const countByCategory = new Map();
    let uncategorizedCount = 0;
    for (const shop of allShops) {
      if (shop.categoryId) countByCategory.set(shop.categoryId, (countByCategory.get(shop.categoryId) ?? 0) + 1);
      else uncategorizedCount += 1;
    }

    const categories = rawCategories.map(category => ({
      ...category,
      count: countByCategory.get(category.id) ?? 0,
      selected: this.selectedCategory === category.id
    }));

    const categoryNameById = new Map(rawCategories.map(category => [category.id, category.name]));
    const filteredShops = allShops.filter(shop => {
      if (this.selectedCategory === UNCATEGORIZED) return !shop.categoryId;
      if (this.selectedCategory === ALL_CATEGORIES) return true;
      return shop.categoryId === this.selectedCategory;
    });

    const shops = filteredShops
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      .map(shop => ({
        ...shop,
        itemCount: shop.items.filter(item => item.kind !== "service").length,
        serviceCount: shop.items.filter(item => item.kind === "service").length,
        categoryName: categoryNameById.get(shop.categoryId) ?? "Без категории",
        linkedToSelectedToken: Boolean(selectedToken && selectedTokenShopId === shop.id),
        canBindSelectedToken: Boolean(selectedToken),
        bindTokenIcon: selectedTokenShopId === shop.id ? "fa-link-slash" : "fa-link",
        bindTokenTitle: !selectedToken
          ? "Сначала выберите один токен на сцене"
          : selectedTokenShopId === shop.id
            ? `Снять привязку с токена «${selectedToken.name}»`
            : `Привязать магазин к токену «${selectedToken.name}»`,
        updated: new Date(shop.updatedAt).toLocaleString(game.i18n.lang),
        searchText: `${shop.name} ${shop.description} ${categoryNameById.get(shop.categoryId) ?? "без категории"}`.toLocaleLowerCase(game.i18n.lang),
        categoryOptions: [
          { id: "", name: "Без категории", selected: !shop.categoryId },
          ...rawCategories.map(category => ({
            id: category.id,
            name: category.name,
            selected: shop.categoryId === category.id
          }))
        ]
      }));

    const history = ShopStore.getHistory()
      .slice()
      .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
      .map(entry => {
        const isService = entry.transactionType === "service";
        const isSale = entry.transactionType === "sale";
        const quantity = Number(entry.quantity) || 1;
        const actorName = entry.sellerName ?? entry.buyerName ?? "Персонаж";
        return {
          ...entry,
          dateText: new Date(entry.timestamp).toLocaleString(game.i18n.lang),
          itemImage: entry.itemImage || "icons/svg/item-bag.svg",
          quantity,
          paymentText: entry.paymentText || "—",
          changeText: entry.changeText || "без сдачи",
          actionText: isSale
            ? `${actorName} продал «${entry.itemName ?? "Предмет"}» ×${quantity}`
            : isService
              ? `${actorName} оплатил услугу «${entry.itemName ?? "Услуга"}»${quantity > 1 ? ` ×${quantity}` : ""}`
              : `${actorName} купил «${entry.itemName ?? "Товар"}» ×${quantity}`,
          transactionLabel: isSale ? "Продажа" : isService ? "Услуга" : "Покупка",
          transactionKind: isSale ? "sale" : isService ? "service" : "buy",
          moneyLineOne: isSale ? `Получено: ${entry.receivedText || entry.priceText || "—"}` : `Списано: ${entry.paymentText || "—"}`,
          moneyLineTwo: isSale ? `В ассортимент: ${entry.restocked === true ? "да" : "нет"}` : `Сдача: ${entry.changeText || "без сдачи"}`,
          walletLine: entry.walletEnabled === true
            ? `Кошелёк: ${entry.walletBeforeText || "—"} → ${entry.walletAfterText || "—"}`
            : "",
          privacyLabel: entry.privatePurchase === true ? "Приватно" : "",
          searchText: `${entry.requesterName ?? ""} ${actorName} ${entry.itemName ?? ""} ${entry.shopName ?? ""} ${isSale ? "продажа" : isService ? "услуга" : "покупка"} ${entry.privatePurchase === true ? "приватно" : ""}`.toLocaleLowerCase(game.i18n.lang)
        };
      });

    const importSummary = this.pendingImport ? ShopBackup.summarize(this.pendingImport) : null;
    const showTransfer = this.currentTab === "transfer" && game.user.isGM;
    const managerTitle = showTransfer ? "Импорт и экспорт" : this.currentTab === "history" ? "История операций" : "Менеджер магазинов";
    const managerIcon = showTransfer ? "fa-file-arrow-down" : this.currentTab === "history" ? "fa-clock-rotate-left" : "fa-store";

    return {
      ...context,
      shops,
      categories,
      categoryCount: rawCategories.length,
      history,
      hasShops: shops.length > 0,
      hasAnyShops: allShops.length > 0,
      hasCategories: categories.length > 0,
      hasHistory: history.length > 0,
      historyCount: history.length,
      shopCount: allShops.length,
      uncategorizedCount,
      allCategoriesSelected: this.selectedCategory === ALL_CATEGORIES,
      uncategorizedSelected: this.selectedCategory === UNCATEGORIZED,
      shopSearch: this.shopSearch,
      historySearch: this.historySearch,
      isGM: game.user.isGM,
      hasSelectedToken: Boolean(selectedToken),
      selectedTokenName: selectedToken?.name ?? "",
      selectedTokenShopName: selectedTokenShop?.name ?? "",
      selectedTokenHasShop: Boolean(selectedTokenShopId),
      selectedTokenMissingShop: Boolean(selectedTokenShopId && !selectedTokenShop),
      showShops: this.currentTab === "shops",
      showHistory: this.currentTab === "history",
      showTransfer,
      managerTitle,
      managerIcon,
      importReady: Boolean(importSummary),
      importFileName: this.pendingImportFileName,
      importSummary,
      coreVersion: game.version,
      systemVersion: game.system.version
    };
  }

  _applyShopSearch() {
    const root = this.element;
    const query = this.shopSearch.trim().toLocaleLowerCase(game.i18n.lang);
    for (const row of root.querySelectorAll("[data-shop-row]")) {
      row.hidden = Boolean(query) && !(row.dataset.search ?? "").includes(query);
    }
  }

  _applyHistorySearch() {
    const root = this.element;
    const query = this.historySearch.trim().toLocaleLowerCase(game.i18n.lang);
    for (const row of root.querySelectorAll("[data-history-row]")) {
      row.hidden = Boolean(query) && !(row.dataset.search ?? "").includes(query);
    }
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;

    for (const tab of root.querySelectorAll("[data-tab]")) {
      tab.addEventListener("click", async event => {
        const requested = event.currentTarget.dataset.tab;
        this.currentTab = requested === "history" ? "history" : requested === "transfer" && game.user.isGM ? "transfer" : "shops";
        await this.render({ force: true });
      });
    }

    root.querySelector("[data-shop-search]")?.addEventListener("input", event => {
      this.shopSearch = event.currentTarget.value;
      this._applyShopSearch();
    });
    this._applyShopSearch();

    root.querySelector("[data-history-search]")?.addEventListener("input", event => {
      this.historySearch = event.currentTarget.value;
      this._applyHistorySearch();
    });
    this._applyHistorySearch();

    for (const button of root.querySelectorAll("[data-category-filter]")) {
      button.addEventListener("click", async event => {
        this.selectedCategory = event.currentTarget.dataset.categoryFilter || ALL_CATEGORIES;
        await this.render({ force: true });
      });
    }

    const categoryInput = root.querySelector("[data-new-category]");
    const createCategory = async () => {
      const name = categoryInput?.value?.trim();
      if (!name) return ui.notifications.warn("Введите название категории.");
      const category = await ShopStore.createCategory(name);
      this.selectedCategory = category.id;
      await this.render({ force: true });
    };
    root.querySelector("[data-action='create-category']")?.addEventListener("click", createCategory);
    categoryInput?.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      createCategory();
    });

    for (const button of root.querySelectorAll("[data-category-id]")) {
      button.addEventListener("click", async event => {
        const categoryId = event.currentTarget.dataset.categoryId;
        const action = event.currentTarget.dataset.action;
        const category = ShopStore.getCategories().find(entry => entry.id === categoryId);
        if (!category) return;

        if (action === "rename-category") {
          const name = await Compat.promptText({
            title: "Переименовать категорию",
            label: "Название категории",
            value: category.name,
            confirmLabel: "Переименовать"
          });
          if (!name || name === category.name) return;
          await ShopStore.updateCategory(categoryId, { name });
          await this.render({ force: true });
        }

        if (action === "delete-category") {
          const confirmed = await Compat.confirm({
            title: "Удалить категорию",
            content: `<p>Удалить категорию <strong>${Compat.escapeHTML(category.name)}</strong>?</p><p>Магазины останутся и будут перемещены в «Без категории».</p>`
          });
          if (!confirmed) return;
          await ShopStore.deleteCategory(categoryId);
          if (this.selectedCategory === categoryId) this.selectedCategory = ALL_CATEGORIES;
          await this.render({ force: true });
        }
      });
    }

    for (const select of root.querySelectorAll("[data-action='set-category']")) {
      select.addEventListener("change", async event => {
        const shopId = event.currentTarget.dataset.shopId;
        const shop = ShopStore.get(shopId);
        try {
          await ShopStore.update(
            shopId,
            { categoryId: event.currentTarget.value || null },
            { expectedShopRevision: shop?.revision ?? null }
          );
        } catch (error) {
          if (String(error?.message ?? error) === "STORE_CONFLICT") {
            ui.notifications.warn("Магазин уже изменился в другом окне. Список обновлён без перезаписи.");
          } else throw error;
        }
        await this.render({ force: true });
      });
    }

    const importFileInput = root.querySelector("[data-import-file]");
    root.querySelector("[data-action='choose-import']")?.addEventListener("click", () => importFileInput?.click());
    importFileInput?.addEventListener("change", async event => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      try {
        this.pendingImport = await ShopBackup.readFile(file);
        this.pendingImportFileName = file.name;
        await this.render({ force: true });
      } catch (error) {
        this.pendingImport = null;
        this.pendingImportFileName = "";
        const code = String(error?.message ?? error);
        const messages = {
          NO_FILE: "Файл не выбран.",
          FILE_TOO_LARGE: "Файл слишком большой. Максимальный размер — 10 МБ.",
          INVALID_JSON: "Файл не является корректным JSON.",
          WRONG_FORMAT: "Это не файл резервной копии Shopwright.",
          INVALID_SCHEMA: "В файле отсутствует корректная версия формата.",
          NEWER_SCHEMA: "Файл создан более новой версией модуля и пока не поддерживается.",
          EMPTY_BACKUP: "В резервной копии нет ни магазинов, ни истории.",
          INVALID_BACKUP: "Структура резервной копии повреждена."
        };
        console.error(`${MODULE_ID} | Ошибка чтения резервной копии`, error);
        ui.notifications.error(messages[code] ?? "Не удалось прочитать резервную копию. Подробности в консоли.");
      }
    });

    root.querySelector("[data-action='clear-import']")?.addEventListener("click", async () => {
      this.pendingImport = null;
      this.pendingImportFileName = "";
      await this.render({ force: true });
    });

    for (const kind of ["shops", "history", "all"]) {
      root.querySelector(`[data-action='export-${kind}']`)?.addEventListener("click", () => {
        if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("SHOPWRIGHT.Notifications.GMOnly"));
        ShopBackup.download(kind);
        const label = kind === "shops" ? "Магазины и категории экспортированы." : kind === "history" ? "История экспортирована." : "Полная резервная копия создана.";
        ui.notifications.info(label);
      });
    }

    root.querySelector("[data-action='run-import']")?.addEventListener("click", async () => {
      if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("SHOPWRIGHT.Notifications.GMOnly"));
      if (!this.pendingImport) return ui.notifications.warn("Сначала выберите файл резервной копии.");

      const summary = ShopBackup.summarize(this.pendingImport);
      const shopsMode = root.querySelector("[data-import-shops-mode]")?.value ?? "skip";
      const historyMode = root.querySelector("[data-import-history-mode]")?.value ?? "skip";
      if (shopsMode === "skip" && historyMode === "skip") return ui.notifications.warn("Выберите, какие данные нужно импортировать.");

      const lines = [];
      if (shopsMode === "merge") lines.push(`Добавить ${summary.shopCount} магазинов; совпадающие категории будут объединены по названию.`);
      if (shopsMode === "replace") lines.push(`Заменить все текущие магазины и категории данными из файла (${summary.shopCount} магазинов).`);
      if (historyMode === "merge") lines.push(`Добавить новые записи истории (${summary.historyCount}); записи с теми же ID не дублируются.`);
      if (historyMode === "replace") lines.push(`Полностью заменить историю данными из файла (${summary.historyCount} записей).`);

      const destructive = shopsMode === "replace" || historyMode === "replace";
      const confirmed = await Compat.confirm({
        title: destructive ? "Подтвердить замену данных" : "Подтвердить импорт",
        content: `<p>${lines.map(line => Compat.escapeHTML(line)).join("</p><p>")}</p>${destructive ? "<p><strong>Заменённые данные нельзя будет вернуть без другой резервной копии.</strong></p>" : ""}`
      });
      if (!confirmed) return;

      try {
        const result = await ShopBackup.import(this.pendingImport, { shopsMode, historyMode });
        const messages = [];
        if (shopsMode === "replace") messages.push(`магазины заменены: ${result.shopsAdded}`);
        else if (shopsMode === "merge") messages.push(`магазинов добавлено: ${result.shopsAdded}`);
        if (result.categoriesAdded) messages.push(shopsMode === "replace" ? `категорий восстановлено: ${result.categoriesAdded}` : `категорий добавлено: ${result.categoriesAdded}`);
        if (historyMode === "replace") messages.push(`история заменена: ${result.historyAdded}`);
        else if (historyMode === "merge") messages.push(`записей истории добавлено: ${result.historyAdded}`);
        ui.notifications.info(`Импорт завершён${messages.length ? ` — ${messages.join(", ")}` : ""}.`);
        this.pendingImport = null;
        this.pendingImportFileName = "";
        this.selectedCategory = ALL_CATEGORIES;
        await this.render({ force: true });
      } catch (error) {
        console.error(`${MODULE_ID} | Ошибка импорта резервной копии`, error);
        ui.notifications.error("Не удалось импортировать резервную копию. Данные могли быть изменены частично; подробности находятся в консоли.");
        await this.render({ force: true });
      }
    });

    root.querySelector("[data-action='clear-history']")?.addEventListener("click", async () => {
      const confirmed = await Compat.confirm({
        title: "Очистить историю",
        content: "<p>Удалить всю историю покупок? Это действие нельзя отменить.</p>"
      });
      if (!confirmed) return;
      await ShopStore.clearHistory();
      ui.notifications.info("История покупок очищена.");
      await this.render({ force: true });
    });

    root.querySelector("[data-action='create']")?.addEventListener("click", async () => {
      if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("SHOPWRIGHT.Notifications.GMOnly"));
      const categoryId = ![ALL_CATEGORIES, UNCATEGORIZED].includes(this.selectedCategory) ? this.selectedCategory : null;
      const shop = await ShopStore.create({ categoryId });
      await this.render({ force: true });
      return Compat.renderApplication(new ShopEditorApp({ shopId: shop.id, manager: this }));
    });

    for (const button of root.querySelectorAll("[data-open-uuid]")) {
      button.addEventListener("click", async event => {
        const document = await Compat.fromUuid(event.currentTarget.dataset.openUuid);
        if (!document) return ui.notifications.warn("Документ больше не найден.");
        Compat.renderSheet(document);
      });
    }

    for (const button of root.querySelectorAll("button[data-shop-id]")) {
      button.addEventListener("click", async event => {
        const action = event.currentTarget.dataset.action;
        const shopId = event.currentTarget.dataset.shopId;
        if (!shopId) return;

        if (action === "open") return Compat.renderApplication(new StorefrontApp({ shopId }));
        if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("SHOPWRIGHT.Notifications.GMOnly"));

        if (action === "bind-token") {
          await TokenShopBinding.toggleSelectedToken(shopId);
          return this.render({ force: true });
        }

        if (action === "edit") return Compat.renderApplication(new ShopEditorApp({ shopId, manager: this }));

        if (action === "duplicate") {
          const duplicate = await ShopStore.duplicate(shopId);
          await this.render({ force: true });
          return Compat.renderApplication(new ShopEditorApp({ shopId: duplicate.id, manager: this }));
        }

        if (action === "delete") {
          const shop = ShopStore.get(shopId);
          const confirmed = await Compat.confirm({
            title: "Удалить магазин",
            content: `<p>Удалить магазин <strong>${Compat.escapeHTML(shop?.name ?? "")}</strong>?</p>`
          });
          if (!confirmed) return;
          try {
            await ShopStore.delete(shopId, { expectedShopRevision: shop?.revision ?? null });
          } catch (error) {
            if (String(error?.message ?? error) === "STORE_CONFLICT") {
              ui.notifications.warn("Магазин уже изменился в другом окне и не был удалён.");
              await this.render({ force: true });
              return;
            }
            throw error;
          }
          ui.notifications.info(game.i18n.localize("SHOPWRIGHT.Notifications.Deleted"));
          await this.render({ force: true });
        }
      });
    }
  }
}
