import { MODULE_ID } from "./constants.mjs";
import { Compat } from "./compat.mjs";
import { ShopStore } from "./storage.mjs";
import { StorefrontApp } from "./apps/storefront.mjs";

export const TOKEN_SHOP_FLAG = "shopId";
export const TOKEN_ORIGINAL_APPEARANCE_FLAG = "originalAppearance";

function htmlRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function tokenDocumentFromConfig(app) {
  const candidate = app?.document
    ?? app?.token?.document
    ?? app?.object?.document
    ?? app?.object
    ?? null;
  if (candidate?.documentName !== "Token") return null;
  if (candidate?.parent?.documentName !== "Scene") return null;
  return candidate;
}

function canvasElement() {
  return canvas?.app?.canvas ?? canvas?.app?.view ?? null;
}

export class TokenShopBinding {
  static initialized = false;
  static _canvasElement = null;
  static _lastPointer = null;
  static _lastOpened = null;
  static initialize() {
    if (this.initialized) return;
    this.initialized = true;

    Hooks.on("renderTokenConfig", (app, html) => this._injectTokenConfig(app, html));

    // Магазины открываются через публичные DOM-события canvas.
    // Приватные методы Token и его прототип не изменяются.
    Hooks.on("canvasReady", () => this._attachCanvas());
    Hooks.on("canvasTearDown", () => this._detachCanvas());
    if (canvas?.ready) this._attachCanvas();

    if (Compat.getPrimaryActiveGM()?.id === game.user.id) {
      void this.syncAllTokenAppearances().catch(error => {
        console.error(`${MODULE_ID} | Не удалось синхронизировать внешний вид токенов-магазинов`, error);
      });
    }
  }

  static getShopId(tokenDocument) {
    const value = tokenDocument?.getFlag?.(MODULE_ID, TOKEN_SHOP_FLAG)
      ?? tokenDocument?.flags?.[MODULE_ID]?.[TOKEN_SHOP_FLAG]
      ?? "";
    return String(value ?? "").trim();
  }

  static getSelectedTokenDocument() {
    const controlled = Array.from(canvas?.tokens?.controlled ?? []);
    return controlled.length === 1 ? controlled[0].document : null;
  }

  static _getOriginalAppearance(tokenDocument) {
    const stored = tokenDocument?.getFlag?.(MODULE_ID, TOKEN_ORIGINAL_APPEARANCE_FLAG)
      ?? tokenDocument?.flags?.[MODULE_ID]?.[TOKEN_ORIGINAL_APPEARANCE_FLAG]
      ?? null;
    if (!stored || typeof stored !== "object") return null;
    const name = String(stored.name ?? "").trim();
    const textureSrc = String(stored.textureSrc ?? "").trim();
    if (!name && !textureSrc) return null;
    return { name, textureSrc };
  }

  static _currentAppearance(tokenDocument) {
    return {
      name: String(tokenDocument?.name ?? tokenDocument?.actor?.name ?? "Торговец"),
      textureSrc: String(tokenDocument?.texture?.src ?? tokenDocument?.actor?.img ?? "")
    };
  }

  static _prototypeAppearance(tokenDocument) {
    const actor = tokenDocument?.actor;
    const prototype = actor?.prototypeToken;
    return {
      name: String(prototype?.name ?? actor?.name ?? tokenDocument?.name ?? "Торговец"),
      textureSrc: String(prototype?.texture?.src ?? actor?.img ?? tokenDocument?.texture?.src ?? "")
    };
  }

