import { MODULE_ID } from "../constants.mjs";
import { Compat } from "../compat.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class BuyerPickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ selectedUuid = null, onSelect = null, ...options } = {}) {
    super(options);
    this.selectedUuid = selectedUuid;
    this.onSelect = onSelect;
  }

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, "sw-buyer-picker"],
    window: {
      resizable: true,
      title: "Выбор покупателя",
      icon: "fa-solid fa-user-tag"
    },
    position: {
      width: 540,
      height: 640
    }
  };

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/buyer-picker.hbs`,
      scrollable: [".sw-buyer-list"]
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actors = Compat.getPurchasableActors(game.user).map(actor => ({
      uuid: actor.uuid,
      name: actor.name,
      image: actor.img,
      type: Compat.getActorTypeLabel(actor),
      folder: actor.folder?.name ?? (actor.isToken ? "Токен на текущей сцене" : "Без папки"),
      wallet: Compat.formatActorWallet(actor),
      walletParts: Compat.formatActorWalletParts(actor),
      selected: actor.uuid === this.selectedUuid,
      searchText: `${actor.name} ${actor.type} ${actor.folder?.name ?? ""}`.toLocaleLowerCase(game.i18n.lang)
    }));

    return {
      ...context,
      actors,
      hasActors: actors.length > 0,
      isGM: game.user.isGM
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    const search = root.querySelector("[data-buyer-search]");

    search?.addEventListener("input", event => {
      const query = event.currentTarget.value.trim().toLocaleLowerCase(game.i18n.lang);
      for (const row of root.querySelectorAll("[data-buyer-row]")) {
        const haystack = row.dataset.search ?? "";
        row.hidden = Boolean(query) && !haystack.includes(query);
      }
    });

    for (const button of root.querySelectorAll("[data-buyer-uuid]")) {
      button.addEventListener("click", async event => {
        const uuid = event.currentTarget.dataset.buyerUuid;
        const actor = await Compat.fromUuid(uuid);
        if (!Compat.canPurchaseAs(actor, game.user)) {
          return ui.notifications.warn("У вас больше нет доступа к этому актёру.");
        }

        await this.onSelect?.(actor);
        await this.close();
      });
    }
  }
}
