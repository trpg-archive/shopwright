export const MODULE_ID = "shopwright";
export const SOCKET_NAME = `module.${MODULE_ID}`;

export const SETTINGS = {
  SHOPS: "shops-json",
  CATEGORIES: "shop-categories-json",
  LAST_BUYER: "last-buyer-uuid",
  TRADE_CONFIG: "trade-config-json",
  PURCHASE_HISTORY: "purchase-history-json",
  THEME: "ui-theme",
  // Старые ключи 0.2.1 сохраняются только для мягкой миграции.
  CURRENCY_PP: "currency-pp",
  CURRENCY_GP: "currency-gp",
  CURRENCY_EP: "currency-ep",
  CURRENCY_SP: "currency-sp",
  CURRENCY_CP: "currency-cp",
  CHAT_RECEIPTS: "chat-receipts"
};

export const CURRENCY_SETTING_BY_DENOMINATION = Object.freeze({
  pp: SETTINGS.CURRENCY_PP,
  gp: SETTINGS.CURRENCY_GP,
  ep: SETTINGS.CURRENCY_EP,
  sp: SETTINGS.CURRENCY_SP,
  cp: SETTINGS.CURRENCY_CP
});

export const DEFAULT_TRADE_CONFIG = Object.freeze({
  initialized: false,
  currencies: Object.freeze({
    pp: true,
    gp: true,
    ep: true,
    sp: true,
    cp: true
  }),
  chatReceipts: true
});

export const THEMES = Object.freeze({
  SYSTEM: "system",
  DARK: "dark",
  LIGHT: "light",
  COOL: "cool"
});

export const THEME_CLASSES = Object.freeze({
  [THEMES.DARK]: "sw-theme-dark",
  [THEMES.LIGHT]: "sw-theme-light",
  [THEMES.COOL]: "sw-theme-cool"
});

export const DEFAULT_IMAGE = "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp";