  static async setShop(tokenDocument, shopId, { notify = true } = {}) {
    if (!game.user.isGM) throw new Error("GM_ONLY");
    if (!tokenDocument || tokenDocument.documentName !== "Token" || tokenDocument.parent?.documentName !== "Scene") {
      throw new Error("TOKEN_NOT_FOUND");
    }

    const normalizedId = String(shopId ?? "").trim();
    const currentId = this.getShopId(tokenDocument);
    const shop = normalizedId ? ShopStore.get(normalizedId) : null;
    if (normalizedId && !shop) throw new Error("SHOP_NOT_FOUND");

    if (normalizedId) {
      let original = this._getOriginalAppearance(tokenDocument);
      if (!original) {
        original = currentId
          ? this._prototypeAppearance(tokenDocument)
          : this._currentAppearance(tokenDocument);
        await tokenDocument.setFlag(MODULE_ID, TOKEN_ORIGINAL_APPEARANCE_FLAG, original);
      }

      await tokenDocument.setFlag(MODULE_ID, TOKEN_SHOP_FLAG, normalizedId);
      await tokenDocument.update({
        name: shop.name,
        "texture.src": shop.image
      });
    } else {
      const original = this._getOriginalAppearance(tokenDocument)
        ?? this._prototypeAppearance(tokenDocument);

      await tokenDocument.update({
        name: original.name || tokenDocument.name,
        "texture.src": original.textureSrc || tokenDocument.texture?.src
      });
      await tokenDocument.unsetFlag(MODULE_ID, TOKEN_SHOP_FLAG);
      await tokenDocument.unsetFlag(MODULE_ID, TOKEN_ORIGINAL_APPEARANCE_FLAG);
    }

    Hooks.callAll(`${MODULE_ID}.tokenBindingChanged`, tokenDocument, normalizedId);
    if (notify) {
      ui.notifications.info(shop
        ? `Токен получил имя и изображение магазина «${shop.name}».`
        : `Привязка магазина снята, прежний внешний вид токена восстановлен.`);
    }
    return normalizedId;
  }

  static async syncShopTokens(shopId) {
    if (!game.user.isGM) return 0;
    const shop = ShopStore.get(shopId);
    if (!shop) return 0;

    let changed = 0;
    for (const scene of game.scenes ?? []) {
      const updates = [];
      for (const token of scene.tokens ?? []) {
        if (this.getShopId(token) !== shopId) continue;

        const update = { _id: token.id };
        let needsUpdate = false;
        if (token.name !== shop.name) {
          update.name = shop.name;
          needsUpdate = true;
        }
        if (token.texture?.src !== shop.image) {
          update["texture.src"] = shop.image;
          needsUpdate = true;
        }
        if (!this._getOriginalAppearance(token)) {
          update[`flags.${MODULE_ID}.${TOKEN_ORIGINAL_APPEARANCE_FLAG}`] = this._prototypeAppearance(token);
          needsUpdate = true;
        }
        if (needsUpdate) updates.push(update);
      }

      if (updates.length) {
        await scene.updateEmbeddedDocuments("Token", updates);
        changed += updates.length;
      }
    }

    if (changed) Hooks.callAll(`${MODULE_ID}.tokenAppearanceSynced`, shopId, changed);
    return changed;
  }

  static async syncAllTokenAppearances() {
    if (!game.user.isGM) return 0;
    const shops = new Map(ShopStore.getAll().map(shop => [shop.id, shop]));
    let changed = 0;

    for (const scene of game.scenes ?? []) {
      const updates = [];
      for (const token of scene.tokens ?? []) {
        const shopId = this.getShopId(token);
        const shop = shops.get(shopId);
        if (!shop) continue;

        const update = { _id: token.id };
        let needsUpdate = false;
        if (token.name !== shop.name) {
          update.name = shop.name;
          needsUpdate = true;
        }
        if (token.texture?.src !== shop.image) {
          update["texture.src"] = shop.image;
          needsUpdate = true;
        }
        if (!this._getOriginalAppearance(token)) {
          update[`flags.${MODULE_ID}.${TOKEN_ORIGINAL_APPEARANCE_FLAG}`] = this._prototypeAppearance(token);
          needsUpdate = true;
        }
        if (needsUpdate) updates.push(update);
      }

      if (updates.length) {
        await scene.updateEmbeddedDocuments("Token", updates);
        changed += updates.length;
      }
    }

    return changed;
  }

