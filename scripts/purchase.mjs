import { MODULE_ID, SOCKET_NAME } from "./constants.mjs";
import { Compat } from "./compat.mjs";
import { ShopStore } from "./storage.mjs";
import { RestockService } from "./restock.mjs";
import { SocketAuth } from "./socket-auth.mjs";

const pendingRequests = new Map();
const shopLocks = new Map();
const REQUEST_TIMEOUT = 20000;

const ERROR_MESSAGES = Object.freeze({
  NO_ACTIVE_GM: "Операция невозможна: сейчас нет активного клиента мастера, который автоматически проведёт транзакцию.",
  REQUEST_TIMEOUT: "Автоматическая обработка не ответила. Проверьте, что мастер подключён и модуль обновлён у всех участников.",
  REQUESTER_NOT_FOUND: "Не удалось определить игрока, отправившего запрос.",
  INVALID_REQUESTER: "Некорректный запрос операции.",
  SOCKET_AUTH_FAILED: "Не удалось подтвердить отправителя операции. Обновите модуль у всех участников и перезагрузите страницу.",
  STORE_CONFLICT: "Данные магазина изменились в другом окне. Операция отменена, чтобы не перезаписать свежие изменения.",
  ACTOR_NOT_FOUND: "Выбранный персонаж больше не найден.",
  NOT_OWNER: "У вас нет прав владельца на выбранного персонажа.",
  SHOP_NOT_FOUND: "Магазин больше не найден.",
  ITEM_NOT_FOUND: "Этот товар больше не найден в магазине.",
  SOURCE_ITEM_NOT_FOUND: "Исходный предмет больше не найден.",
  ACTOR_ITEM_NOT_FOUND: "Предмет больше не найден в инвентаре выбранного персонажа.",
  INVALID_QUANTITY: "Указано некорректное количество.",
  NOT_ENOUGH_ITEMS: "В инвентаре недостаточно предметов для продажи.",
  SOLD_OUT: "В магазине недостаточно товара.",
  SALE_DISABLED: "Этот магазин сейчас не скупает предметы.",
  ITEM_NOT_SELLABLE: "Этот предмет нельзя продать магазину.",
  SALE_PRICE_ZERO: "Магазин не предлагает за этот предмет ни одной монеты.",
  UNSUPPORTED_CURRENCY: "Валюта этого предмета пока не поддерживается.",
  NO_ENABLED_CURRENCY: "В настройках магазина отключены все валюты.",
  CANNOT_MAKE_CHANGE: "Невозможно выдать точную сумму разрешёнными валютами.",
  INSUFFICIENT_FUNDS: "У выбранного покупателя недостаточно денег.",
  MERCHANT_INSUFFICIENT_FUNDS: "У торговца недостаточно денег для выкупа выбранного количества.",
  ITEM_CREATE_FAILED: "Не удалось добавить предмет покупателю.",
  PURCHASE_FAILED: "Покупка не завершена. Подробности записаны в консоль мастера.",
  SALE_FAILED: "Продажа не завершена. Подробности записаны в консоль мастера.",
  RESTOCK_FAILED: "Не удалось проверить автоматическое пополнение ассортимента."
});

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : null;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function errorCode(error, fallback = "PURCHASE_FAILED") {
  const code = String(error?.message ?? error ?? "");
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? code : fallback;
}

