import { MODULE_ID } from "./constants.mjs";
import { Compat } from "./compat.mjs";
import { ShopStore } from "./storage.mjs";
import { ShopManagerApp } from "./apps/manager.mjs";
import { StorefrontApp } from "./apps/storefront.mjs";
import { PurchaseService } from "./purchase.mjs";
import { TradeSettingsApp } from "./apps/trade-settings.mjs";
import { ItemPreviewService } from "./item-preview.mjs";
import { TokenShopBinding } from "./token-shops.mjs";
import { RestockService } from "./restock.mjs";
import { ThemeService } from "./theme.mjs";
import { SocketAuth } from "./socket-auth.mjs";

let manager = null;

function openManager() {
  if (!manager || !manager.rendered) manager = new ShopManagerApp();
  return Compat.renderApplication(manager);
}

function openShop(shopId) {
  return Compat.renderApplication(new StorefrontApp({ shopId }));
}

Hooks.once("init", () => {
  ShopStore.registerSettings();

  game.settings.registerMenu(MODULE_ID, "shop-manager", {
    name: "SHOPWRIGHT.Settings.Name",
    label: "SHOPWRIGHT.Settings.Label",
    hint: "SHOPWRIGHT.Settings.Hint",
    icon: "fa-solid fa-store",
    type: ShopManagerApp,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "trade-settings", {
    name: "Настройки торговли",
    label: "Настроить валюту и чеки",
    hint: "Выберите валюты, которые участвуют в покупках и выдаче сдачи.",
    icon: "fa-solid fa-coins",
    type: TradeSettingsApp,
    restricted: true
  });

  game.keybindings.register(MODULE_ID, "open-manager", {
    name: "Открыть менеджер магазинов",
    hint: "Открывает менеджер магазинов Shopwright.",
    editable: [{ key: "KeyM", modifiers: ["CONTROL", "SHIFT"] }],
    restricted: true,
    onDown: () => {
      openManager();
      return true;
    }
  });

  console.log(`${MODULE_ID} | init | Foundry ${game.version}, ${game.system?.id ?? "no-system"} ${game.system?.version ?? ""}`);
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const tokenControls = controls.tokens;
  if (!tokenControls?.tools) return;

  tokenControls.tools[`${MODULE_ID}-manager`] = {
    name: `${MODULE_ID}-manager`,
    title: "SHOPWRIGHT.Controls.Title",
    icon: "fa-solid fa-store",
    order: Object.keys(tokenControls.tools).length,
    button: true,
    visible: true,
    onChange: () => openManager()
  };
});

// Тема вешается на корень каждого окна модуля при отрисовке.
Hooks.on("renderApplicationV2", (application, element) => {
  const root = element instanceof HTMLElement ? element : application?.element;
  if (!root?.classList?.contains(MODULE_ID)) return;
  ThemeService.applyToElement(root);
});

Hooks.on("controlToken", () => {
  if (manager?.rendered) manager.render({ force: true });
});

Hooks.on(`${MODULE_ID}.tokenBindingChanged`, () => {
  if (manager?.rendered) manager.render({ force: true });
});

Hooks.once("ready", async () => {
  ThemeService.initialize();
  if (Compat.getPrimaryActiveGM()?.id === game.user.id) {
    try {
      await ShopStore.ensureStableItemIds();
    } catch (error) {
      console.error(`${MODULE_ID} | Не удалось добавить стабильные ID товарным позициям`, error);
      ui.notifications.error("Shopwright: не удалось подготовить данные товарных позиций. Подробности в консоли.");
    }
  }
  try {
    await SocketAuth.initialize();
  } catch (error) {
    console.error(`${MODULE_ID} | Не удалось инициализировать защиту сокет-запросов`, error);
    ui.notifications.error("Shopwright: не удалось подготовить защищённые сетевые операции. Перезагрузите страницу.");
  }
  PurchaseService.initialize();
  ItemPreviewService.initialize();
  TokenShopBinding.initialize();
  if (game.system.id !== "dnd5e") {
    ui.notifications.warn("Shopwright рассчитан на систему dnd5e.");
  }

  if (![13, 14].includes(Compat.coreGeneration)) {
    ui.notifications.warn(`Shopwright не тестировался на Foundry ${Compat.coreGeneration}.`);
  }

  game.shopwright = {
    openManager,
    openShop,
    getShops: () => ShopStore.getAll(),
    bindSelectedToken: shopId => TokenShopBinding.toggleSelectedToken(shopId),
    openTokenShop: tokenDocument => TokenShopBinding.openTokenShop(tokenDocument),
    restockShop: shopId => RestockService.applyDue(shopId),
    version: game.modules.get(MODULE_ID)?.version ?? "unknown"
  };

  console.log(`${MODULE_ID} | ready | API: game.shopwright.openManager(), game.shopwright.openShop(shopId)`);
});