  static async toggleSelectedToken(shopId) {
    const tokenDocument = this.getSelectedTokenDocument();
    if (!tokenDocument) {
      ui.notifications.warn("Выберите ровно один токен на текущей сцене.");
      return false;
    }

    const current = this.getShopId(tokenDocument);
    await this.setShop(tokenDocument, current === shopId ? "" : shopId);
    return true;
  }

  static async openTokenShop(tokenDocument) {
    const shopId = this.getShopId(tokenDocument);
    if (!shopId) return false;

    // Один физический двойной щелчок может прийти и через PIXI, и через DOM.
    // Не даём двум путям открыть две одинаковые витрины.
    const tokenKey = String(tokenDocument?.uuid ?? tokenDocument?.id ?? shopId);
    const openedAt = performance.now();
    const previous = this._lastOpened;
    if (previous?.tokenId === tokenKey && (openedAt - previous.time) <= 800) return true;

    const shop = ShopStore.get(shopId);
    if (!shop) {
      ui.notifications.warn(game.user.isGM
        ? `Привязанный к токену «${tokenDocument.name}» магазин больше не существует.`
        : "Этот магазин сейчас недоступен.");
      return false;
    }

    this._lastOpened = { tokenId: tokenKey, time: openedAt };
    Compat.renderApplication(new StorefrontApp({ shopId }));
    return true;
  }


  static _isShiftModified(event) {
    return Boolean(
      event?.shiftKey
      ?? event?.nativeEvent?.shiftKey
      ?? event?.data?.originalEvent?.shiftKey
      ?? false
    );
  }

  static _attachCanvas() {
    const element = canvasElement();
    if (!element) return;
    if (this._canvasElement === element) return;
    this._detachCanvas();

    this._pointerHandler ??= event => this._onPointerDown(event);
    this._doubleClickHandler ??= event => this._onDoubleClick(event);
    this._canvasElement = element;

    // Слушаем второй pointerdown на window в capture-фазе. Это происходит
    // раньше обработчиков самого canvas и PIXI/MouseInteractionManager Foundry,
    // поэтому быстрый двойной щелчок по токену-магазину можно остановить до
    // того, как Foundry успеет открыть Actor. Первый щелчок не блокируется.
    window.addEventListener("pointerdown", this._pointerHandler, true);
    element.addEventListener("dblclick", this._doubleClickHandler, true);
  }

  static _detachCanvas() {
    const element = this._canvasElement;
    if (this._pointerHandler) window.removeEventListener("pointerdown", this._pointerHandler, true);
    if (element && this._doubleClickHandler) {
      element.removeEventListener("dblclick", this._doubleClickHandler, true);
    }
    this._canvasElement = null;
    this._lastPointer = null;
    this._lastOpened = null;
  }

  static _isCanvasEvent(event) {
    const element = this._canvasElement ?? canvasElement();
    return Boolean(element && (event.target === element || element.contains?.(event.target)));
  }

