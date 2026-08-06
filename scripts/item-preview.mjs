import { MODULE_ID, SOCKET_NAME } from "./constants.mjs";
import { Compat } from "./compat.mjs";
import { ShopStore } from "./storage.mjs";
import { SocketAuth } from "./socket-auth.mjs";

const pendingRequests = new Map();
const previewCache = new Map();
const REQUEST_TIMEOUT = 20000;

const ERROR_MESSAGES = Object.freeze({
  NO_ACTIVE_GM: "Описание недоступно: сейчас нет активного клиента мастера.",
  REQUEST_TIMEOUT: "Мастерская сторона не ответила на запрос описания. Проверьте, что модуль обновлён у всех участников.",
  REQUESTER_NOT_FOUND: "Не удалось определить игрока, запросившего описание.",
  SOCKET_AUTH_FAILED: "Не удалось подтвердить отправителя запроса описания.",
  SHOP_NOT_FOUND: "Магазин больше не найден.",
  STORE_CONFLICT: "Магазин изменился. Обновите витрину и откройте описание снова.",
  ITEM_NOT_FOUND: "Этот товар больше не найден в магазине.",
  SOURCE_ITEM_NOT_FOUND: "Исходный предмет из компендиума больше не найден.",
  PREVIEW_FAILED: "Не удалось подготовить описание товара. Подробности записаны в консоль мастера."
});

function errorCode(error) {
  const code = String(error?.message ?? error ?? "");
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? code : "PREVIEW_FAILED";
}

