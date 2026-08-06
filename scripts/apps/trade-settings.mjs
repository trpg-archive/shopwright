import { MODULE_ID } from "../constants.mjs";
import { ShopStore } from "../storage.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class TradeSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-trade-settings`,
    classes: [MODULE_ID, "sw-trade-settings"],
    window: {
      resizable: true,
      title: "Настройки торговли",
      icon: "fa-solid fa-coins"
    },
    position: {
      width: 560,
      height: 500
    }
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/trade-settings.hbs`
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const config = ShopStore.getTradeConfig();
    return { ...context, config };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    const form = root.querySelector("form.sw-trade-settings-form");
    form?.addEventListener("submit", async event => {
      event.preventDefault();
      const checked = name => form.querySelector(`[name="${name}"]`)?.checked === true;
      await ShopStore.saveTradeConfig({
        currencies: {
          pp: checked("currency.pp"),
          gp: checked("currency.gp"),
          ep: checked("currency.ep"),
          sp: checked("currency.sp"),
          cp: checked("currency.cp")
        },
        chatReceipts: checked("chatReceipts")
      });
      ui.notifications.info("Настройки торговли сохранены.");
      await this.close();
    });
  }
}