function failure(error, fallback = "PURCHASE_FAILED") {
  const code = errorCode(error, fallback);
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

async function withShopLock(shopId, operation) {
  const previous = shopLocks.get(shopId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  shopLocks.set(shopId, current);
  try {
    return await current;
  } finally {
    if (shopLocks.get(shopId) === current) shopLocks.delete(shopId);
  }
}

function safeUuidLabel(value) {
  return Compat.escapeHTML(String(value ?? ""))
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;");
}

function applyPrivacy(messageData, requester, privatePurchase) {
  if (!privatePurchase) return messageData;
  messageData.whisper = Array.from(new Set([
    ...(game.users?.contents ?? []).filter(user => user.isGM).map(user => user.id),
    requester?.id
  ].filter(Boolean)));
  return messageData;
}

async function createPurchaseReceipt({
  shop,
  actor,
  requester,
  sourceItem,
  purchasedItem,
  unitPrice,
  totalPrice,
  denomination,
  deduction,
  kind,
  quantity,
  privatePurchase
}) {
  if (!Compat.shouldPostChatReceipts()) return;
  try {
    const isService = kind === "service";
    const itemLink = !isService && purchasedItem?.uuid
      ? `@UUID[${purchasedItem.uuid}]{${safeUuidLabel(sourceItem.name)}}`
      : Compat.escapeHTML(sourceItem.name);
    const quantityText = quantity > 1 ? ` ×${quantity}` : "";
    const content = `
      <div class="sw-chat-receipt">
        <h3><i class="fa-solid ${isService ? "fa-bell-concierge" : "fa-basket-shopping"}"></i> ${isService ? "Оплата услуги" : "Покупка в магазине"}</h3>
        <p><strong>${Compat.escapeHTML(actor.name)}</strong> ${isService ? "оплачивает услугу" : "покупает"} ${itemLink}${quantityText} в «${Compat.escapeHTML(shop.name)}».</p>
        ${quantity > 1 ? `<p>Цена за единицу: <strong>${Compat.escapeHTML(Compat.formatPrice(unitPrice, denomination))}</strong>.</p>` : ""}
        <p>Итого: <strong>${Compat.escapeHTML(Compat.formatPrice(totalPrice, denomination))}</strong>.</p>
        <p>Списано: <strong>${Compat.escapeHTML(Compat.formatCurrencyBreakdown(deduction?.paid, "ничего"))}</strong>.</p>
        ${Object.keys(deduction?.change ?? {}).length
          ? `<p>Сдача: <strong>${Compat.escapeHTML(Compat.formatCurrencyBreakdown(deduction.change))}</strong>.</p>`
          : ""}
      </div>`;

    await ChatMessage.create(applyPrivacy({
      user: requester?.id ?? game.user.id,
      speaker: ChatMessage.getSpeaker({ actor }),
      content
    }, requester, privatePurchase));
  } catch (error) {
    console.warn(`${MODULE_ID} | Не удалось создать чек покупки в чате`, error);
  }
}

async function createSaleReceipt({
  shop,
  actor,
  requester,
  itemName,
  unitPrice,
  totalPrice,
  denomination,
  addition,
  quantity,
  privatePurchase
}) {
  if (!Compat.shouldPostChatReceipts()) return;
  try {
    const content = `
      <div class="sw-chat-receipt">
        <h3><i class="fa-solid fa-hand-holding-dollar"></i> Продажа магазину</h3>
        <p><strong>${Compat.escapeHTML(actor.name)}</strong> продаёт «${Compat.escapeHTML(itemName)}»${quantity > 1 ? ` ×${quantity}` : ""} магазину «${Compat.escapeHTML(shop.name)}».</p>
        ${quantity > 1 ? `<p>Цена за единицу: <strong>${Compat.escapeHTML(Compat.formatPrice(unitPrice, denomination))}</strong>.</p>` : ""}
        <p>Получено: <strong>${Compat.escapeHTML(Compat.formatPrice(totalPrice, denomination))}</strong> (${Compat.escapeHTML(Compat.formatCurrencyBreakdown(addition.received, "ничего"))}).</p>
      </div>`;

    await ChatMessage.create(applyPrivacy({
      user: requester?.id ?? game.user.id,
      speaker: ChatMessage.getSpeaker({ actor }),
      content
    }, requester, privatePurchase));
  } catch (error) {
    console.warn(`${MODULE_ID} | Не удалось создать чек продажи в чате`, error);
  }
}

async function executePurchase({
  requesterId,
  shopId,
  entryId,
  expectedUuid = null,
  shopRevision = null,
  actorUuid,
  quantity = 1,
  privatePurchase = false
}) {
  const requester = game.users.get(requesterId);
  if (!requester) throw new Error("REQUESTER_NOT_FOUND");
  const isPrivatePurchase = privatePurchase === true;
  const amount = positiveInteger(quantity);
  if (!amount) throw new Error("INVALID_QUANTITY");

  const actor = await Compat.fromUuid(actorUuid);
  if (!actor || actor.documentName !== "Actor") throw new Error("ACTOR_NOT_FOUND");
  if (!Compat.canPurchaseAs(actor, requester)) throw new Error("NOT_OWNER");

  const shop = ShopStore.get(shopId);
  if (!shop) throw new Error("SHOP_NOT_FOUND");
  if (shopRevision != null && shop.revision !== Number(shopRevision)) throw new Error("STORE_CONFLICT");

  const entryIndex = shop.items.findIndex(item => item.id === String(entryId ?? ""));
  const entry = shop.items[entryIndex];
  if (!entry) throw new Error("ITEM_NOT_FOUND");
  if (expectedUuid && entry.uuid !== String(expectedUuid)) throw new Error("STORE_CONFLICT");
  if (entry.quantity != null && entry.quantity < amount) throw new Error("SOLD_OUT");
  const kind = entry.kind === "service" ? "service" : "product";
  const isService = kind === "service";

  const sourceItem = await Compat.fromUuid(entry.uuid);
  if (!sourceItem || sourceItem.documentName !== "Item") throw new Error("SOURCE_ITEM_NOT_FOUND");

  const denomination = Compat.getItemCurrency(sourceItem);
  const unitPrice = Compat.calculateShopPrice(shop, entry, sourceItem);
  const totalPrice = roundMoney(unitPrice * amount);
  const deduction = Compat.getCurrencyDeduction(actor, totalPrice, denomination);
  const walletBefore = Compat.clone(shop.wallet);
  const walletBeforeCopper = shop.walletCopper;

  let currencyApplied = false;
  let itemReceipt = null;

  try {
    if (Object.keys(deduction.updates).length) {
      await actor.update(deduction.updates);
      currencyApplied = true;
    }

    if (!isService) itemReceipt = await Compat.addPurchasedItem(actor, sourceItem, amount);
    await ShopStore.applyPurchase(
      shopId,
      entry.id,
      amount,
      deduction.costCopper,
      denomination,
      { expectedShopRevision: shop.revision, expectedUuid: entry.uuid }
    );
  } catch (error) {
    console.error(`${MODULE_ID} | Ошибка покупки, выполняется откат`, error);

    try {
      if (itemReceipt) await Compat.rollbackPurchasedItem(itemReceipt);
    } catch (rollbackError) {
      console.error(`${MODULE_ID} | Не удалось откатить выданный предмет`, rollbackError);
    }

    try {
      if (currencyApplied) await actor.update(Compat.currencyRestoreUpdates(deduction.original));
    } catch (rollbackError) {
      console.error(`${MODULE_ID} | Не удалось вернуть валюту после ошибки`, rollbackError);
    }

    throw error;
  }

  const updatedShop = ShopStore.get(shopId);
  const updatedEntry = updatedShop?.items?.find(item => item.id === entry.id);
  const paymentText = Compat.formatCurrencyBreakdown(deduction.paid, "ничего");
  const changeText = Compat.formatCurrencyBreakdown(deduction.change, "без сдачи");
  const result = {
    ok: true,
    shopId,
    entryId: entry.id,
    buyerUuid: actor.uuid,
    buyerName: actor.name,
    itemName: sourceItem.name,
    kind,
    quantity: amount,
    unitPrice,
    totalPrice,
    denomination,
    priceText: Compat.formatPrice(totalPrice, denomination),
    unitPriceText: Compat.formatPrice(unitPrice, denomination),
    paymentText,
    changeText,
    privatePurchase: isPrivatePurchase,
    remaining: updatedEntry?.quantity ?? null,
    walletEnabled: updatedShop?.walletEnabled === true,
    walletChanged: updatedShop?.walletCopper !== walletBeforeCopper,
    walletBeforeCopper,
    walletAfterCopper: updatedShop?.walletCopper ?? walletBeforeCopper,
    walletBeforeText: Compat.formatWallet(walletBefore),
    walletAfterText: Compat.formatWallet(updatedShop?.wallet ?? walletBefore)
  };

  try {
    await ShopStore.appendHistory({
      timestamp: Date.now(),
      requesterId: requester.id,
      requesterName: requester.name,
      buyerUuid: actor.uuid,
      buyerName: actor.name,
      shopId: shop.id,
      shopName: shop.name,
      itemUuid: sourceItem.uuid,
      itemName: sourceItem.name,
      itemImage: sourceItem.img,
      transactionType: kind,
      privatePurchase: isPrivatePurchase,
      quantity: amount,
      unitPrice,
      totalPrice,
      price: totalPrice,
      denomination,
      priceText: result.priceText,
      paid: deduction.paid,
      paymentText,
      change: deduction.change,
      changeText,
      walletEnabled: result.walletEnabled,
      walletChanged: result.walletChanged,
      walletBeforeCopper: result.walletBeforeCopper,
      walletAfterCopper: result.walletAfterCopper,
      walletBeforeText: result.walletBeforeText,
      walletAfterText: result.walletAfterText
    });
  } catch (historyError) {
    console.warn(`${MODULE_ID} | Не удалось записать покупку в историю`, historyError);
  }

  await createPurchaseReceipt({
    shop,
    actor,
    requester,
    sourceItem,
    purchasedItem: itemReceipt?.item,
    unitPrice,
    totalPrice,
    denomination,
    deduction,
    kind,
    quantity: amount,
    privatePurchase: isPrivatePurchase
  });

  return result;
}

async function executeSale({ requesterId, shopId, actorUuid, actorItemId, quantity = 1, privatePurchase = false }) {
  const requester = game.users.get(requesterId);
  if (!requester) throw new Error("REQUESTER_NOT_FOUND");
  const isPrivatePurchase = privatePurchase === true;
  const amount = positiveInteger(quantity);
  if (!amount) throw new Error("INVALID_QUANTITY");

  const actor = await Compat.fromUuid(actorUuid);
  if (!actor || actor.documentName !== "Actor") throw new Error("ACTOR_NOT_FOUND");
  if (!Compat.canPurchaseAs(actor, requester)) throw new Error("NOT_OWNER");

  const shop = ShopStore.get(shopId);
  if (!shop) throw new Error("SHOP_NOT_FOUND");
  if (shop.salesEnabled === false) throw new Error("SALE_DISABLED");

  const item = actor.items?.get(actorItemId);
  if (!item || item.parent?.uuid !== actor.uuid) throw new Error("ACTOR_ITEM_NOT_FOUND");
  if (!Compat.canSellItem(item)) throw new Error("ITEM_NOT_SELLABLE");
  if (Compat.getItemQuantity(item) < amount) throw new Error("NOT_ENOUGH_ITEMS");

  const itemName = item.name;
  const itemImage = item.img;
  const denomination = Compat.getItemCurrency(item);
  const unitPrice = Compat.calculateSaleUnitPrice(shop, item);
  const totalPrice = roundMoney(unitPrice * amount);
  if (Compat.priceInCopper(totalPrice, denomination) <= 0) throw new Error("SALE_PRICE_ZERO");
  const addition = Compat.getCurrencyAddition(actor, totalPrice, denomination);
  const walletBefore = Compat.clone(shop.wallet);
  const walletBeforeCopper = shop.walletCopper;
  if (shop.walletEnabled && walletBeforeCopper < addition.totalCopper) throw new Error("MERCHANT_INSUFFICIENT_FUNDS");

  let sourceUuid = null;
  if (shop.restockSoldItems) {
    const candidate = Compat.getItemSourceUuid(item);
    const source = candidate ? await Compat.fromUuid(candidate) : null;
    const embeddedActorItem = source?.parent?.documentName === "Actor";
    if (source?.documentName === "Item" && !embeddedActorItem && candidate !== item.uuid) sourceUuid = candidate;
  }

  let itemReceipt = null;
  let currencyApplied = false;
  let updatedShop = null;

  try {
    itemReceipt = await Compat.removeSoldItem(item, amount);
    if (Object.keys(addition.updates).length) {
      await actor.update(addition.updates);
      currencyApplied = true;
    }
    updatedShop = await ShopStore.applySale(shopId, {
      sourceUuid,
      amount,
      costCopper: addition.totalCopper
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Ошибка продажи, выполняется откат`, error);

    try {
      if (currencyApplied) await actor.update(Compat.currencyRestoreUpdates(addition.original));
    } catch (rollbackError) {
      console.error(`${MODULE_ID} | Не удалось забрать ошибочно начисленную валюту`, rollbackError);
    }

    try {
      if (itemReceipt) await Compat.rollbackSoldItem(itemReceipt);
    } catch (rollbackError) {
      console.error(`${MODULE_ID} | Не удалось вернуть проданный предмет`, rollbackError);
    }

    throw error;
  }

  const receivedText = Compat.formatCurrencyBreakdown(addition.received, "ничего");
  const result = {
    ok: true,
    shopId,
    sellerUuid: actor.uuid,
    sellerName: actor.name,
    itemName,
    kind: "sale",
    quantity: amount,
    unitPrice,
    totalPrice,
    denomination,
    priceText: Compat.formatPrice(totalPrice, denomination),
    unitPriceText: Compat.formatPrice(unitPrice, denomination),
    received: addition.received,
    receivedText,
    privatePurchase: isPrivatePurchase,
    stockChanged: Boolean(sourceUuid),
    walletEnabled: updatedShop?.walletEnabled === true,
    walletChanged: updatedShop?.walletCopper !== walletBeforeCopper,
    walletBeforeCopper,
    walletAfterCopper: updatedShop?.walletCopper ?? walletBeforeCopper,
    walletBeforeText: Compat.formatWallet(walletBefore),
    walletAfterText: Compat.formatWallet(updatedShop?.wallet ?? walletBefore)
  };

  try {
    await ShopStore.appendHistory({
      timestamp: Date.now(),
      requesterId: requester.id,
      requesterName: requester.name,
      buyerUuid: actor.uuid,
      buyerName: actor.name,
      sellerUuid: actor.uuid,
      sellerName: actor.name,
      shopId: shop.id,
      shopName: shop.name,
      itemUuid: sourceUuid,
      itemName,
      itemImage,
      transactionType: "sale",
      privatePurchase: isPrivatePurchase,
      quantity: amount,
      unitPrice,
      totalPrice,
      price: totalPrice,
      denomination,
      priceText: result.priceText,
      received: addition.received,
      receivedText,
      restocked: Boolean(sourceUuid),
      walletEnabled: result.walletEnabled,
      walletChanged: result.walletChanged,
      walletBeforeCopper: result.walletBeforeCopper,
      walletAfterCopper: result.walletAfterCopper,
      walletBeforeText: result.walletBeforeText,
      walletAfterText: result.walletAfterText
    });
  } catch (historyError) {
    console.warn(`${MODULE_ID} | Не удалось записать продажу в историю`, historyError);
  }

  await createSaleReceipt({
    shop,
    actor,
    requester,
    itemName,
    unitPrice,
    totalPrice,
    denomination,
    addition,
    quantity: amount,
    privatePurchase: isPrivatePurchase
  });

  return result;
}

export class PurchaseService {
  static initialize() {
    game.socket.on(SOCKET_NAME, payload => this._onSocket(payload));
    console.log(`${MODULE_ID} | socket ready | ${SOCKET_NAME}`);
  }

  static async requestPurchase({
    shopId,
    entryId,
    expectedUuid = null,
    shopRevision = null,
    actorUuid,
    quantity = 1,
    privatePurchase = false
  }) {
    if (!actorUuid) return failure(new Error("ACTOR_NOT_FOUND"));
    return this._request({
      type: "purchase-request",
      shopId,
      entryId,
      expectedUuid,
      shopRevision,
      actorUuid,
      quantity,
      privatePurchase: privatePurchase === true
    }, "PURCHASE_FAILED");
  }

  static async requestSale({ shopId, actorUuid, actorItemId, quantity = 1, privatePurchase = false }) {
    if (!actorUuid) return failure(new Error("ACTOR_NOT_FOUND"), "SALE_FAILED");
    return this._request({
      type: "sale-request",
      shopId,
      actorUuid,
      actorItemId,
      quantity,
      privatePurchase: privatePurchase === true
    }, "SALE_FAILED");
  }

  static async requestRestock({ shopId }) {
    return this._request({
      type: "restock-request",
      shopId
    }, "RESTOCK_FAILED");
  }

  static async _request(payload, fallback) {
    if (game.user.isGM) {
      const localPayload = { ...payload, requesterId: game.user.id };
      const result = payload.type === "sale-request"
        ? await this._processSale(localPayload)
        : payload.type === "restock-request"
          ? await this._processRestock(localPayload)
          : await this._processPurchase(localPayload);
      if (result.ok && (payload.type === "purchase-request" || result.stockChanged || result.changed || result.walletChanged)) {
        await this._broadcastStockChanged(result.shopId);
      }
      return result;
    }

    const gm = Compat.getPrimaryActiveGM();
    if (!gm) return failure(new Error("NO_ACTIVE_GM"), fallback);

    const requestId = Compat.randomID();
    let signedPayload;
    try {
      signedPayload = await SocketAuth.sign({ ...payload, requestId });
    } catch (error) {
      console.error(`${MODULE_ID} | Не удалось подписать запрос операции`, error);
      return failure(new Error("SOCKET_AUTH_FAILED"), fallback);
    }

    return new Promise(resolve => {
      const timeout = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(failure(new Error("REQUEST_TIMEOUT"), fallback));
      }, REQUEST_TIMEOUT);

      pendingRequests.set(requestId, { resolve, timeout });
      game.socket.emit(SOCKET_NAME, signedPayload);
    });
  }

  static async _processPurchase(payload) {
    try {
      return await withShopLock(payload.shopId, () => executePurchase(payload));
    } catch (error) {
      console.error(`${MODULE_ID} | Покупка отклонена`, error);
      return failure(error, "PURCHASE_FAILED");
    }
  }

  static async _processSale(payload) {
    try {
      return await withShopLock(payload.shopId, () => executeSale(payload));
    } catch (error) {
      console.error(`${MODULE_ID} | Продажа отклонена`, error);
      return failure(error, "SALE_FAILED");
    }
  }

  static async _processRestock(payload) {
    try {
      return await withShopLock(payload.shopId, () => RestockService.applyDue(payload.shopId));
    } catch (error) {
      console.error(`${MODULE_ID} | Автоматическое пополнение отклонено`, error);
      return failure(error, "RESTOCK_FAILED");
    }
  }

  static async _onSocket(payload) {
    if (!payload || typeof payload !== "object") return;

    if (["purchase-result", "sale-result", "restock-result"].includes(payload.type)) {
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

    if (payload.type === "stock-changed") {
      const primaryGM = Compat.getPrimaryActiveGM();
      if (!primaryGM) return;
      const signer = await SocketAuth.verify(payload, { expectedSenderId: primaryGM.id });
      if (!signer) return;
      Hooks.callAll(`${MODULE_ID}.stockChanged`, payload.shopId);
      return;
    }

    if (!["purchase-request", "sale-request", "restock-request"].includes(payload.type) || !game.user.isGM) return;
    const primaryGM = Compat.getPrimaryActiveGM();
    if (!primaryGM || primaryGM.id !== game.user.id) return;

    const fallback = payload.type === "sale-request"
      ? "SALE_FAILED"
      : payload.type === "restock-request"
        ? "RESTOCK_FAILED"
        : "PURCHASE_FAILED";
    const requester = await SocketAuth.verify(payload);
    const result = !requester
      ? failure(new Error("SOCKET_AUTH_FAILED"), fallback)
      : requester.isGM
        ? failure(new Error("INVALID_REQUESTER"), fallback)
        : payload.type === "sale-request"
          ? await this._processSale({ ...payload, requesterId: requester.id })
          : payload.type === "restock-request"
            ? await this._processRestock({ ...payload, requesterId: requester.id })
            : await this._processPurchase({ ...payload, requesterId: requester.id });

    const recipientId = requester?.id ?? payload.senderId;
    if (recipientId) {
      const response = await SocketAuth.sign({
        type: payload.type === "sale-request"
          ? "sale-result"
          : payload.type === "restock-request"
            ? "restock-result"
            : "purchase-result",
        requestId: payload.requestId,
        recipientId,
        result
      });
      game.socket.emit(SOCKET_NAME, response);
    }

    if (result.ok && (payload.type === "purchase-request" || result.stockChanged || result.changed || result.walletChanged)) {
      await this._broadcastStockChanged(result.shopId);
    }
  }

  static async _broadcastStockChanged(shopId) {
    Hooks.callAll(`${MODULE_ID}.stockChanged`, shopId);
    const payload = await SocketAuth.sign({
      type: "stock-changed",
      requestId: Compat.randomID(),
      shopId
    });
    game.socket.emit(SOCKET_NAME, payload);
  }
}