function failure(error) {
  const code = errorCode(error);
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

function itemModifiedTime(item) {
  const value = Number(item?._stats?.modifiedTime ?? item?._source?._stats?.modifiedTime);
  return Number.isFinite(value) ? value : 0;
}

function cacheKey(shop, entry, item) {
  return [
    shop.id,
    shop.revision ?? 0,
    entry.id,
    entry.uuid,
    itemModifiedTime(item),
    entry.customPrice ?? "auto"
  ].join(":");
}

async function buildPreview({ requester, shopId, entryId, expectedUuid = null, shopRevision = null }) {
  if (!requester) throw new Error("REQUESTER_NOT_FOUND");

  const shop = ShopStore.get(shopId);
  if (!shop) throw new Error("SHOP_NOT_FOUND");
  if (shopRevision != null && shop.revision !== Number(shopRevision)) throw new Error("STORE_CONFLICT");

  const entry = shop.items.find(item => item.id === String(entryId ?? ""));
  if (!entry) throw new Error("ITEM_NOT_FOUND");
  if (expectedUuid && entry.uuid !== String(expectedUuid)) throw new Error("STORE_CONFLICT");

  const item = await Compat.fromUuid(entry.uuid);
  if (!item || item.documentName !== "Item") throw new Error("SOURCE_ITEM_NOT_FOUND");

  const key = cacheKey(shop, entry, item);
  let preview = previewCache.get(key);
  if (!preview) {
    const denomination = Compat.getItemCurrency(item);
    const price = Compat.calculateShopPrice(shop, entry, item);
    const descriptionHtml = await Compat.prepareItemPreviewDescription(item);
    preview = {
      ok: true,
      shopId: shop.id,
      shopName: shop.name,
      entryId: entry.id,
      name: item.name,
      image: item.img,
      type: Compat.getItemTypeLabel(item),
      rarity: Compat.getItemRarityLabel(item),
      weight: Compat.getItemWeightText(item),
      properties: Compat.getItemPropertyLabels(item),
      descriptionHtml,
      price,
      denomination,
      priceText: Compat.formatPrice(price, denomination),
      priceParts: Compat.formatPriceParts(price, denomination),
      rarityKey: Compat.getItemRarityKey(item),
      quantityText: entry.quantity == null ? "∞" : String(entry.quantity),
      soldOut: entry.quantity === 0,
      sourceModifiedTime: itemModifiedTime(item)
    };
    previewCache.set(key, Compat.clone(preview));
  }

  return {
    ...Compat.clone(preview),
    sourceUuid: requester.isGM ? item.uuid : null
  };
}

export class ItemPreviewService {
  static initialize() {
    game.socket.on(SOCKET_NAME, payload => this._onSocket(payload));
    Hooks.on(`${MODULE_ID}.stockChanged`, shopId => this.clearShop(shopId));
    Hooks.on("updateItem", () => previewCache.clear());
    Hooks.on("deleteItem", () => previewCache.clear());
    console.log(`${MODULE_ID} | item preview socket ready | ${SOCKET_NAME}`);
  }

  static clearShop(shopId) {
    const prefix = `${shopId}:`;
    for (const key of previewCache.keys()) {
      if (key.startsWith(prefix)) previewCache.delete(key);
    }
  }

  static async requestPreview({ shopId, entryId, expectedUuid = null, shopRevision = null }) {
    const shop = ShopStore.get(shopId);
    if (!shop) return failure(new Error("SHOP_NOT_FOUND"));
    if (shopRevision != null && shop.revision !== Number(shopRevision)) return failure(new Error("STORE_CONFLICT"));
    const entry = shop.items?.find(item => item.id === String(entryId ?? ""));
    if (!entry) return failure(new Error("ITEM_NOT_FOUND"));
    if (expectedUuid && entry.uuid !== String(expectedUuid)) return failure(new Error("STORE_CONFLICT"));

    if (game.user.isGM) {
      return this._process({
        requester: game.user,
        shopId,
        entryId,
        expectedUuid,
        shopRevision
      });
    }

    const gm = Compat.getPrimaryActiveGM();
    if (!gm) return failure(new Error("NO_ACTIVE_GM"));

    const requestId = Compat.randomID();
    return new Promise(resolve => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(failure(new Error("REQUEST_TIMEOUT")));
      }, REQUEST_TIMEOUT);

      pendingRequests.set(requestId, { resolve, timeout });
      void SocketAuth.sign({
        type: "item-preview-request",
        requestId,
        shopId,
        entryId,
        expectedUuid,
        shopRevision
      }).then(payload => game.socket.emit(SOCKET_NAME, payload)).catch(error => {
        window.clearTimeout(timeout);
        pendingRequests.delete(requestId);
        console.error(`${MODULE_ID} | Не удалось подписать запрос описания`, error);
        resolve(failure(new Error("SOCKET_AUTH_FAILED")));
      });
    });
  }

  static async _process(payload) {
    try {
      return await buildPreview(payload);
    } catch (error) {
      console.error(`${MODULE_ID} | Не удалось подготовить карточку товара`, error);
      return failure(error);
    }
  }

  static async _onSocket(payload) {
    if (!payload || typeof payload !== "object") return;

    if (payload.type === "item-preview-result") {
      if (payload.recipientId !== game.user.id) return;
      const primaryGM = Compat.getPrimaryActiveGM();
      if (!primaryGM) return;
      const signer = await SocketAuth.verify(payload, { expectedSenderId: primaryGM.id });
      if (!signer) return;
      const pending = pendingRequests.get(payload.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pendingRequests.delete(payload.requestId);
      pending.resolve(payload.result);
      return;
    }

    if (payload.type !== "item-preview-request" || !game.user.isGM) return;
    const primaryGM = Compat.getPrimaryActiveGM();
    if (!primaryGM || primaryGM.id !== game.user.id) return;

    const requester = await SocketAuth.verify(payload);
    const result = requester && !requester.isGM
      ? await this._process({ ...payload, requester })
      : failure(new Error("SOCKET_AUTH_FAILED"));
    const recipientId = requester?.id ?? payload.senderId;
    if (!recipientId) return;
    const response = await SocketAuth.sign({
      type: "item-preview-result",
      requestId: payload.requestId,
      recipientId,
      result
    });
    game.socket.emit(SOCKET_NAME, response);
  }
}
