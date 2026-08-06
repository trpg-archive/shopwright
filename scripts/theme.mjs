/**
 * Управление темой оформления модуля.
 *
 * Foundry 13/14 ставит на <body> класс theme-light или theme-dark в
 * зависимости от выбранной пользователем схемы. Режим "Система" следует
 * за этим классом, остальные три режима задают тему принудительно.
 *
 * Класс вешается на корневой элемент каждого окна модуля, а не на body,
 * чтобы не влиять на остальной интерфейс Foundry.
 */

import { MODULE_ID, SETTINGS, THEMES, THEME_CLASSES } from "./constants.mjs";

const ALL_THEME_CLASSES = Object.values(THEME_CLASSES);

let bodyObserver = null;

export const ThemeService = {
  /** Выбранный в настройках режим: system | dark | light | cool. */
  getMode() {
    try {
      const value = game.settings.get(MODULE_ID, SETTINGS.THEME);
      return Object.values(THEMES).includes(value) ? value : THEMES.SYSTEM;
    } catch (error) {
      return THEMES.SYSTEM;
    }
  },

  /** Тема, которую наследует режим "Система" от самого Foundry. */
  getFoundryTheme() {
    const body = document.body;
    if (body?.classList.contains("theme-light")) return THEMES.LIGHT;
    if (body?.classList.contains("theme-dark")) return THEMES.DARK;

    // Foundry мог ещё не проставить класс — спрашиваем систему напрямую.
    const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)")?.matches;
    return prefersLight ? THEMES.LIGHT : THEMES.DARK;
  },

  /** Тема, которая должна применяться прямо сейчас. */
  getEffectiveTheme() {
    const mode = this.getMode();
    return mode === THEMES.SYSTEM ? this.getFoundryTheme() : mode;
  },

  /** Вешает класс темы на один корневой элемент окна. */
  applyToElement(element) {
    if (!element?.classList) return;
    const themeClass = THEME_CLASSES[this.getEffectiveTheme()] ?? THEME_CLASSES[THEMES.DARK];
    for (const candidate of ALL_THEME_CLASSES) {
      if (candidate !== themeClass) element.classList.remove(candidate);
    }
    element.classList.add(themeClass);
  },

  /** Пересобирает тему во всех открытых окнах модуля. */
  applyToOpenWindows() {
    for (const element of document.querySelectorAll(`.${MODULE_ID}`)) {
      this.applyToElement(element);
    }
  },

  /**
   * Следит за сменой темы самого Foundry, чтобы режим "Система" реагировал
   * без перезагрузки. Наблюдатель нужен только в этом режиме, но дешевле
   * держать его всегда, чем пересоздавать при каждой смене настройки.
   */
  initialize() {
    this.applyToOpenWindows();

    if (bodyObserver) return;
    bodyObserver = new MutationObserver(() => {
      if (this.getMode() === THEMES.SYSTEM) this.applyToOpenWindows();
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
};