  static _tokenAtCanvasPoint(x, y) {
    if (!canvas?.ready || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const tokens = Array.from(canvas.tokens?.placeables ?? []).reverse();
    return tokens.find(token => token?.isVisible && token.bounds?.contains?.(x, y)) ?? null;
  }

  static _tokenAtEvent(event) {
    if (!canvas?.ready || !this._isCanvasEvent(event)) return null;
    const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    return this._tokenAtCanvasPoint(point.x, point.y);
  }

  static _onPointerDown(event) {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const token = this._tokenAtEvent(event);
    const shopId = this.getShopId(token?.document);
    if (!token || !shopId) {
      this._lastPointer = null;
      return;
    }

    const now = performance.now();
    const prior = this._lastPointer;
    const isSecond = prior
      && prior.tokenId === token.id
      && (now - prior.time) <= 450;

    if (!isSecond) {
      this._lastPointer = { tokenId: token.id, time: now };
      return;
    }

    this._lastPointer = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    void this.openTokenShop(token.document);
  }

  static _onDoubleClick(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!this._isCanvasEvent(event)) return;
    const token = this._tokenAtEvent(event);
    if (!token || !this.getShopId(token.document)) return;

    void this.openTokenShop(token.document);
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  static _injectTokenConfig(app, html) {
    if (!game.user.isGM) return;
    const tokenDocument = tokenDocumentFromConfig(app);
    const root = htmlRoot(html);
    if (!tokenDocument || !root) return;

    root.querySelector("[data-sw-token-binding]")?.remove();
    const form = root.matches("form") ? root : root.querySelector("form");
    if (!form) return;

    const shops = ShopStore.getAll().sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    const categories = ShopStore.getCategories().sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    const currentId = this.getShopId(tokenDocument);

    const fieldset = document.createElement("fieldset");
    fieldset.className = "sw-token-binding";
    fieldset.dataset.swTokenBinding = "";

    const legend = document.createElement("legend");
    legend.innerHTML = '<i class="fa-solid fa-store"></i> Shopwright';
    fieldset.append(legend);

    const hint = document.createElement("p");
    hint.textContent = "Имя и изображение этого токена будут взяты из магазина. Актёр и его прототип токена не изменятся.";
    fieldset.append(hint);

    const row = document.createElement("div");
    row.className = "sw-token-binding-row";

    const select = document.createElement("select");
    select.setAttribute("aria-label", "Магазин токена");
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "Не привязан к магазину";
    select.append(emptyOption);

    const shopsByCategory = new Map(categories.map(category => [category.id, []]));
    const uncategorized = [];
    for (const shop of shops) {
      if (shop.categoryId && shopsByCategory.has(shop.categoryId)) shopsByCategory.get(shop.categoryId).push(shop);
      else uncategorized.push(shop);
    }

    const addOptions = (parent, entries) => {
      for (const shop of entries) {
        const option = document.createElement("option");
        option.value = shop.id;
        option.textContent = shop.name;
        option.selected = shop.id === currentId;
        parent.append(option);
      }
    };

    addOptions(select, uncategorized);
    for (const category of categories) {
      const entries = shopsByCategory.get(category.id) ?? [];
      if (!entries.length) continue;
      const group = document.createElement("optgroup");
      group.label = category.name;
      addOptions(group, entries);
      select.append(group);
    }

    if (currentId && !ShopStore.get(currentId)) {
      const missing = document.createElement("option");
      missing.value = currentId;
      missing.textContent = "Удалённый магазин";
      missing.selected = true;
      select.append(missing);
    }

    select.disabled = shops.length === 0 && !currentId;
    row.append(select);

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.title = "Сохранить привязку";
    saveButton.innerHTML = '<i class="fa-solid fa-link"></i><span>Привязать</span>';
    saveButton.addEventListener("click", async event => {
      event.preventDefault();
      try {
        await this.setShop(tokenDocument, select.value);
        openButton.disabled = !select.value || !ShopStore.get(select.value);
      } catch (error) {
        console.error(`${MODULE_ID} | Не удалось привязать магазин к токену`, error);
        ui.notifications.error("Не удалось сохранить привязку магазина.");
      }
    });
    row.append(saveButton);

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.title = "Открыть витрину";
    openButton.innerHTML = '<i class="fa-solid fa-eye"></i>';
    openButton.disabled = !currentId || !ShopStore.get(currentId);
    openButton.addEventListener("click", event => {
      event.preventDefault();
      void this.openTokenShop(tokenDocument);
    });
    row.append(openButton);

    fieldset.append(row);

    const footer = form.querySelector("footer, .form-footer");
    if (footer?.parentElement) footer.parentElement.insertBefore(fieldset, footer);
    else form.append(fieldset);
  }
}
