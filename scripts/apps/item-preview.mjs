import { MODULE_ID } from "../constants.mjs";
import { Compat } from "../compat.mjs";
import { ItemPreviewService } from "../item-preview.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ItemPreviewApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ shopId, entryId, expectedUuid = null, shopRevision = null, ...options } = {}) {
    super(options);
    this.shopId = shopId;
    this.entryId = String(entryId ?? "");
    this.expectedUuid = expectedUuid ? String(expectedUuid) : null;
    this.shopRevision = shopRevision == null ? null : Number(shopRevision);
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "sw-item-preview"],
    window: {
      resizable: true,
      title: "Описание товара",
      icon: "fa-solid fa-book-open"
    },
    position: {
      width: 620,
      height: 650
    }
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/item-preview.hbs`,
      scrollable: [".sw-preview-description"]
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const result = await ItemPreviewService.requestPreview({
      shopId: this.shopId,
      entryId: this.entryId,
      expectedUuid: this.expectedUuid,
      shopRevision: this.shopRevision
    });

    if (!result.ok) return { ...context, error: result.message };

    const meta = [
      result.type ? { label: "Тип", value: result.type } : null,
      result.rarity ? { label: "Редкость", value: result.rarity } : null,
      result.weight ? { label: "Вес", value: result.weight } : null
    ].filter(Boolean);

    return {
      ...context,
      preview: result,
      meta,
      hasMeta: meta.length > 0,
      hasProperties: Array.isArray(result.properties) && result.properties.length > 0,
      canOpenOriginal: game.user.isGM && Boolean(result.sourceUuid)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;

    root.querySelector("[data-action='open-original']")?.addEventListener("click", async () => {
      const uuid = root.querySelector("[data-source-uuid]")?.dataset.sourceUuid;
      if (!uuid) return;
      const item = await Compat.fromUuid(uuid);
      if (!item) return ui.notifications.warn("Исходный предмет больше не найден.");
      Compat.renderSheet(item);
    });
  }
}
