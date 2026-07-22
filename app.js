/* ============================================================
   CRM «Центр окон и дверей» — Application
   ============================================================ */

// ─── Серверный API: клиент + авторизация ─────────────────────
// Данные хранятся на нашем VPS и без авторизации не выдаются.
const SB = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

async function ensureAuthenticated() {
    const loginEl = document.getElementById('loginScreen');
    const { data: { session } } = await SB.auth.getSession();
    if (session) { if (loginEl) loginEl.style.display = 'none'; return true; }
    if (!loginEl) return false;

    loginEl.style.display = 'flex';
    return new Promise(resolve => {
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('loginUser').value.trim();
            const password = document.getElementById('loginPass').value;
            const errEl = document.getElementById('loginError');
            errEl.classList.remove('show');
            const btn = e.target.querySelector('button[type=submit]');
            const lbl = document.getElementById('loginBtnLabel');
            btn.disabled = true; if (lbl) lbl.textContent = 'Вход…';
            const { error } = await SB.auth.signInWithPassword({ email, password });
            btn.disabled = false; if (lbl) lbl.textContent = 'Войти';
            if (error) {
                errEl.textContent = 'Неверный email или пароль';
                errEl.classList.add('show');
                document.getElementById('loginPass').value = '';
            } else {
                loginEl.style.display = 'none';
                resolve(true);
            }
        });
    });
}

// Выход
window.logout = async function() {
    await SB.auth.signOut();
    location.reload();
};

// Логин: показать/скрыть пароль + «Забыли пароль?»
(function initLoginUI() {
    const eye = document.getElementById('loginEye');
    const pass = document.getElementById('loginPass');
    if (eye && pass) eye.addEventListener('click', () => {
        pass.type = pass.type === 'password' ? 'text' : 'password';
        eye.style.color = pass.type === 'text' ? '#2563EB' : '';
    });
    const forgot = document.getElementById('loginForgot');
    if (forgot) forgot.addEventListener('click', e => {
        e.preventDefault();
        const err = document.getElementById('loginError');
        if (err) { err.textContent = 'Сброс пароля — через администратора CRM.'; err.classList.add('show'); }
    });
})();

// §3.3 — Кнопка «Скачать бэкап»: выгрузка всех данных в JSON-файл
window.exportBackup = function() {
    const dump = {
        exported_at: new Date().toISOString(),
        source: 'Центр окон и дверей — CRM',
        clients, suppliers,
        orders: orders.map(o => ({ ...o })),
        transactions,
        salary_payments: salaryPayments,
        app_settings: Object.values(appSettings),
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crm-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    dbToast('Бэкап скачан', true);
};

// ─── Запись в серверную БД (persistence) ─────────────────────
// Модель: optimistic UI — локальные массивы обновляются сразу (мгновенный
// отклик), а в фоне пишем в БД. Ошибку показываем тостом, но UI не блокируем.
function dbToast(msg, ok) {
    let el = document.getElementById('dbToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'dbToast';
        el.className = 'db-toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'db-toast show ' + (ok ? 'ok' : 'err');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ok ? 1500 : 5000);
}
function dbErr(where, error) {
    if (error) { console.error(where, error); dbToast('Не сохранено: ' + where, false); }
}

// Универсальное обновление с ОПТИМИСТИЧНОЙ БЛОКИРОВКОЙ по version.
// localObj — объект в памяти (содержит id и version). Если version в БД не
// совпал (кто-то уже изменил строку) — конфликт, тихо не затираем.
async function sbUpdate(table, localObj, patch, label) {
    const { data, error } = await SB.from(table)
        .update(patch).eq('id', localObj.id).eq('version', localObj.version ?? 1)
        .select().maybeSingle();
    if (error) { dbErr(label, error); return false; }
    if (!data) { await handleConflict(table, localObj); return false; }
    localObj.version = data.version;
    localObj.updated_at = data.updated_at;
    return true;
}
// Конфликт версий: подтягиваем свежие данные и перерисовываем.
async function handleConflict(table, localObj) {
    const { data } = await SB.from(table).select().eq('id', localObj.id).maybeSingle();
    dbToast('Запись изменена другим пользователем — показана свежая версия', false);
    if (data) { Object.assign(localObj, data); rerenderActiveSection && rerenderActiveSection(); }
}

// ─── Очередь операций записи (переживает перезагрузку, ретраи) ──
// §2.5/2.6: несохранённые изменения не теряются при обрыве сети — копятся
// в localStorage и досылаются с нарастающей паузой (5с→15с→45с→2м→5м).
const OPS_KEY = 'sb_pending_ops_v1';
let opsQueue = [];
let opsProcessing = false;
try { opsQueue = JSON.parse(localStorage.getItem(OPS_KEY) || '[]'); } catch (e) { opsQueue = []; }
function saveOps() {
    try {
        // _orderRef — живая ссылка, не сериализуем (после reload не нужна)
        localStorage.setItem(OPS_KEY, JSON.stringify(opsQueue.map(({ _orderRef, _rowRef, ...op }) => op)));
    } catch (e) {}
}
function enqueueOp(op) { op.retries = 0; opsQueue.push(op); saveOps(); processOps(); }

// Сетевая/временная ошибка — ретраим; логическая (constraint/RLS) — нет.
function isNetworkError(err) {
    if (!err) return false;
    const code = err.code || '';
    if (/^(23|42|22|PGRST)/.test(code)) return false;    // constraint/RLS/тип — не ретраить
    return /fetch|network|timeout|failed|load|50[234]/i.test((err.message || '') + code);
}

// Выполнить операцию. Вернёт 'ok'|'drop'; при сетевой ошибке — throw (ретрай).
async function execOp(op) {
    if (op.t === 'insOrder') {
        const provisionalId = op.order.id;
        const { data, error } = await SB.rpc('create_order', { p_order: op.order, p_items: op.items || [] });
        if (error) {
            if (error.code === '23505') {           // коллизия id — перегенерируем и повторим
                op.order.id = nextLocalId(orders);
                if (op._orderRef) op._orderRef.id = op.order.id;
                throw error;
            }
            throw error;
        }
        if (data && data !== provisionalId) rebindOrderId(provisionalId, data, op._orderRef);
        return 'ok';
    }
    if (op.t === 'insTx' || op.t === 'insClient' || op.t === 'insSupplier') {
        const table = { insTx: 'transactions', insClient: 'clients', insSupplier: 'suppliers' }[op.t];
        const { data, error } = await SB.from(table).insert(op.row);
        if (error) throw error;
        const saved = Array.isArray(data) ? data[0] : data;
        if (saved && saved.id != null && saved.id !== op.row.id) {
            rebindLocalId(op.t, op.row.id, saved.id, op._rowRef);
            op.row.id = saved.id;
        }
        if (op.t === 'insTx' && op._rowRef) {
            op._rowRef._pending = false;
            const modalBody = document.getElementById('modalBody');
            if (modalBody?.dataset.orderDetail === String(op._rowRef.order_id)) {
                openOrderDetail(op._rowRef.order_id);
            }
            rerenderActiveSection();
        }
        return 'ok';
    }
    return 'drop';
}

async function processOps() {
    if (opsProcessing || !opsQueue.length) return;
    opsProcessing = true;
    while (opsQueue.length) {
        const op = opsQueue[0];
        try {
            await execOp(op);
            opsQueue.shift(); saveOps();
        } catch (e) {
            // Ошибки схемы/RLS/ограничений сами не исчезнут. Не удаляем такую
            // операцию из localStorage и не показываем ложное «Сохранено».
            if (!isNetworkError(e) && e.code !== '23505') {
                opsProcessing = false;
                console.error('Операция осталась в очереди:', op, e);
                dbToast(`Не сохранено — операция оставлена в очереди (${e.message || e.code || 'ошибка базы'})`, false);
                return;
            }
            op.retries = (op.retries || 0) + 1;
            if (op.retries > 8) {
                opsProcessing = false;
                saveOps();
                dbToast('Не сохранено — операция остаётся в очереди для повторной отправки', false);
                return;
            }
            const delay = Math.min(300000, 5000 * Math.pow(3, op.retries - 1));
            opsProcessing = false;
            dbToast(`Нет связи — повтор через ${Math.round(delay / 1000)}с (в очереди: ${opsQueue.length})`, false);
            setTimeout(processOps, delay);
            return;
        }
    }
    opsProcessing = false;
    dbToast('Сохранено', true);
}
window.addEventListener('online', processOps);   // сеть вернулась — досылаем

function sbInsertOrder(o) {
    const { items, ...row } = o;
    enqueueOp({ t: 'insOrder', order: row, items: (items || []).map(i => ({ ...i })), _orderRef: o });
}
function sbUpdateOrder(o, patch) { return sbUpdate('orders', o, patch, 'обновление заказа'); }
function sbUpdateClient(c, patch) { return sbUpdate('clients', c, patch, 'клиент'); }
function sbUpdateSupplier(s, patch) { return sbUpdate('suppliers', s, patch, 'поставщик'); }

// Форматирование телефона в вид +7 (XXX) XXX-XX-XX.
// Сам подставляет +7: если начали с 8 — меняем на 7; если ввели номер
// без кода страны (начинается с 9 и т.п.) — код 7 добавляется автоматически.
function formatPhoneRu(raw) {
    let d = (raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (d[0] === '8') d = '7' + d.slice(1);
    if (d[0] !== '7') d = '7' + d;          // ввели без кода страны → добавляем 7
    d = d.slice(0, 11);
    const n = d.slice(1);                    // до 10 цифр национального номера
    let out = '+7';
    if (n.length) out += ' (' + n.slice(0, 3);
    if (n.length >= 3) out += ')';
    if (n.length > 3) out += ' ' + n.slice(3, 6);
    if (n.length > 6) out += '-' + n.slice(6, 8);
    if (n.length > 8) out += '-' + n.slice(8, 10);
    return out;
}
async function sbReplaceItems(orderId, items) {
    const { error } = await SB.rpc('replace_order_items', { p_order_id: orderId, p_items: items || [] });
    dbErr('позиции заказа', error);
}
function sbInsertTransaction(t) { enqueueOp({ t: 'insTx', row: t, _rowRef: t }); }
function sbInsertClient(c) { enqueueOp({ t: 'insClient', row: c, _rowRef: c }); }
function sbInsertSupplier(s) { enqueueOp({ t: 'insSupplier', row: s, _rowRef: s }); }
function nextLocalId(arr) { return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1; }

// Сервер может заменить занятый локальный ID на следующий свободный. Обновляем
// объект в памяти и все ещё не отправленные зависимые операции.
function rebindLocalId(type, oldId, newId, rowRef) {
    if (rowRef) rowRef.id = newId;
    if (type === 'insClient') {
        const local = clients.find(x => x.id === oldId);
        if (local) local.id = newId;
        orders.forEach(o => { if (o.client_id === oldId) o.client_id = newId; });
        opsQueue.forEach(q => {
            if (q.t === 'insOrder' && q.order.client_id === oldId) q.order.client_id = newId;
            if (q.t === 'insTx' && q.row.entity_type === 'client' && q.row.entity_id === oldId) q.row.entity_id = newId;
        });
    } else if (type === 'insSupplier') {
        const local = suppliers.find(x => x.id === oldId);
        if (local) local.id = newId;
        orders.forEach(o => o.items.forEach(i => { if (i.supplier_id === oldId) i.supplier_id = newId; }));
        opsQueue.forEach(q => {
            if (q.t === 'insOrder') (q.items || []).forEach(i => { if (i.supplier_id === oldId) i.supplier_id = newId; });
            if (q.t === 'insTx' && q.row.entity_type === 'supplier' && q.row.entity_id === oldId) q.row.entity_id = newId;
        });
    } else if (type === 'insTx') {
        const local = transactions.find(x => x.id === oldId);
        if (local) local.id = newId;
    }
    saveOps();
}

function rebindOrderId(oldId, newId, orderRef) {
    if (orderRef) orderRef.id = newId;
    const local = orders.find(o => o.id === oldId);
    if (local) local.id = newId;
    transactions.forEach(t => { if (t.order_id === oldId) t.order_id = newId; });
    opsQueue.forEach(q => {
        if (q.t === 'insTx' && q.row.order_id === oldId) q.row.order_id = newId;
    });
    saveOps();
}
// Soft-delete: помечаем deleted_at (можно восстановить), физически не удаляем.
async function sbDeleteSupplier(s) {
    const ok = await sbUpdate('suppliers', s, { deleted_at: new Date().toISOString() }, 'удаление поставщика');
    if (ok) dbToast('Поставщик удалён', true);
}
async function sbDeleteOrder(o) {
    const { data, error } = await SB.rpc('delete_order', { p_order_id: o.id, p_version: o.version ?? 1 });
    if (error) { dbErr('удаление заказа', error); return false; }
    dbToast(`Заказ удалён вместе с платежами (${data?.transactions || 0})`, true);
    return true;
}


// Пайплайн статуса заказа (в порядке жизненного цикла)
const STATUS_LABELS = {
    new:                'Новый',
    request_sent:       'Заявка отправлена',
    reply_received:     'Ответ получен',
    awaiting_shipment:  'Ждёт отгрузки',
    shipped:            'Отгружен',
    to_warehouse:       'Доставка на склад',
    to_client:          'Доставка клиенту',
    delivered:          'Доставлен',
    closed:             'Закрыт',
};
// Старые значения статусов (в исторических заказах) — чтобы корректно отображались
const STATUS_COMPAT = {
    in_progress:           'В работе',
    ordered_from_supplier: 'Заказан у поставщика',
    received_at_warehouse: 'Получен на склад',
    delivering:            'Доставляется',
};
const statusLabel = s => STATUS_LABELS[s] || STATUS_COMPAT[s] || s || '—';

// Менеджер, который фактически оформил заказ. Это отдельное бизнес-поле:
// created_by/updated_by содержат техническую учётную запись CRM.
const ORDER_MANAGER_LABELS = {
    sasha: 'Саша',
    olya: 'Оля',
};
const orderManagerLabel = key => ORDER_MANAGER_LABELS[key] || 'Не указано';
const orderManagerOptions = (selected = '', includeBlank = true) =>
    `${includeBlank ? `<option value="" ${selected ? '' : 'selected'}>Не указано</option>` : '<option value="">Выберите сотрудника</option>'}` +
    Object.entries(ORDER_MANAGER_LABELS)
        .map(([key, label]) => `<option value="${key}" ${selected === key ? 'selected' : ''}>${label}</option>`)
        .join('');

let clients = [];

let suppliers = [];

const categories = [];

const products = [];

const warehouseStock = [];

let orders = [];

function calcOrder(o) {
    let totalPurchase = 0, totalSale = 0;
    o.items.forEach(i => {
        totalPurchase += i.purchase_price * i.quantity;
        totalSale += i.sale_price * i.quantity;
    });
    const margin = totalSale - totalPurchase;
    // Закрытые архивные заказы (settled) считаются полностью оплаченными —
    // и клиентом, и поставщику (без задолженностей).
    if (o.settled) {
        return { totalPurchase, totalSale, margin,
                 paidByClient: totalSale, paidToSupplier: totalPurchase,
                 clientDebt: 0, supplierDebt: 0 };
    }
    const txs = transactions.filter(t => t.order_id === o.id && !t._pending);
    const paidByClient = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const paidToSupplier = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    return { totalPurchase, totalSale, margin, paidByClient, paidToSupplier,
             clientDebt: totalSale - paidByClient, supplierDebt: totalPurchase - paidToSupplier };
}

let transactions = [];
let salaryPayments = [];

// Общие настройки CRM хранятся на сервере и одинаковы для обоих менеджеров.
let appSettings = {};

function appSettingValue(id, fallback) {
    const value = appSettings[id]?.value;
    return value && typeof value === 'object' ? value : fallback;
}

async function saveAppSetting(id, value, label) {
    const current = appSettings[id];
    if (current) {
        const ok = await sbUpdate('app_settings', current, { value }, label);
        if (!ok) return false;
        current.value = value;
        return true;
    }
    const { data, error } = await SB.from('app_settings').insert({ id, value });
    if (error) { dbErr(label, error); return false; }
    const saved = Array.isArray(data) ? data[0] : data;
    appSettings[id] = saved || { id, value, version: 1 };
    return true;
}


// ─── Utility ─────────────────────────────────────────────────

const fmt = n => new Intl.NumberFormat('ru-RU').format(Math.round(n));
const fmtCur = n => fmt(n) + ' ₽';   // неразрывный пробел — «₽» не съезжает на новую строку
const fmtCurExact = n => {
    const value = Number(n) || 0;
    const hasKopecks = Math.abs(value - Math.round(value)) >= 0.005;
    return new Intl.NumberFormat('ru-RU', {
        minimumFractionDigits: hasKopecks ? 2 : 0,
        maximumFractionDigits: 2,
    }).format(value) + ' ₽';
};
const htmlSafe = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmtDate = d => {
    if (!d) return '—';
    const parts = d.split('-');
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
};
const todayLocalDate = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Отображаемое имя клиента: имя, либо (если пусто) адрес, либо «Без имени».
// Так клиенты-«чистый адрес» видны как «Трубачева 42», а не прочерком.
const clientLabel = cl => (cl && ((cl.name || '').trim() || (cl.address || '').trim())) || 'Без имени';
const clientName = id => { const c = clients.find(x => x.id === id); return c ? clientLabel(c) : '—'; };
const clientPhone = id => (clients.find(c => c.id === id) || {}).phone || '';
const supplierName = id => (suppliers.find(s => s.id === id) || {}).name || '—';
const categoryName = id => (categories.find(c => c.id === id) || {}).name || '—';

// Стабильный CRM-ID заказа — «якорь» для сопоставления с письмами производства.
// Сейчас выводится из o.id; при двусторонней синхронизации станет постоянной
// колонкой в Google Таблице (см. INTEGRATION.md).
const crmId = o => o.crm_id || ('CRM-' + String(o.id).padStart(5, '0'));

// Слова, из-за которых название товара — на самом деле служебная заметка
// (доставка/оплата/дата/статус), а не продукция. Используется только для
// автодополнения при вводе позиций заказа — исторические записи не меняются.
const PRODUCT_NOISE_WORDS = new Set([
    'доставка','доставки','доставкой','доставку','оплачена','оплачено','оплачен',
    'оплаченный','отдать','вернуть','отправлено','остаток','забирать','приостановлен',
    'приостановлена','наличии','наличие','ждем','ждём','ждать','руб','рублей','рубль',
    'или','либо','штук','монтаж','заберет','заберёт','заберут','отдали','отдал','отдала',
    'отдано','выдать','выдали','пятница','суббота','воскресенье','понедельник','вторник',
    'среда','четверг','январь','февраль','март','апрель','май','июнь','июль','август',
    'сентябрь','октябрь','ноябрь','декабрь','привезли','привезти','заказ','заказа',
    'заказан','заказать','готов','готово','готовность','возврат','гот','подъем','подъём',
    'этаж','поступление','примерно','рассрочкой','рассрочка',
]);
function isJunkProductName(name) {
    const n = (name || '').trim();
    if (!n) return true;
    if (/^заказ\s+у\s/i.test(n)) return true;              // поставщик, попавший в поле товара
    if (/^[\d\s.,/?+-]+$/.test(n)) return true;             // голое число/дата/дробь
    const words = (n.toLowerCase().match(/[а-яёa-z]{3,}/g) || []);
    if (!words.length) return true;
    return words.every(w => PRODUCT_NOISE_WORDS.has(w));
}
// Названия, вручную скрытые владельцем (мусор, который не поймал фильтр).
// Загружаются из таблицы product_hidden; ключ — само название.
let hiddenProducts = new Set();
// Товары, добавленные владельцем вручную (могут ещё не встречаться в заказах).
// Из таблицы product_custom. customCatMap: название → выбранная владельцем категория.
let customProducts = new Set();
let customCatMap = new Map();

// Список названий продукции для автодополнения — без служебного шлака и скрытых,
// плюс добавленные вручную
function getProductNameSuggestions() {
    const orderNames = orders.flatMap(o => o.items.map(i => i.product_name)).filter(Boolean);
    const all = [...new Set([...orderNames, ...customProducts])];
    return all.filter(n => (customProducts.has(n) || !isJunkProductName(n)) && !hiddenProducts.has(n)).slice(0, 500);
}

// ─── Каталог продукции (раздел «Продукция») ──────────────────
// Категоризация по ключевым словам (для окон/дверей/стройматериалов)
const PRODUCT_CATEGORIES = [
    ['Утеплитель',   /вата|утеплит|минват|ветонит|роквул|карбон|пенопласт|изовер|тепло|пеноплэкс|пеноплекс|базальт|эковер|кнауф|технониколь|пеностекл/i],
    ['Плиты/ОСБ',    /осб|осп|осб9|осб12|фанер|изоплат|поликарбонат|дсп|двп|гипсокартон|гкл|цсп|лдсп|ламинат|плита|лист|мдф|osb/i],
    ['Крепёж',       /саморез|гвозд|дюбел|анкер|шуруп|шпильк|гайк|шайб|крепеж|креплен|пластин|подвес|хомут|скоб|болт|тоя|тоуа|нейлер|перчатк|клопы/i],
    ['Изоляция/плёнки', /изоспан|ондутис|геотекстил|мембран|пароизол|гидроизол|скотч|лент|плёнк|пленк|стеклоизол|битум|рубероид|паро|дельта|смарт|аргус\s*термо|изол/i],
    ['Кровля',       /профлист|металлочереп|черепиц|ондулин|шифер|конек|конёк|ендов|снежик|снежин|снегозад|капельник|отлив|водосток|профнастил|штиль|кровл|крыш|билтермо|планк|торцев/i],
    ['Окна/двери',   /окн|двер|форточк|подоконник|откос|штапик|ручк|петл|замок|фурнитур|м\/с|москит|сетк|штульп|полотн|короб|наличник|добор|стеклопакет|уплотнит|защёлк|защелк|завертк|доводчик|аргус|консул|стронг|перуджа|умбрия|лабиринт|коммунар|милан|ясень|сандал|орех|вертикаль|беленый|плиссе|жалюзи|роллет|снипснап/i],
    ['Пена/герметик', /пена|герметик|стиз|клей|монтажн|силикон/i],
    ['Сваи/фундамент', /свая|сваи|оголовок|огол|цемент|керамзит|кольц|септик|септобак|сэптик|фундамент|бетон|песок|щебен|гвл|дренаж/i],
    ['Профиль/металл', /профил|труб|столб|лаг|уголок|уголк|уголъ|металл|штакетник|арматур|проф\s*труб|хаб|хомут/i],
    ['Вентиляция/сауна', /вентил|евровент|канал|сауна|печ|дымоход|воздуховод/i],
    ['Услуги/прочее', /доставк|доставить|монтаж|замер|подъем|подъём|рассрочк|манипулятор|занос|самовывоз/i],
];
function productCategory(name) {
    if (customCatMap.has(name)) return customCatMap.get(name);   // выбранная владельцем вручную
    const n = (name || '').toLowerCase();
    for (const [label, re] of PRODUCT_CATEGORIES) if (re.test(n)) return label;
    return 'Разное';
}
// Все доступные категории (стандартные + добавленные владельцем)
function allProductCategories() {
    const base = PRODUCT_CATEGORIES.map(c => c[0]);
    const custom = [...customCatMap.values()].filter(Boolean);
    return [...new Set([...base, ...custom, 'Разное'])];
}

window.productCat = window.productCat || 'all';   // фильтр по категории
window.productSelected = window.productSelected || new Set();   // отмеченные галочками

// Обновить панель массового действия (показать/скрыть, счётчик)
function updateProductBulkBar() {
    const bar = document.getElementById('productBulkBar');
    const cnt = document.getElementById('productBulkCount');
    if (!bar) return;
    const n = window.productSelected.size;
    bar.style.display = n ? 'flex' : 'none';
    if (cnt) cnt.textContent = `Выбрано: ${n}`;
    const all = document.getElementById('productSelectAll');
    if (all) {
        const boxes = [...document.querySelectorAll('.prod-check')];
        all.checked = boxes.length > 0 && boxes.every(b => b.checked);
    }
}

function renderProductCatalog() {
    // все реальные названия (без авто-мусора и без уже скрытых) + счётчик использований
    const useCount = {};
    orders.forEach(o => o.items.forEach(i => {
        const nm = i.product_name;
        if (nm) useCount[nm] = (useCount[nm] || 0) + 1;
    }));
    let names = Object.keys(useCount).filter(n => !isJunkProductName(n));
    customProducts.forEach(n => { if (!(n in useCount)) names.push(n); });   // добавленные вручную (ещё без заказов)
    names = [...new Set(names)].filter(n => !hiddenProducts.has(n));

    // категория для каждого
    const withCat = names.map(n => ({ name: n, cat: productCategory(n), count: useCount[n] || 0 }));

    // Метрики
    document.getElementById('productsMetrics').innerHTML = `
        <div class="metric-card blue">
            <div class="metric-label">Всего названий</div>
            <div class="metric-value">${withCat.length}</div>
        </div>
        <div class="metric-card cyan">
            <div class="metric-label">Категорий</div>
            <div class="metric-value">${new Set(withCat.map(x => x.cat)).size}</div>
        </div>
    `;

    // Список категорий (вертикальный)
    const catCounts = {};
    withCat.forEach(x => { catCounts[x.cat] = (catCounts[x.cat] || 0) + 1; });
    const cats = Object.keys(catCounts).sort((a, b) => catCounts[b] - catCounts[a]);
    const tab = (val, label, cnt) =>
        `<button class="cat-item ${window.productCat === val ? 'active' : ''}" data-cat="${val}">
            <span class="cat-item-label">${label}</span><span class="cat-item-count">${cnt}</span></button>`;
    let tabsHtml = tab('all', 'Все', withCat.length);
    cats.forEach(c => { tabsHtml += tab(c, c, catCounts[c]); });
    const catBox = document.getElementById('productCats');
    catBox.innerHTML = tabsHtml;
    catBox.querySelectorAll('.cat-item').forEach(btn => {
        btn.addEventListener('click', () => { window.productCat = btn.dataset.cat; renderProductCatalog(); });
    });

    // Фильтр по категории и поиску
    const q = (document.getElementById('productSearch').value || '').trim().toLowerCase();
    let rows = withCat;
    if (window.productCat !== 'all') rows = rows.filter(x => x.cat === window.productCat);
    if (q) rows = rows.filter(x => x.name.toLowerCase().includes(q));
    rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    document.getElementById('productCatalogBody').innerHTML = rows.length ? rows.map(x => {
        const nAttr = x.name.replace(/"/g, '&quot;');
        return `
        <tr>
            <td data-label=""><input type="checkbox" class="prod-check" data-n="${nAttr}" ${window.productSelected.has(x.name) ? 'checked' : ''}></td>
            <td data-label="Название">${x.name.replace(/</g, '&lt;')}</td>
            <td data-label="Категория"><span class="cat-badge">${x.cat}</span></td>
            <td class="font-mono" data-label="В заказах">${x.count}</td>
            <td data-label="" class="row-actions">
                <button class="btn btn-sm btn-danger" title="Убрать из подсказок"
                    onclick="hideProductName(this.dataset.n)" data-n="${nAttr}">− Удалить</button>
            </td>
        </tr>`; }).join('') : '<tr><td colspan="5" class="empty-state">Ничего не найдено</td></tr>';

    // Чекбоксы строк → обновляем набор выбранных
    document.querySelectorAll('#productCatalogBody .prod-check').forEach(box => {
        box.addEventListener('change', () => {
            const nm = box.dataset.n;
            if (box.checked) window.productSelected.add(nm); else window.productSelected.delete(nm);
            updateProductBulkBar();
        });
    });
    updateProductBulkBar();
}

// Скрыть название из подсказок (не трогая исторические заказы)
window.hideProductName = async function(name) {
    if (!name) return;
    if (!confirm(`Убрать «${name}» из списка продукции?\n\nНазвание перестанет предлагаться при создании заказа. Сами заказы не меняются.`)) return;
    hiddenProducts.add(name);
    renderProductCatalog();
    const { error } = await SB.from('product_hidden').upsert({ name }, { onConflict: 'name' });
    if (error) { dbErr('скрытие товара', error); hiddenProducts.delete(name); renderProductCatalog(); return; }
    dbToast('Название убрано из подсказок', true);
};

// Добавить новый товар в каталог (появится в подсказках при создании заказа)
window.openAddProductForm = function() {
    const cats = allProductCategories();
    openModal('Новый товар', `
        <div class="form-group">
            <label>Название товара</label>
            <input type="text" id="newProductName" placeholder="Например: Ветровая планка коричневая" autocomplete="off">
        </div>
        <div class="form-group">
            <label>Категория</label>
            <div style="display:flex;gap:8px;align-items:center">
                <select id="newProductCat" style="flex:1" onchange="toggleNewCatInput()">
                    ${cats.map(c => `<option value="${c.replace(/"/g,'&quot;')}">${c}</option>`).join('')}
                    <option value="__new__">+ Новая категория…</option>
                </select>
            </div>
            <input type="text" id="newCatName" placeholder="Название новой категории" autocomplete="off"
                   style="display:none;margin-top:8px">
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
            <button class="btn btn-primary" onclick="saveNewProductName()">Добавить</button>
        </div>
    `);
    setTimeout(() => document.getElementById('newProductName').focus(), 50);
};
window.toggleNewCatInput = function() {
    const sel = document.getElementById('newProductCat');
    const inp = document.getElementById('newCatName');
    const isNew = sel.value === '__new__';
    inp.style.display = isNew ? '' : 'none';
    if (isNew) inp.focus();
};
window.saveNewProductName = async function() {
    const name = document.getElementById('newProductName').value.trim();
    if (!name) { alert('Укажите название товара'); return; }
    if (customProducts.has(name) || getProductNameSuggestions().includes(name)) {
        alert('Такой товар уже есть в списке'); return;
    }
    let category = document.getElementById('newProductCat').value;
    if (category === '__new__') {
        category = document.getElementById('newCatName').value.trim();
        if (!category) { alert('Впишите название новой категории'); return; }
    }
    customProducts.add(name);
    customCatMap.set(name, category);
    hiddenProducts.delete(name);           // если был скрыт — возвращаем
    window.productCat = category;          // сразу показываем нужную категорию
    closeModal();
    renderProductCatalog();
    const { error } = await SB.from('product_custom').upsert({ name, category }, { onConflict: 'name' });
    await SB.from('product_hidden').delete().eq('name', name);   // снять скрытие, если было
    if (error) { dbErr('добавление товара', error); customProducts.delete(name); customCatMap.delete(name); renderProductCatalog(); return; }
    dbToast('Товар добавлен', true);
};

// Массовое скрытие выбранных галочками названий
window.hideProductNames = async function(names) {
    if (!names || !names.length) return;
    if (!confirm(`Убрать ${names.length} назв. из списка продукции?\n\nОни перестанут предлагаться при создании заказа. Сами заказы НЕ меняются.`)) return;
    names.forEach(n => hiddenProducts.add(n));
    window.productSelected.clear();
    renderProductCatalog();
    const { error } = await SB.from('product_hidden').upsert(names.map(name => ({ name })), { onConflict: 'name' });
    if (error) { dbErr('скрытие товаров', error); names.forEach(n => hiddenProducts.delete(n)); renderProductCatalog(); return; }
    dbToast(`Убрано названий: ${names.length}`, true);
};

// Статусы заказа от производства (присылаются в письмах)
const PRODUCTION_STATUS_LABELS = {
    sent:       'Заявка отправлена',
    accepted:   'Принят в работу',
    in_progress:'В производстве',
    shipped:    'Отгружен',
    delivered:  'Доставлен',
};

function entityName(type, id) {
    if (type === 'client') return clientName(id);
    if (type === 'supplier') return supplierName(id);
    return '—';
}

function paymentBar(paid, total) {
    if (total <= 0) return '';
    const pct = Math.min(100, Math.round(paid / total * 100));
    const cls = pct >= 100 ? 'green' : pct >= 50 ? 'amber' : 'red';
    return `<div class="payment-bar">
        <div class="payment-track"><div class="payment-fill ${cls}" style="width:${pct}%"></div></div>
        <span class="payment-pct">${pct}%</span>
    </div>`;
}


// ─── Navigation ──────────────────────────────────────────────

const navItems = document.querySelectorAll('.nav-item');
const sections = document.querySelectorAll('.section');

function navigate(sectionId) {
    if (!document.getElementById('section-' + sectionId)) sectionId = 'delivery';
    navItems.forEach(n => n.classList.toggle('active', n.dataset.section === sectionId));
    sections.forEach(s => s.classList.toggle('active', s.id === 'section-' + sectionId));
    if (location.hash !== '#' + sectionId) location.hash = sectionId;
    renderSection(sectionId);
    closeSidebarMobile();
}
window.addEventListener('hashchange', () => {
    const id = location.hash.replace('#', '') || 'delivery';
    navigate(id);
});

navItems.forEach(n => n.addEventListener('click', e => {
    e.preventDefault();
    navigate(n.dataset.section);
}));

document.querySelectorAll('[data-section]').forEach(el => {
    if (!el.classList.contains('nav-item')) {
        el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.section); });
    }
});

document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
});
const _backdrop = document.getElementById('sidebarBackdrop');
if (_backdrop) _backdrop.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
});

// На телефоне: после выбора раздела прячем боковое меню
function closeSidebarMobile() {
    if (window.innerWidth <= 860) {
        document.getElementById('sidebar').classList.remove('open');
    }
}

function renderSection(id) {
    switch (id) {
        case 'delivery':   renderDelivery(); break;
        case 'orders':     renderOrders(); break;
        case 'clients':    renderClients(); break;
        case 'suppliers':  renderSuppliers(); break;
        case 'finances':   renderFinances(); break;
        case 'warehouse':  renderWarehouse(); break;
        case 'products':   renderProductCatalog(); break;
    }
}


// ─── Delivery ────────────────────────────────────────────────

function deliveryItemLines(order, className = '') {
    const items = order.items || [];
    if (!items.length) return '<span class="text-muted">Состав не указан</span>';
    const safe = value => String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return items.map(item => {
        const dimensions = item.dimensions ? ` · ${safe(item.dimensions)}` : '';
        const quantity = Number(item.quantity) || 0;
        return `<div class="delivery-item-line ${className}"><b>${safe(item.product_name || 'Без названия')}</b>${dimensions} · ${quantity} шт.</div>`;
    }).join('');
}

const deliveryPrintSelection = new Set();
const DELIVERY_ORDERS_PER_PAGE = 5;

function deliveryPrintSummary(count) {
    const pages = count ? Math.ceil(count / DELIVERY_ORDERS_PER_PAGE) : 0;
    return `Заказов: ${count} · Листов: ${pages}`;
}

function updateDeliveryPrintControls(rows) {
    const rowIds = rows.map(o => o.id);
    const available = new Set(rowIds);
    [...deliveryPrintSelection].forEach(id => {
        if (!available.has(id)) deliveryPrintSelection.delete(id);
    });
    const selectedCount = rowIds.filter(id => deliveryPrintSelection.has(id)).length;
    const selectAll = document.getElementById('deliverySelectAll');
    if (selectAll) {
        selectAll.checked = rowIds.length > 0 && selectedCount === rowIds.length;
        selectAll.indeterminate = selectedCount > 0 && selectedCount < rowIds.length;
        selectAll.disabled = rowIds.length === 0;
    }
    const selectedButton = document.getElementById('btnPrintSelectedDelivery');
    if (selectedButton) {
        selectedButton.disabled = selectedCount === 0;
        selectedButton.textContent = selectedCount > 0
            ? `Распечатать выбранные (${selectedCount})`
            : 'Распечатать выбранные';
    }
    const allButton = document.getElementById('btnPrintDelivery');
    if (allButton) allButton.disabled = rowIds.length === 0;
}

function renderDelivery() {
    const rows = orders
        .filter(o => o.delivery_status === 'manual')
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    const printDate = document.getElementById('deliveryPrintDate');
    if (printDate) printDate.textContent = new Date().toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
    const printCount = document.getElementById('deliveryPrintCount');
    if (printCount) printCount.textContent = deliveryPrintSummary(rows.length);
    updateDeliveryPrintControls(rows);

    document.getElementById('deliveryBody').innerHTML = rows.length ? rows.map(o => {
        const c = calcOrder(o);
        const client = clients.find(x => x.id === o.client_id) || {};
        const label = o.order_number || crmId(o);
        return `<tr data-order="${o.id}" style="cursor:pointer">
            <td class="delivery-select-col no-print" data-label="Выбрать">
                <input class="delivery-select-checkbox" type="checkbox" data-order-id="${o.id}"
                    aria-label="Выбрать заказ ${htmlSafe(label)} для печати"
                    ${deliveryPrintSelection.has(o.id) ? 'checked' : ''}>
            </td>
            <td class="td-bold" data-label="№ заказа">${htmlSafe(label)}</td>
            <td class="font-mono ${c.clientDebt > 0 ? 'text-red' : 'text-green'}" data-label="Осталось получить">${c.clientDebt > 0 ? fmtCur(c.clientDebt) : 'Оплачено'}</td>
            <td data-label="Телефон">${htmlSafe(client.phone || '—')}</td>
            <td data-label="Адрес">${htmlSafe(client.address || '—')}</td>
            <td data-label="" class="no-print row-actions delivery-actions">
                <button class="btn btn-sm btn-delivery-items" onclick="event.stopPropagation();openDeliveryComposition(${o.id})">Состав</button>
                <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();removeOrderFromDelivery(${o.id})">Убрать</button>
                <button class="btn btn-sm btn-success" onclick="event.stopPropagation();markOrderDelivered(${o.id})">Доставлен</button>
            </td>
        </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-state">Пока ни один заказ не добавлен в доставку</td></tr>';

    const printCards = document.getElementById('deliveryPrintCards');
    if (printCards) {
        printCards.innerHTML = rows.map(o => {
            const c = calcOrder(o);
            const client = clients.find(x => x.id === o.client_id) || {};
            const label = o.order_number || crmId(o);
            const remaining = c.clientDebt > 0 ? fmtCur(c.clientDebt) : 'Оплачено';
            return `<article class="delivery-print-card" data-order-id="${o.id}">
                <div class="delivery-print-card-head">
                    <div class="delivery-print-order-number">
                        <span>Заказ</span>
                        <strong>${htmlSafe(label)}</strong>
                    </div>
                    <div class="delivery-print-balance">
                        <span>Получить с клиента</span>
                        <strong>${htmlSafe(remaining)}</strong>
                    </div>
                </div>
                <div class="delivery-print-contacts">
                    <div class="delivery-print-client">
                        <span>Клиент</span>
                        <strong>${htmlSafe(client.name || '—')}</strong>
                    </div>
                    <div class="delivery-print-phone">
                        <span>Телефон</span>
                        <strong>${htmlSafe(client.phone || '—')}</strong>
                    </div>
                    <div class="delivery-print-address">
                        <span>Адрес доставки</span>
                        <strong>${htmlSafe(client.address || '—')}</strong>
                    </div>
                </div>
                <div class="delivery-print-composition">
                    <span>Состав заказа</span>
                    <div class="delivery-print-items">${deliveryItemLines(o, 'is-print-card')}</div>
                </div>
                <div class="delivery-print-confirmation">
                    <div class="delivery-print-date">
                        <span>Дата доставки</span>
                        <div class="delivery-print-field-line"></div>
                    </div>
                    <div class="delivery-print-signature">
                        <span>Подпись клиента</span>
                        <div class="delivery-print-field-line"></div>
                    </div>
                </div>
            </article>`;
        }).join('');
    }

    document.querySelectorAll('#deliveryBody tr[data-order]').forEach(tr => {
        tr.addEventListener('click', () => openOrderDetail(+tr.dataset.order));
    });
    document.querySelectorAll('.delivery-select-checkbox').forEach(checkbox => {
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', event => {
            const id = +event.target.dataset.orderId;
            if (event.target.checked) deliveryPrintSelection.add(id);
            else deliveryPrintSelection.delete(id);
            updateDeliveryPrintControls(rows);
        });
    });
}

window.openDeliveryComposition = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const c = calcOrder(o);
    const client = clients.find(x => x.id === o.client_id) || {};
    const label = o.order_number || crmId(o);
    const printedAt = new Date().toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });

    openModal('Состав заказа ' + label, `
        <div class="delivery-order-sheet" id="deliveryOrderSheet" data-order="${o.id}">
            <div class="delivery-sheet-heading">
                <div>
                    <h1>Лист доставки</h1>
                    <p>${printedAt}</p>
                </div>
                <div class="delivery-sheet-order">Заказ <b>${label}</b></div>
            </div>
            <div class="delivery-sheet-info">
                <div><span>Клиент</span><b>${client.name || '—'}</b></div>
                <div><span>Телефон</span><b>${client.phone || '—'}</b></div>
                <div><span>Осталось получить</span><b class="${c.clientDebt > 0 ? 'text-red' : 'text-green'}">${c.clientDebt > 0 ? fmtCur(c.clientDebt) : 'Оплачено'}</b></div>
                <div class="delivery-sheet-address"><span>Адрес</span><b>${client.address || '—'}</b></div>
            </div>
            <div class="detail-section-title">Состав заказа</div>
            <div class="delivery-sheet-items">${deliveryItemLines(o)}</div>
            <div class="delivery-sheet-confirmation">
                <div><span>Дата доставки</span><div></div></div>
                <div><span>Подпись клиента</span><div></div></div>
            </div>
            <div class="form-actions no-print">
                <button class="btn btn-outline" onclick="closeModal()">Закрыть</button>
                <button class="btn btn-primary" onclick="printDeliveryOrder(${o.id})">Распечатать этот заказ</button>
            </div>
        </div>
    `);
};

window.printDeliveryOrder = function(orderId) {
    const sheet = document.getElementById('deliveryOrderSheet');
    if (!sheet || +sheet.dataset.order !== orderId) return;
    document.body.classList.add('print-delivery-order');
    window.print();
};

window.addEventListener('afterprint', () => {
    document.body.classList.remove('print-delivery-order');
    document.querySelectorAll('.delivery-print-card').forEach(card => {
        card.classList.remove('print-excluded', 'print-page-break');
    });
    const count = orders.filter(o => o.delivery_status === 'manual').length;
    const printCount = document.getElementById('deliveryPrintCount');
    if (printCount) printCount.textContent = deliveryPrintSummary(count);
});

window.toggleOrderDelivery = async function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o || o.delivery_status === 'delivered' || o.status === 'delivered') return;
    const inDelivery = o.delivery_status === 'manual';
    const nextStatus = inDelivery ? null : 'manual';
    const ok = await sbUpdateOrder(o, { delivery_status: nextStatus });
    if (!ok) return;
    o.delivery_status = nextStatus;
    renderOrders();
    dbToast(inDelivery ? 'Заказ убран из доставки' : 'Заказ добавлен в доставку', true);
};

// Совместимость со страницами, которые могли остаться открытыми со старой версией.
window.moveOrderToDelivery = window.toggleOrderDelivery;

window.removeOrderFromDelivery = async function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const ok = await sbUpdateOrder(o, { delivery_status: null });
    if (!ok) return;
    o.delivery_status = null;
    deliveryPrintSelection.delete(orderId);
    renderDelivery();
    dbToast('Заказ убран из доставки', true);
};

window.markOrderDelivered = async function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o || o.delivery_status !== 'manual') return;
    const ok = await sbUpdateOrder(o, { delivery_status: 'delivered', status: 'delivered' });
    if (!ok) return;
    o.delivery_status = 'delivered';
    o.status = 'delivered';
    deliveryPrintSelection.delete(orderId);
    renderDelivery();
    dbToast('Заказ отмечен как доставленный', true);
};

window.printDeliverySheet = function(mode = 'all') {
    const rows = orders.filter(o => o.delivery_status === 'manual');
    const ids = mode === 'selected'
        ? new Set(rows.filter(o => deliveryPrintSelection.has(o.id)).map(o => o.id))
        : new Set(rows.map(o => o.id));
    if (!ids.size) return;
    const includedCards = [];
    document.querySelectorAll('.delivery-print-card').forEach(card => {
        const included = ids.has(+card.dataset.orderId);
        card.classList.toggle('print-excluded', !included);
        card.classList.remove('print-page-break');
        if (included) includedCards.push(card);
    });
    includedCards.forEach((card, index) => {
        const isPageEnd = (index + 1) % DELIVERY_ORDERS_PER_PAGE === 0;
        if (isPageEnd && index < includedCards.length - 1) card.classList.add('print-page-break');
    });
    const printCount = document.getElementById('deliveryPrintCount');
    if (printCount) printCount.textContent = deliveryPrintSummary(ids.size);
    window.print();
};


// ─── Orders ──────────────────────────────────────────────────

window.ordersPage = 1;
const ORDERS_PER_PAGE = 50;

const MONTH_NAMES_FULL = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
window.ordersMonth = window.ordersMonth || 'all';  // 'all' или 'YYYY-MM'

// Список месяцев сбоку от таблицы заказов (вертикально, по годам, сворачивается)
window.ordersMonthsOpen = (localStorage.getItem('orders_months_open') === '1');
function applyOrdersMonthsState() {
    const layout = document.getElementById('ordersLayout');
    const toggle = document.getElementById('ordersMonthsToggle');
    if (!layout) return;
    layout.classList.toggle('months-collapsed', !window.ordersMonthsOpen);
    if (toggle) {
        const cur = window.ordersMonth === 'all' ? 'Все' : (() => {
            const [y, mo] = (window.ordersMonth || '').split('-');
            return y ? `${MONTH_NAMES_FULL[+mo - 1]} ${y.slice(2)}` : 'Все';
        })();
        toggle.textContent = window.ordersMonthsOpen ? '📅 Скрыть месяцы' : `📅 Месяцы: ${cur}`;
    }
}
function renderMonthTabs() {
    const box = document.getElementById('orderMonths');
    if (!box) return;
    const months = [...new Set(orders.map(o => (o.created_at || '').slice(0, 7)).filter(Boolean))].sort().reverse();
    const item = (val, label, count) =>
        `<button class="cat-item ${window.ordersMonth === val ? 'active' : ''}" data-month="${val}">
            <span class="cat-item-label">${label}</span><span class="cat-item-count">${count}</span></button>`;
    let html = item('all', 'Все', orders.length);
    const byYear = {};
    months.forEach(m => { const y = m.slice(0, 4); (byYear[y] = byYear[y] || []).push(m); });
    Object.keys(byYear).sort().reverse().forEach(y => {
        const cntY = orders.filter(o => (o.created_at || '').startsWith(y)).length;
        html += `<div class="fin-year-head"><span>${y}</span><b>${cntY}</b></div>`;
        byYear[y].forEach(m => {
            const mo = +m.slice(5, 7);
            const cnt = orders.filter(o => (o.created_at || '').startsWith(m)).length;
            html += item(m, MONTH_NAMES_FULL[mo - 1], cnt);
        });
    });
    box.innerHTML = html;
    box.querySelectorAll('.cat-item').forEach(btn => {
        btn.addEventListener('click', () => {
            window.ordersMonth = btn.dataset.month;
            window.ordersPage = 1;
            renderOrders();
        });
    });
    applyOrdersMonthsState();
}

const ORDER_COLUMN_DEFAULTS = [
    { key: 'date',      label: 'Дата',       head: 'Дата' },
    { key: 'number',    label: '№ заказа',   head: '№ заказа' },
    { key: 'supplier',  label: 'Поставщик',  head: 'Поставщик' },
    { key: 'purchase',  label: 'Закупка',    head: 'Закупка' },
    { key: 'sale',      label: 'Продажа',    head: 'Продажа' },
    { key: 'received',  label: 'Получено',   head: 'Получено' },
    { key: 'remaining', label: 'Осталось',   head: 'Осталось' },
    { key: 'delivery',  label: 'Доставка',   head: 'Доставка' },
    { key: 'client',    label: 'Клиент',     head: 'Клиент' },
    { key: 'phone',     label: 'Телефон',    head: 'Телефон' },
    { key: 'actions',   label: 'Кнопка «Открыть»', head: '' },
];
const ORDER_COLUMN_MAP = Object.fromEntries(ORDER_COLUMN_DEFAULTS.map(c => [c.key, c]));

function getOrderColumnsConfig() {
    const fallback = { order: ORDER_COLUMN_DEFAULTS.map(c => c.key), hidden: [] };
    const saved = appSettingValue('orders_columns', fallback);
    const order = [];
    (Array.isArray(saved.order) ? saved.order : []).forEach(key => {
        if (ORDER_COLUMN_MAP[key] && !order.includes(key)) order.push(key);
    });
    ORDER_COLUMN_DEFAULTS.forEach(col => { if (!order.includes(col.key)) order.push(col.key); });
    const hidden = (Array.isArray(saved.hidden) ? saved.hidden : []).filter(key => ORDER_COLUMN_MAP[key]);
    return { order, hidden };
}

function orderColumnCell(key, o, c, supplierNames) {
    switch (key) {
        case 'date':
            return `<td class="col-date" data-label="Дата">${fmtDate(o.created_at)}</td>`;
        case 'number':
            return `<td class="col-number td-bold" data-label="№ заказа">${o.order_number
                ? o.order_number
                : `<span class="text-muted" style="font-weight:500" title="Номер от производства ещё не присвоен — показан наш CRM-ID">${crmId(o)}</span>`}</td>`;
        case 'supplier':
            return `<td class="col-supplier" data-label="Поставщик">${supplierNames}</td>`;
        case 'purchase':
            return `<td class="col-purchase font-mono text-right" data-label="Закупка">${fmtCur(c.totalPurchase)}</td>`;
        case 'sale':
            return `<td class="col-sale font-mono text-right" data-label="Продажа">${fmtCur(c.totalSale)}</td>`;
        case 'received':
            return `<td class="col-received font-mono text-right" data-label="Получено">${fmtCur(c.paidByClient)}</td>`;
        case 'remaining':
            return `<td class="col-remaining font-mono text-right ${c.clientDebt > 0 ? 'text-red' : ''}" data-label="Осталось">${c.clientDebt > 0 ? fmtCur(c.clientDebt) : '—'}</td>`;
        case 'delivery':
            if (o.delivery_status === 'delivered' || o.status === 'delivered') {
                return `<td class="col-delivery" data-label="Доставка">
                    <span class="delivery-state-delivered">✓ Доставлен</span>
                </td>`;
            }
            const inDelivery = o.delivery_status === 'manual';
            return `<td class="col-delivery" data-label="Доставка">
                <button class="btn btn-sm ${inDelivery ? 'btn-delivery-added' : 'btn-delivery'}"
                    aria-pressed="${inDelivery ? 'true' : 'false'}"
                    title="${inDelivery ? 'Убрать заказ из доставки' : 'Добавить заказ в доставку'}"
                    onclick="event.stopPropagation();toggleOrderDelivery(${o.id})">
                    ${inDelivery ? 'Убрать' : 'В доставку'}
                </button>
            </td>`;
        case 'client':
            return `<td class="col-client" data-label="Клиент">${clientName(o.client_id)}</td>`;
        case 'phone':
            return `<td class="col-phone" data-label="Телефон">${clientPhone(o.client_id) || '—'}</td>`;
        case 'actions':
            return `<td class="col-actions" data-label=""><button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openOrderDetail(${o.id})">Открыть</button></td>`;
        default:
            return '';
    }
}

let orderColumnsDraft = null;

function renderOrderColumnsEditor() {
    const box = document.getElementById('orderColumnsList');
    if (!box || !orderColumnsDraft) return;
    box.innerHTML = orderColumnsDraft.order.map((key, index) => {
        const col = ORDER_COLUMN_MAP[key];
        const visible = !orderColumnsDraft.hidden.includes(key);
        return `<div class="order-column-row">
            <label><input type="checkbox" ${visible ? 'checked' : ''} onchange="toggleOrderColumn('${key}',this.checked)"> <span>${col.label}</span></label>
            <div class="order-column-arrows">
                <button class="btn btn-sm btn-outline" ${index === 0 ? 'disabled' : ''} onclick="moveOrderColumn('${key}',-1)" title="Переместить выше">↑</button>
                <button class="btn btn-sm btn-outline" ${index === orderColumnsDraft.order.length - 1 ? 'disabled' : ''} onclick="moveOrderColumn('${key}',1)" title="Переместить ниже">↓</button>
            </div>
        </div>`;
    }).join('');
}

window.openOrderColumnsSettings = function() {
    const current = getOrderColumnsConfig();
    orderColumnsDraft = { order: [...current.order], hidden: [...current.hidden] };
    openModal('Столбцы заказов', `
        <p class="text-muted" style="margin:0 0 14px">Галочка показывает столбец, стрелки меняют его место. Настройка общая для всех пользователей CRM.</p>
        <div class="order-columns-list" id="orderColumnsList"></div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="resetOrderColumnsDraft()">Сбросить</button>
            <button class="btn btn-primary" onclick="saveOrderColumnsSettings()">Сохранить</button>
        </div>
    `);
    renderOrderColumnsEditor();
};

window.toggleOrderColumn = function(key, visible) {
    if (!orderColumnsDraft || !ORDER_COLUMN_MAP[key]) return;
    orderColumnsDraft.hidden = orderColumnsDraft.hidden.filter(x => x !== key);
    if (!visible) orderColumnsDraft.hidden.push(key);
};

window.moveOrderColumn = function(key, direction) {
    if (!orderColumnsDraft) return;
    const from = orderColumnsDraft.order.indexOf(key);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= orderColumnsDraft.order.length) return;
    [orderColumnsDraft.order[from], orderColumnsDraft.order[to]] = [orderColumnsDraft.order[to], orderColumnsDraft.order[from]];
    renderOrderColumnsEditor();
};

window.resetOrderColumnsDraft = function() {
    orderColumnsDraft = { order: ORDER_COLUMN_DEFAULTS.map(c => c.key), hidden: [] };
    renderOrderColumnsEditor();
};

window.saveOrderColumnsSettings = async function() {
    if (!orderColumnsDraft) return;
    if (orderColumnsDraft.hidden.length === orderColumnsDraft.order.length) {
        dbToast('Оставьте хотя бы один столбец', false);
        return;
    }
    const value = { order: [...orderColumnsDraft.order], hidden: [...orderColumnsDraft.hidden] };
    if (!await saveAppSetting('orders_columns', value, 'настройка столбцов')) return;
    closeModal();
    renderOrders();
    dbToast('Столбцы сохранены', true);
};

function renderOrders() {
    renderMonthTabs();
    const status = document.getElementById('filterStatus').value;
    const manager = document.getElementById('filterManager').value;
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo = document.getElementById('filterDateTo').value;
    const month = window.ordersMonth;

    let filtered = orders;
    if (month && month !== 'all') filtered = filtered.filter(o => (o.created_at || '').startsWith(month));
    if (status) filtered = filtered.filter(o => o.status === status);
    if (manager === 'unassigned') filtered = filtered.filter(o => !o.manager_key);
    else if (manager) filtered = filtered.filter(o => o.manager_key === manager);
    if (dateFrom) filtered = filtered.filter(o => o.created_at >= dateFrom);
    if (dateTo) filtered = filtered.filter(o => o.created_at <= dateTo);

    filtered = filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));

    const totalPages = Math.max(1, Math.ceil(filtered.length / ORDERS_PER_PAGE));
    if (window.ordersPage > totalPages) window.ordersPage = 1;
    const start = (window.ordersPage - 1) * ORDERS_PER_PAGE;
    const pageRows = filtered.slice(start, start + ORDERS_PER_PAGE);

    const columnConfig = getOrderColumnsConfig();
    const visibleColumns = columnConfig.order.filter(key => !columnConfig.hidden.includes(key));
    document.getElementById('ordersHead').innerHTML = visibleColumns.map(key => {
        const col = ORDER_COLUMN_MAP[key];
        return `<th class="col-${key}">${col.head}</th>`;
    }).join('');

    document.getElementById('ordersBody').innerHTML = pageRows.length ? pageRows.map(o => {
        const c = calcOrder(o);
        const supplierNames = [...new Set(o.items.map(i => i.supplier_id).filter(Boolean))].map(supplierName).join(', ') || '—';
        return `<tr data-order="${o.id}">${visibleColumns.map(key => orderColumnCell(key, o, c, supplierNames)).join('')}</tr>`;
    }).join('') : `<tr><td colspan="${visibleColumns.length}" class="empty-state">Нет заказов</td></tr>`;

    // Пагинация
    let pagBox = document.getElementById('ordersPagination');
    if (!pagBox) {
        pagBox = document.createElement('div');
        pagBox.id = 'ordersPagination';
        pagBox.className = 'pagination';
        document.getElementById('section-orders').appendChild(pagBox);
    }
    pagBox.innerHTML = `
        <div class="pagination-info">
            Показано ${start + 1}–${Math.min(start + ORDERS_PER_PAGE, filtered.length)} из ${filtered.length.toLocaleString('ru-RU')}
        </div>
        <div class="pagination-controls">
            <button class="btn btn-sm btn-outline" ${window.ordersPage === 1 ? 'disabled' : ''} onclick="window.ordersPage=1;renderOrders()">««</button>
            <button class="btn btn-sm btn-outline" ${window.ordersPage === 1 ? 'disabled' : ''} onclick="window.ordersPage--;renderOrders()">‹</button>
            <span class="pagination-page">Стр. ${window.ordersPage} из ${totalPages}</span>
            <button class="btn btn-sm btn-outline" ${window.ordersPage === totalPages ? 'disabled' : ''} onclick="window.ordersPage++;renderOrders()">›</button>
            <button class="btn btn-sm btn-outline" ${window.ordersPage === totalPages ? 'disabled' : ''} onclick="window.ordersPage=${totalPages};renderOrders()">»»</button>
        </div>
    `;

    document.querySelectorAll('#ordersBody tr[data-order]').forEach(tr => {
        tr.addEventListener('click', e => {
            openOrderDetail(+tr.dataset.order);
        });
    });
}
// Сбрасываем страницу при изменении фильтров
['filterStatus','filterManager','filterDateFrom','filterDateTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { window.ordersPage = 1; });
});

document.getElementById('filterStatus').addEventListener('change', renderOrders);
document.getElementById('filterManager').addEventListener('change', renderOrders);
document.getElementById('filterDateFrom').addEventListener('change', renderOrders);
document.getElementById('filterDateTo').addEventListener('change', renderOrders);
document.getElementById('btnPrintDelivery').addEventListener('click', () => printDeliverySheet('all'));
document.getElementById('btnPrintSelectedDelivery').addEventListener('click', () => printDeliverySheet('selected'));
document.getElementById('deliverySelectAll').addEventListener('change', event => {
    const rows = orders.filter(o => o.delivery_status === 'manual');
    if (event.target.checked) rows.forEach(o => deliveryPrintSelection.add(o.id));
    else rows.forEach(o => deliveryPrintSelection.delete(o.id));
    renderDelivery();
});
document.getElementById('ordersColumnsButton').addEventListener('click', openOrderColumnsSettings);


// ─── Order Detail Modal ──────────────────────────────────────

function openOrderDetail(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const c = calcOrder(o);
    const client = clients.find(x => x.id === o.client_id) || {};
    const supplierIds = [...new Set(o.items.map(i => i.supplier_id).filter(Boolean))];
    const clientPayments = transactions
        .filter(t => t.order_id === o.id && t.type === 'income')
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id || 0) - (a.id || 0));
    const productionHistory = o.status_history || [];
    const orderLabel = o.order_number || crmId(o);

    openModal('Заказ ' + orderLabel, `
        <div class="order-detail-compact">
        <div class="order-detail-columns">
            <div class="order-detail-main">
                <div class="order-summary-grid">
                    <div><span>CRM-ID</span><b>${crmId(o)}</b></div>
                    <div><span>№ производства</span><b class="${o.order_number ? '' : 'text-muted'}">${htmlSafe(o.order_number || 'не присвоен')}</b></div>
                    <div><span>Дата</span><b>${fmtDate(o.created_at)}</b></div>
                    <div><span>Клиент</span><b>${htmlSafe(client.name || '—')}</b></div>
                    <div><span>Телефон</span><b>${htmlSafe(client.phone || '—')}</b></div>
                    <div><span>Заказ оформил</span><b class="${o.manager_key ? '' : 'text-muted'}">${orderManagerLabel(o.manager_key)}</b></div>
                    <div class="order-summary-suppliers"><span>Поставщик(и)</span><b>${htmlSafe(supplierIds.map(supplierName).join(', ') || '—')}</b></div>
                </div>

                <div class="order-section-heading"><b>Товары</b><span>${o.items.length} поз.</span></div>
                <div class="order-items-scroll">
                    <table class="items-table order-items-compact">
                        <thead><tr><th>Наименование</th><th>Кол-во</th><th>Закупка</th><th>Продажа</th><th>Итого</th></tr></thead>
                        <tbody>${o.items.map(i => `
                            <tr>
                                <td>${htmlSafe(i.product_name)}${i.dimensions ? `<br><span class="text-muted">${htmlSafe(i.dimensions)}</span>` : ''}</td>
                                <td class="font-mono">${i.quantity}</td>
                                <td class="font-mono">${fmtCur(i.purchase_price)}</td>
                                <td class="font-mono">${fmtCur(i.sale_price)}</td>
                                <td class="font-mono td-bold">${fmtCur(i.sale_price * i.quantity)}</td>
                            </tr>`).join('')}
                            <tr class="order-items-total">
                                <td colspan="2">Итого</td>
                                <td class="font-mono">${fmtCur(c.totalPurchase)}</td>
                                <td></td>
                                <td class="font-mono">${fmtCur(c.totalSale)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div class="order-production-compact">
                    <div>
                        <span>Производство</span>
                        <b>${o.production_status ? `<span class="badge badge-in_progress">${PRODUCTION_STATUS_LABELS[o.production_status] || htmlSafe(o.production_status)}</span>` : '<span class="text-muted">нет данных</span>'}</b>
                    </div>
                    <button class="btn btn-sm btn-outline" onclick="openProductionRequest(${o.id})">Сформировать заявку</button>
                </div>
                ${productionHistory.length ? `
                <details class="production-history-compact">
                    <summary>История производства (${productionHistory.length})</summary>
                    ${productionHistory.map(h => `<div><span>${fmtDate(h.date)}</span><b>${PRODUCTION_STATUS_LABELS[h.status] || htmlSafe(h.status)}</b><small>${htmlSafe(h.source || '—')}</small></div>`).join('')}
                </details>` : ''}
            </div>

            <aside class="order-detail-finance">
                <div class="order-section-heading order-finance-heading"><b>Финансы</b></div>
                <div class="compact-finance-grid">
                    <div class="compact-finance-item"><span>Продажа</span><b>${fmtCur(c.totalSale)}</b></div>
                    <div class="compact-finance-item"><span>Закупка</span><b>${fmtCur(c.totalPurchase)}</b></div>
                    <div class="compact-finance-item ${c.clientDebt > 0 ? 'has-debt' : 'is-paid'}">
                        <span>Клиент внёс</span><b>${fmtCur(c.paidByClient)}</b>
                        <small>${c.clientDebt > 0 ? 'Осталось ' + fmtCur(c.clientDebt) : 'Оплачено полностью'}</small>
                    </div>
                    <div class="compact-finance-item ${c.supplierDebt > 0 ? 'has-debt' : 'is-paid'}">
                        <span>Поставщикам</span><b>${fmtCur(c.paidToSupplier)}</b>
                        <small>${c.supplierDebt > 0 ? 'Осталось ' + fmtCur(c.supplierDebt) : 'Оплачено полностью'}</small>
                    </div>
                </div>

                <div class="order-section-heading order-payments-heading"><b>Платежи клиента</b><span>${clientPayments.length}</span></div>
                <div class="order-client-payments">
                    ${clientPayments.length ? clientPayments.map(t => `
                        <div class="order-payment-row ${t._pending ? 'is-pending' : ''}">
                            <span>${fmtDate(t.date)}</span>
                            <div>${htmlSafe(t.description || 'Оплата от клиента')}${t._pending ? '<small>сохраняется…</small>' : ''}</div>
                            <b>${fmtCurExact(t.amount)}</b>
                        </div>`).join('') : '<div class="empty-state order-payment-empty">Платежей клиента пока нет</div>'}
                </div>

                <div class="order-section-heading order-add-payment-heading"><b>Добавить платёж</b></div>
                <div class="compact-payment-form order-payment-form">
                    <div class="form-group">
                        <label>Сумма ₽</label>
                        <input type="number" id="paymentAmount" placeholder="10 000" min="0" step="any">
                    </div>
                    <div class="form-group">
                        <label>Дата</label>
                        <input type="date" id="paymentDate" value="${todayLocalDate()}">
                    </div>
                    <div class="form-group">
                        <label>Тип</label>
                        <select id="paymentType" onchange="togglePaymentSupplier()">
                            <option value="income">От клиента</option>
                            <option value="expense">Поставщику</option>
                        </select>
                    </div>
                    <div class="form-group" id="paymentSupplierWrap" style="display:none">
                        <label>Поставщик</label>
                        <select id="paymentSupplier">${supplierIds.map(id => `<option value="${id}">${htmlSafe(supplierName(id))}</option>`).join('')}</select>
                    </div>
                    <div class="form-group compact-payment-desc">
                        <label>Описание</label>
                        <input type="text" id="paymentDesc" placeholder="Предоплата / остаток">
                    </div>
                    <button class="btn btn-primary" onclick="addPayment(${o.id})">Добавить платёж</button>
                </div>
            </aside>
        </div>

        <div class="form-actions order-detail-actions">
            <button class="btn btn-outline" onclick="openOrderEditForm(${o.id})">Редактировать</button>
            <button class="btn btn-danger" onclick="deleteOrder(${o.id})">Удалить заказ</button>
        </div>
        </div>
    `);
    const modalBody = document.getElementById('modalBody');
    modalBody.dataset.orderDetail = String(o.id);
    document.getElementById('modalOverlay').classList.add('order-detail-open');
}

// Редактирование существующего заказа: ФИО клиента, телефон, продукция, поставщик
window.openOrderEditForm = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const client = clients.find(x => x.id === o.client_id) || {};
    const productNames = getProductNameSuggestions();
    const supplierNames = [...new Set(suppliers.map(s => s.name))];
    const curSupplier = supplierName(o.items.find(i => i.supplier_id)?.supplier_id) || '';

    openModal('Редактирование заказа ' + o.order_number, `
        <datalist id="clientsList">${clients.map(c => `<option value="${c.name}">`).join('')}</datalist>
        <datalist id="productsList">${productNames.map(n => `<option value="${n.replace(/"/g,'&quot;')}">`).join('')}</datalist>
        <datalist id="suppliersList">${supplierNames.map(n => `<option value="${n}">`).join('')}</datalist>

        <div class="form-grid">
            <div class="form-group">
                <label>Клиент (ФИО)</label>
                <input type="text" id="editClientName" list="clientsList" value="${(client.name||'').replace(/"/g,'&quot;')}" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Телефон</label>
                <input type="text" id="editClientPhone" class="phone-input" value="${(client.phone||'').replace(/"/g,'&quot;')}" placeholder="+7 (___) ___-__-__">
                <div id="editClientMatch" class="client-match-hint"></div>
            </div>
            <div class="form-group">
                <label>Дата создания</label>
                <input type="date" id="editCreatedDate" value="${o.created_at || ''}">
            </div>
            <div class="form-group">
                <label>Дата доставки</label>
                <input type="date" id="editDeliveryDate" value="${o.delivery_date || ''}">
            </div>
            <div class="form-group">
                <label>Заказ оформил</label>
                <select id="editManagerKey">${orderManagerOptions(o.manager_key)}</select>
            </div>
        </div>

        <div class="detail-section-title">Продукция</div>
        <div id="editItemsContainer">
            ${o.items.map(i => orderItemRowHTML(i)).join('')}
        </div>
        <button class="btn btn-sm btn-outline" onclick="document.getElementById('editItemsContainer').insertAdjacentHTML('beforeend', orderItemRowHTML())" style="margin-top:4px">+ Добавить позицию</button>

        <div class="form-grid" style="margin-top:16px">
            <div class="form-group">
                <label>Номер от производства <span class="text-muted" style="font-weight:400">(из ответа производства)</span></label>
                <input type="text" id="editOrderNumber" value="${(o.order_number||'').replace(/"/g,'&quot;')}" placeholder="Впишите номер, который прислало производство" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Поставщик</label>
                <input type="text" id="editSupplier" list="suppliersList" value="${curSupplier.replace(/"/g,'&quot;')}" autocomplete="off">
            </div>
            <div class="form-group full">
                <label>Примечание</label>
                <input type="text" id="editNotes" value="${(o.notes||'').replace(/"/g,'&quot;')}">
            </div>
        </div>

        <div class="form-actions">
            <button class="btn btn-outline" onclick="openOrderDetail(${o.id})">Отмена</button>
            <button class="btn btn-primary" onclick="saveOrderEdit(${o.id})">Сохранить</button>
        </div>
    `);
};

window.saveOrderEdit = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const name = document.getElementById('editClientName').value.trim();
    const phone = document.getElementById('editClientPhone').value.trim();
    if (!name) { alert('Укажите ФИО клиента'); return; }

    const supplierId = findOrCreateSupplier(document.getElementById('editSupplier').value.trim());

    const items = [];
    document.querySelectorAll('#editItemsContainer .order-item-row').forEach(row => {
        const pname = row.querySelector('.item-name').value.trim();
        if (!pname) return;
        const dims = row.querySelector('.item-dimensions')?.value.trim() || '';
        items.push({
            product_name: pname,
            dimensions: dims,
            supplier_id: supplierId,
            quantity: parseFloat(row.querySelector('.item-qty').value) || 1,
            purchase_price: parseFloat(row.querySelector('.item-purchase').value) || 0,
            sale_price: parseFloat(row.querySelector('.item-sale').value) || 0,
        });
    });
    if (!items.length) { alert('Добавьте хотя бы одну позицию'); return; }

    o.client_id = findOrCreateClient(name, phone);
    // обновим телефон клиента, если изменили
    const cl = clients.find(c => c.id === o.client_id);
    if (cl && phone) { cl.phone = phone; sbUpdateClient(cl, { phone }); }
    o.items = items;
    o.created_at = document.getElementById('editCreatedDate').value || o.created_at;
    o.delivery_date = document.getElementById('editDeliveryDate').value || null;
    o.manager_key = document.getElementById('editManagerKey').value || null;
    o.notes = document.getElementById('editNotes').value.trim();
    o.order_number = document.getElementById('editOrderNumber').value.trim();

    // Сохраняем изменения заказа и его позиции в серверную БД
    sbUpdateOrder(o, {
        client_id: o.client_id, created_at: o.created_at, order_number: o.order_number,
        delivery_date: o.delivery_date, manager_key: o.manager_key, notes: o.notes,
    });
    sbReplaceItems(o.id, items);

    openOrderDetail(o.id);
    // обновим таблицу под модалкой
    const active = document.querySelector('.nav-item.active');
    if (active) renderSection(active.dataset.section);
};

// Удаление ошибочного заказа вместе со всеми его позициями и платежами.
window.deleteOrder = async function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const relatedPayments = transactions.filter(t => t.order_id === orderId).length;
    const label = o.order_number || crmId(o);
    if (!confirm(`Удалить заказ ${label}?\n\nБудут также удалены все позиции и связанные платежи: ${relatedPayments}.`)) return;
    const ok = await sbDeleteOrder(o);
    if (!ok) return;
    const idx = orders.findIndex(x => x.id === orderId);
    if (idx !== -1) orders.splice(idx, 1);
    transactions = transactions.filter(t => t.order_id !== orderId);
    closeModal();
    navigate('orders');
};

window.changeOrderStatus = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const sel = document.getElementById('modalStatusSelect');
    if (sel) { o.status = sel.value; sbUpdateOrder(o, { status: o.status }); }
    closeModal();
    renderSection(document.querySelector('.nav-item.active').dataset.section);
};

// Перерисовать активную секцию (после любого изменения данных).
// Используется чтобы все разделы синхронно отражали новые заказы/платежи.
function rerenderActiveSection() {
    const active = document.querySelector('.nav-item.active');
    if (active) renderSection(active.dataset.section);
}

function paymentRemaining(order, type, supplierId = null) {
    if (type === 'income') return calcOrder(order).clientDebt;
    const purchase = order.items.filter(i => i.supplier_id === supplierId)
        .reduce((sum, i) => sum + i.purchase_price * i.quantity, 0);
    const paid = transactions.filter(t => !t._pending && t.order_id === order.id &&
        t.type === 'expense' && t.entity_id === supplierId).reduce((sum, t) => sum + t.amount, 0);
    return purchase - paid;
}

// Добавить платёж (от клиента или поставщику) к заказу
window.addPayment = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const amount = parseFloat(document.getElementById('paymentAmount').value);
    if (!amount || amount <= 0) { alert('Укажите сумму платежа'); return; }
    const paymentDate = document.getElementById('paymentDate')?.value || todayLocalDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) { alert('Укажите дату платежа'); return; }
    const type = document.getElementById('paymentType').value;
    const desc = document.getElementById('paymentDesc').value.trim() || (type === 'income' ? 'Оплата от клиента' : 'Оплата поставщику');
    const supplierId = type === 'expense' ? +document.getElementById('paymentSupplier')?.value : null;
    if (type === 'expense' && !supplierId) { alert('В заказе не указан поставщик'); return; }

    const remaining = paymentRemaining(o, type, supplierId);
    if (amount > remaining + 0.0001) {
        alert(`Сумма больше остатка к оплате (${fmtCur(Math.max(0, remaining))})`);
        return;
    }

    const newId = transactions.length ? Math.max(...transactions.map(t => t.id)) + 1 : 1;
    const tx = {
        id: newId,
        date: paymentDate,
        type: type,
        entity_type: type === 'income' ? 'client' : 'supplier',
        entity_id: type === 'income' ? o.client_id : (supplierId || o.client_id),
        order_id: o.id,
        amount: amount,
        description: desc,
        idempotency_key: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
        _pending: true,
    };
    transactions.push(tx);
    sbInsertTransaction(tx);        // сохраняем платёж в серверную БД
    // Обновляем компактный финансовый блок в карточке и активный раздел под ним.
    openOrderDetail(o.id);
    rerenderActiveSection();
};

window.togglePaymentSupplier = function() {
    const type = document.getElementById('paymentType')?.value;
    const wrap = document.getElementById('paymentSupplierWrap');
    if (wrap) wrap.style.display = type === 'expense' ? '' : 'none';
};

// ─── Заявка на производство ──────────────────────────────────
// Формирует текст письма с CRM-ID в теме и теле. CRM-ID — «якорь»,
// по которому n8n потом сопоставит ответ производства (см. INTEGRATION.md).

function buildProductionEmail(o) {
    const id = crmId(o);
    const firstProduct = o.items[0]?.product_name || 'Заказ';
    const subject = `Заявка ${id} — ${firstProduct}`;

    const lines = o.items.map((i, n) => {
        const dims = i.dimensions ? ` | размеры: ${i.dimensions}` : '';
        return `  ${n + 1}. ${i.product_name}${dims} | кол-во: ${i.quantity}`;
    }).join('\n');

    const body =
`Здравствуйте!

Просим принять в работу заказ.

Идентификатор заказа: ${id}
Дата: ${fmtDate(o.created_at)}

Состав заказа:
${lines}
${o.notes ? `\nПримечание: ${o.notes}` : ''}

Просьба в ответном письме указать ваш внутренний номер заказа
и сохранить идентификатор ${id} в теме для автоматического учёта.

С уважением,
Центр окон и дверей`;

    return { subject, body, id };
}

window.openProductionRequest = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const { subject, body, id } = buildProductionEmail(o);

    openModal('Заявка на производство — ' + id, `
        <p class="text-muted" style="font-size:13px;margin-bottom:14px">
            Идентификатор <b>${id}</b> вшит в тему и тело письма. По нему CRM
            автоматически сопоставит ответ производства и обновит статус
            (когда будет подключена почта).
        </p>
        <div class="form-group" style="margin-bottom:12px">
            <label>Тема письма</label>
            <input type="text" id="prodSubject" value="${subject.replace(/"/g, '&quot;')}" readonly>
        </div>
        <div class="form-group">
            <label>Текст письма</label>
            <textarea id="prodBody" rows="14" readonly style="font-family:inherit;line-height:1.5">${body}</textarea>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="copyProductionEmail()">Скопировать текст</button>
            <button class="btn btn-primary" onclick="openMailClient(${o.id})">Открыть в почте</button>
        </div>
    `);
};

window.copyProductionEmail = function() {
    const subj = document.getElementById('prodSubject').value;
    const body = document.getElementById('prodBody').value;
    const text = 'Тема: ' + subj + '\n\n' + body;
    navigator.clipboard.writeText(text).then(
        () => { const btn = event.target; const t = btn.textContent; btn.textContent = 'Скопировано'; setTimeout(() => btn.textContent = t, 1500); },
        () => alert('Не удалось скопировать — выделите текст вручную')
    );
};

window.openMailClient = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const { subject, body } = buildProductionEmail(o);
    // mailto без указания адреса — менеджер сам выберет производство;
    // позже адрес можно зашить или хранить у поставщика
    const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = url;
};


// ─── Clients ─────────────────────────────────────────────────

function renderClients() {
    const rows = clients.map(cl => {
        const cOrders = orders.filter(o => o.client_id === cl.id);
        const totalPurchases = cOrders.reduce((s, o) => s + calcOrder(o).totalSale, 0);
        const totalDebt = cOrders.reduce((s, o) => s + Math.max(0, calcOrder(o).clientDebt), 0);
        return { ...cl, orderCount: cOrders.length, totalPurchases, totalDebt };
    });

    document.getElementById('clientsBody').innerHTML = rows.map(cl => `
        <tr data-client="${cl.id}">
            <td class="td-bold" data-label="Имя">${clientLabel(cl)}${(cl.name || '').trim() ? '' : ' <span class="need-name">нет имени</span>'}</td>
            <td data-label="Телефон">${cl.phone || '<span class="need-name">нет</span>'}</td>
            <td class="font-mono" data-label="Заказов">${cl.orderCount}</td>
            <td class="font-mono text-right" data-label="Сумма покупок">${fmtCur(cl.totalPurchases)}</td>
            <td class="font-mono text-right ${cl.totalDebt > 0 ? 'text-red' : ''}" data-label="Задолженность">${cl.totalDebt > 0 ? fmtCur(cl.totalDebt) : '—'}</td>
            <td data-label=""><button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openClientDetail(${cl.id})">Карточка</button></td>
        </tr>`).join('');

    document.querySelectorAll('#clientsBody tr[data-client]').forEach(tr => {
        tr.addEventListener('click', () => openClientDetail(+tr.dataset.client));
    });
}

window.openClientDetail = function(clientId) {
    const cl = clients.find(x => x.id === clientId);
    if (!cl) return;
    const cOrders = orders.filter(o => o.client_id === cl.id)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));   // новые сверху
    const totalPurchases = cOrders.reduce((s, o) => s + calcOrder(o).totalSale, 0);
    const totalDebt = cOrders.reduce((s, o) => s + Math.max(0, calcOrder(o).clientDebt), 0);

    openModal('Клиент: ' + clientLabel(cl), `
        <div class="detail-grid">
            <div class="detail-item">
                <div class="detail-label">Имя</div>
                <div class="detail-value">${(cl.name || '').trim() || '<span class="need-name">не указано</span>'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Телефон</div>
                <div class="detail-value">${cl.phone || '<span class="need-name">не указан</span>'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Адрес</div>
                <div class="detail-value">${cl.address || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Email</div>
                <div class="detail-value">${cl.email || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Заказов</div>
                <div class="detail-value big">${cOrders.length}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Задолженность</div>
                <div class="detail-value big ${totalDebt > 0 ? 'text-red' : 'text-green'}">${totalDebt > 0 ? fmtCur(totalDebt) : 'Нет'}</div>
            </div>
        </div>
        <div class="form-actions" style="margin-top:12px">
            <button class="btn btn-primary" onclick="openClientEditForm(${cl.id})">Редактировать</button>
        </div>
        <div class="detail-section-title">История заказов</div>
        <table class="items-table">
            <thead><tr><th>№</th><th>Дата</th><th>Сумма</th><th>Оплачено</th><th>Статус</th></tr></thead>
            <tbody>${cOrders.length ? cOrders.map(o => {
                const oc = calcOrder(o);
                return `<tr style="cursor:pointer" onclick="openOrderDetail(${o.id})">
                    <td class="td-bold">${o.order_number}</td>
                    <td>${fmtDate(o.created_at)}</td>
                    <td class="font-mono">${fmtCur(oc.totalSale)}</td>
                    <td class="font-mono">${fmtCur(oc.paidByClient)}</td>
                    <td><span class="badge badge-${o.status}">${statusLabel(o.status)}</span></td>
                </tr>`;
            }).join('') : '<tr><td colspan="5" class="empty-state">Нет заказов</td></tr>'}</tbody>
        </table>
    `);
};

// Редактирование карточки клиента: имя, телефон, адрес, email
window.openClientEditForm = function(clientId) {
    const cl = clients.find(x => x.id === clientId);
    if (!cl) return;
    const esc = v => (v || '').replace(/"/g, '&quot;');
    openModal('Редактирование клиента', `
        <div class="form-grid">
            <div class="form-group full">
                <label>Имя (ФИО)</label>
                <input type="text" id="editCliName" value="${esc(cl.name)}" placeholder="Фамилия Имя Отчество" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Телефон</label>
                <input type="text" id="editCliPhone" class="phone-input" value="${esc(cl.phone)}" placeholder="+7 (___) ___-__-__">
            </div>
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="editCliEmail" value="${esc(cl.email)}" placeholder="mail@example.com">
            </div>
            <div class="form-group full">
                <label>Адрес</label>
                <input type="text" id="editCliAddress" class="addr-suggest" value="${esc(cl.address)}" placeholder="Начните вводить адрес…" autocomplete="off">
            </div>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="openClientDetail(${cl.id})">Отмена</button>
            <button class="btn btn-primary" onclick="saveClientEdit(${cl.id})">Сохранить</button>
        </div>
    `);
};
window.saveClientEdit = function(clientId) {
    const cl = clients.find(x => x.id === clientId);
    if (!cl) return;
    const addrEl = document.getElementById('editCliAddress');
    const patch = {
        name: document.getElementById('editCliName').value.trim(),
        phone: document.getElementById('editCliPhone').value.trim(),
        email: document.getElementById('editCliEmail').value.trim(),
        address: addrEl.value.trim(),
    };
    const ad = addrDataFrom(addrEl);
    if (ad) patch.address_data = ad;      // структура из DaData (если выбрали из подсказок)
    Object.assign(cl, patch);
    sbUpdateClient(cl, patch);
    openClientDetail(cl.id);
    const active = document.querySelector('.nav-item.active');
    if (active) renderSection(active.dataset.section);
};

// Создание нового клиента (кнопка «+ Новый клиент» в разделе «Клиенты»)
window.openNewClientForm = function() {
    openModal('Новый клиент', `
        <div class="form-grid">
            <div class="form-group full">
                <label>Имя (ФИО)</label>
                <input type="text" id="newCliName" placeholder="Фамилия Имя Отчество" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Телефон</label>
                <input type="text" id="newCliPhone" class="phone-input" placeholder="+7 (___) ___-__-__">
            </div>
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="newCliEmail" placeholder="mail@example.com">
            </div>
            <div class="form-group full">
                <label>Адрес</label>
                <input type="text" id="newCliAddress" class="addr-suggest" placeholder="Начните вводить адрес…" autocomplete="off">
            </div>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
            <button class="btn btn-primary" onclick="saveNewClient()">Создать</button>
        </div>
    `);
    setTimeout(() => document.getElementById('newCliName').focus(), 50);
};
window.saveNewClient = function() {
    const name = document.getElementById('newCliName').value.trim();
    const phone = document.getElementById('newCliPhone').value.trim();
    const addrEl = document.getElementById('newCliAddress');
    const address = addrEl.value.trim();
    const email = document.getElementById('newCliEmail').value.trim();
    if (!name && !phone && !address) { alert('Укажите хотя бы имя, телефон или адрес'); return; }
    // если такой телефон уже есть — не плодим дубль
    const existing = phone ? findClientByPhone(phone) : null;
    if (existing) {
        alert(`Клиент с этим номером уже есть: ${clientLabel(existing)}`);
        closeModal(); openClientDetail(existing.id); return;
    }
    const row = { id: nextLocalId(clients), name, phone, email, address,
                  address_data: addrDataFrom(addrEl),
                  created_at: new Date().toISOString().slice(0, 10) };
    clients.push(row);
    sbInsertClient(row);
    closeModal();
    navigate('clients');
    openClientDetail(row.id);
};


// ─── Suppliers ───────────────────────────────────────────────

function supplierFinancials(supplierId) {
    const sOrders = orders.filter(o => o.items.some(i => i.supplier_id === supplierId));
    let totalPurchases = 0, paid = 0;
    sOrders.forEach(o => {
        const purchase = o.items.filter(i => i.supplier_id === supplierId)
            .reduce((sum, i) => sum + i.purchase_price * i.quantity, 0);
        totalPurchases += purchase;
        if (o.settled) {
            paid += purchase;
        } else {
            const orderSupplierIds = [...new Set(o.items.map(i => i.supplier_id).filter(Boolean))];
            paid += transactions.filter(t => !t._pending && t.order_id === o.id && t.type === 'expense' &&
                t.entity_type === 'supplier' &&
                (t.entity_id === supplierId || orderSupplierIds.length === 1))
                .reduce((sum, t) => sum + t.amount, 0);
        }
    });
    return { sOrders, totalPurchases, paid, debt: Math.max(0, totalPurchases - paid) };
}

function renderSuppliers() {
    const rows = suppliers.map(s => {
        const f = supplierFinancials(s.id);
        return { ...s, orderCount: f.sOrders.length, totalPurchases: f.totalPurchases, debt: f.debt };
    });

    document.getElementById('suppliersBody').innerHTML = rows.map(s => `
        <tr data-supplier="${s.id}">
            <td class="td-bold" data-label="Название">${s.name}</td>
            <td data-label="Контактное лицо">${s.contact_person || '—'}</td>
            <td data-label="Телефон">${s.phone}</td>
            <td class="font-mono" data-label="Заказов">${s.orderCount}</td>
            <td class="font-mono text-right" data-label="Сумма закупок">${fmtCur(s.totalPurchases)}</td>
            <td class="font-mono text-right ${s.debt > 0 ? 'text-red' : ''}" data-label="Задолженность">${s.debt > 0 ? fmtCur(s.debt) : '—'}</td>
            <td data-label="" class="row-actions">
                <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openSupplierDetail(${s.id})">Карточка</button>
                <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openSupplierForm(${s.id})">Изменить</button>
                <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteSupplier(${s.id})">Удалить</button>
            </td>
        </tr>`).join('');

    document.querySelectorAll('#suppliersBody tr[data-supplier]').forEach(tr => {
        tr.addEventListener('click', () => openSupplierDetail(+tr.dataset.supplier));
    });
}

// Удаление поставщика (для чистки списка от неактуальных).
// Удаляет только из памяти; при следующей синхронизации из Google Таблицы
// вернётся, если поставщик ещё фигурирует в заказах.
window.deleteSupplier = function(supplierId) {
    const s = suppliers.find(x => x.id === supplierId);
    if (!s) return;
    const sOrders = orders.filter(o => o.items.some(i => i.supplier_id === s.id));
    let msg = `Удалить поставщика «${s.name}»?`;
    if (sOrders.length) {
        msg += `\n\nВнимание: с этим поставщиком связано ${sOrders.length} заказ(ов). ` +
               `Заказы останутся, но поставщик в них перестанет отображаться.`;
    }
    if (!confirm(msg)) return;
    const idx = suppliers.findIndex(x => x.id === supplierId);
    if (idx !== -1) suppliers.splice(idx, 1);
    sbDeleteSupplier(s);   // удаляем из серверной БД
    renderSuppliers();
};

window.openSupplierDetail = function(supplierId) {
    const s = suppliers.find(x => x.id === supplierId);
    if (!s) return;
    const f = supplierFinancials(s.id);
    const sOrders = f.sOrders.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const { totalPurchases, paid, debt } = f;

    openModal('Поставщик: ' + s.name, `
        <div class="detail-grid">
            <div class="detail-item">
                <div class="detail-label">Контактное лицо</div>
                <div class="detail-value">${s.contact_person || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Телефон</div>
                <div class="detail-value">${s.phone}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Email</div>
                <div class="detail-value">${s.email || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Заказов</div>
                <div class="detail-value big">${sOrders.length}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Сумма закупок</div>
                <div class="detail-value big">${fmtCur(totalPurchases)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Задолженность</div>
                <div class="detail-value big ${debt > 0 ? 'text-red' : 'text-green'}">${debt > 0 ? fmtCur(debt) : 'Нет'}</div>
            </div>
        </div>
        <div style="margin-top:8px">
            <div style="font-size:13px;margin-bottom:4px">Оплачено: <b>${fmtCur(paid)}</b> из ${fmtCur(totalPurchases)}</div>
            ${paymentBar(paid, totalPurchases)}
        </div>
        <div class="detail-section-title">Заказы с участием поставщика</div>
        <table class="items-table">
            <thead><tr><th>№ заказа</th><th>Дата</th><th>Клиент</th><th>Сумма закупки</th><th>Статус</th></tr></thead>
            <tbody>${sOrders.map(o => {
                const supplierTotal = o.items.filter(i => i.supplier_id === s.id).reduce((s2, i) => s2 + i.purchase_price * i.quantity, 0);
                return `<tr style="cursor:pointer" onclick="openOrderDetail(${o.id})">
                    <td class="td-bold">${o.order_number}</td>
                    <td>${fmtDate(o.created_at)}</td>
                    <td>${clientName(o.client_id)}</td>
                    <td class="font-mono">${fmtCur(supplierTotal)}</td>
                    <td><span class="badge badge-${o.status}">${statusLabel(o.status)}</span></td>
                </tr>`;
            }).join('')}</tbody>
        </table>
        <div class="form-actions">
            <button class="btn btn-primary" onclick="openSupplierForm(${s.id})">Редактировать</button>
        </div>
    `);
};

// Добавление / редактирование поставщика.
window.openSupplierForm = function(supplierId) {
    const s = supplierId ? suppliers.find(x => x.id === supplierId) : null;
    const esc = v => (v || '').replace(/"/g, '&quot;');
    openModal(s ? 'Редактирование поставщика' : 'Новый поставщик', `
        <div class="form-grid">
            <div class="form-group full">
                <label>Название</label>
                <input type="text" id="supName" value="${esc(s?.name)}" placeholder="Название поставщика" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Контактное лицо</label>
                <input type="text" id="supContact" value="${esc(s?.contact_person)}" placeholder="Имя">
            </div>
            <div class="form-group">
                <label>Телефон</label>
                <input type="text" id="supPhone" class="phone-input" value="${esc(s?.phone)}" placeholder="+7 (___) ___-__-__">
            </div>
            <div class="form-group full">
                <label>Email</label>
                <input type="email" id="supEmail" value="${esc(s?.email)}" placeholder="mail@example.com">
            </div>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
            <button class="btn btn-primary" onclick="saveSupplier(${supplierId || 0})">Сохранить</button>
        </div>
    `);
};

window.saveSupplier = function(supplierId) {
    const name = document.getElementById('supName').value.trim();
    if (!name) { alert('Укажите название поставщика'); return; }
    const contact = document.getElementById('supContact').value.trim();
    const phone = document.getElementById('supPhone').value.trim();
    const email = document.getElementById('supEmail').value.trim();
    const norm = name.toLowerCase();

    if (supplierId) {
        const s = suppliers.find(x => x.id === supplierId);
        if (!s) return;
        if (suppliers.some(x => x.id !== supplierId && x.name.trim().toLowerCase() === norm)) {
            alert('Поставщик с таким названием уже есть'); return;
        }
        const patch = { name, contact_person: contact, phone, email };
        Object.assign(s, patch);
        sbUpdateSupplier(s, patch);
    } else {
        if (suppliers.some(x => x.name.trim().toLowerCase() === norm)) {
            alert('Поставщик с таким названием уже есть'); return;
        }
        const row = { id: nextLocalId(suppliers), name, contact_person: contact, phone, email };
        suppliers.push(row);
        sbInsertSupplier(row);
    }
    closeModal();
    renderSuppliers();
};


// ─── Finances ────────────────────────────────────────────────

function getOlaSalaryConfig() {
    const saved = appSettingValue('ola_salary_rates', { default_rate: 9, months: {} });
    const defaultRate = Number.isFinite(+saved.default_rate) ? +saved.default_rate : 9;
    return {
        default_rate: defaultRate,
        months: saved.months && typeof saved.months === 'object' ? { ...saved.months } : {},
    };
}

function olaSalaryRateForMonth(month) {
    const config = getOlaSalaryConfig();
    const value = config.months[month];
    return Number.isFinite(+value) ? +value : config.default_rate;
}

function olaSalaryTurnover(month) {
    return orders
        .filter(o => (o.created_at || '').slice(0, 7) === month)
        .reduce((sum, order) => sum + calcOrder(order).totalSale, 0);
}

function formatSalaryMonth(month) {
    const [year, number] = String(month || '').split('-').map(Number);
    if (!year || !number) return month || '—';
    return new Date(year, number - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
}

function olaPaymentsForMonth(month) {
    return salaryPayments.filter(p => p.employee_key === 'olya' && p.salary_month === month && !p.deleted_at);
}

window.openEmployees = function() {
    openModal('Сотрудники', '<div class="employee-payroll-shell"><div class="ola-salary-panel" id="olaSalaryPanel"></div></div>');
    document.getElementById('modalOverlay').classList.add('employees-open');
    renderOlaSalary();
};

function renderOlaSalary() {
    const panel = document.getElementById('olaSalaryPanel');
    if (!panel) return;
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const months = [...new Set([
        currentMonth,
        ...orders.map(o => (o.created_at || '').slice(0, 7)).filter(Boolean),
        ...salaryPayments.map(p => p.salary_month).filter(Boolean),
    ])].sort().reverse();
    if (!window.olaSalaryMonth || !months.includes(window.olaSalaryMonth)) window.olaSalaryMonth = currentMonth;
    const month = window.olaSalaryMonth;
    const rate = olaSalaryRateForMonth(month);
    const turnover = olaSalaryTurnover(month);
    const salary = turnover * rate / 100;
    const monthPayments = olaPaymentsForMonth(month);
    const paid = monthPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const remaining = Math.max(0, salary - paid);
    const history = [...salaryPayments]
        .filter(p => p.employee_key === 'olya' && !p.deleted_at)
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id || 0) - (a.id || 0));
    const monthOptions = months.map(value => {
        return `<option value="${value}" ${value === month ? 'selected' : ''}>${formatSalaryMonth(value)}</option>`;
    }).join('');

    panel.innerHTML = `
        <div class="ola-salary-head">
            <div><h2>Оля</h2><p>Зарплата считается от суммы продаж в созданных заказах за месяц</p></div>
            <select id="olaSalaryMonth" onchange="window.olaSalaryMonth=this.value;renderOlaSalary()">${monthOptions}</select>
        </div>
        <div class="ola-salary-values">
            <div><span>Оборот по продажам</span><b>${fmtCur(turnover)}</b></div>
            <div class="ola-rate-field">
                <label for="olaSalaryRate">Ставка</label>
                <span><input id="olaSalaryRate" type="number" min="0" max="100" step="0.1" value="${rate}" oninput="previewOlaSalary()"> %</span>
                <button class="btn btn-sm btn-outline" onclick="saveOlaSalaryRate()">Сохранить</button>
            </div>
            <div class="ola-salary-total"><span>Начислено</span><b id="olaSalaryTotal" data-turnover="${turnover}" data-paid="${paid}">${fmtCurExact(salary)}</b></div>
            <div><span>Выплачено</span><b>${fmtCurExact(paid)}</b></div>
            <div class="ola-salary-due ${remaining > 0 ? 'has-debt' : 'is-paid'}"><span>Осталось выплатить</span><b id="olaSalaryDue">${remaining > 0 ? fmtCurExact(remaining) : 'Выплачено'}</b></div>
        </div>

        <div class="employee-section-title">Внести выплату за ${formatSalaryMonth(month)}</div>
        <div class="salary-payment-form">
            <div class="form-group">
                <label>Сумма ₽</label>
                <input type="number" id="olaPayoutAmount" min="0" step="any" value="${remaining > 0 ? remaining.toFixed(2) : ''}" placeholder="0">
            </div>
            <div class="form-group">
                <label>Дата выплаты</label>
                <input type="date" id="olaPayoutDate" value="${todayLocalDate()}">
            </div>
            <div class="form-group salary-payment-note">
                <label>Примечание</label>
                <input type="text" id="olaPayoutNote" placeholder="Аванс / остаток / перевод">
            </div>
            <button class="btn btn-primary" ${remaining <= 0 ? 'disabled' : ''} onclick="addOlaSalaryPayment()">Добавить выплату</button>
        </div>

        <div class="employee-section-title">История выплат</div>
        <div class="salary-history">
            ${history.length ? history.map(payment => `
                <div class="salary-history-row">
                    <span>${fmtDate(payment.date)}</span>
                    <span>${formatSalaryMonth(payment.salary_month)}</span>
                    <div>${htmlSafe(payment.note || 'Выплата зарплаты')}</div>
                    <b>${fmtCurExact(payment.amount)}</b>
                </div>`).join('') : '<div class="empty-state">Выплат пока не было</div>'}
        </div>
    `;
}

window.previewOlaSalary = function() {
    const input = document.getElementById('olaSalaryRate');
    const total = document.getElementById('olaSalaryTotal');
    if (!input || !total) return;
    const rate = Number(String(input.value).replace(',', '.'));
    const turnover = +total.dataset.turnover || 0;
    const paid = +total.dataset.paid || 0;
    const salary = turnover * (Number.isFinite(rate) ? rate : 0) / 100;
    total.textContent = fmtCurExact(salary);
    const due = document.getElementById('olaSalaryDue');
    if (due) due.textContent = salary - paid > 0 ? fmtCurExact(salary - paid) : 'Выплачено';
};

window.saveOlaSalaryRate = async function() {
    const input = document.getElementById('olaSalaryRate');
    const rate = Number(String(input?.value || '').replace(',', '.'));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        dbToast('Ставка должна быть от 0 до 100%', false);
        return;
    }
    const config = getOlaSalaryConfig();
    config.months[window.olaSalaryMonth] = rate;
    if (!await saveAppSetting('ola_salary_rates', config, 'ставка ЗП Оли')) return;
    renderOlaSalary();
    dbToast('Ставка ЗП сохранена', true);
};

let pendingOlaPayoutKey = null;

window.addOlaSalaryPayment = async function() {
    const amount = Number(String(document.getElementById('olaPayoutAmount')?.value || '').replace(',', '.'));
    const date = document.getElementById('olaPayoutDate')?.value || '';
    const note = document.getElementById('olaPayoutNote')?.value.trim() || '';
    if (!Number.isFinite(amount) || amount <= 0) { dbToast('Укажите сумму выплаты', false); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { dbToast('Укажите дату выплаты', false); return; }

    const rate = olaSalaryRateForMonth(window.olaSalaryMonth);
    const salary = olaSalaryTurnover(window.olaSalaryMonth) * rate / 100;
    const paid = olaPaymentsForMonth(window.olaSalaryMonth).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const remaining = Math.max(0, salary - paid);
    if (amount > remaining + 0.0001) {
        dbToast(`Сумма больше остатка (${fmtCurExact(remaining)})`, false);
        return;
    }

    pendingOlaPayoutKey = pendingOlaPayoutKey || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    const row = {
        id: nextLocalId(salaryPayments),
        employee_key: 'olya',
        employee_name: 'Оля',
        salary_month: window.olaSalaryMonth,
        date,
        amount,
        note,
        idempotency_key: pendingOlaPayoutKey,
        created_at: new Date().toISOString(),
    };
    const { data, error } = await SB.from('salary_payments').insert(row);
    if (error) { dbErr('выплата зарплаты', error); return; }
    const saved = (Array.isArray(data) ? data[0] : data) || row;
    saved.amount = Number(saved.amount);
    if (!salaryPayments.some(p => p.idempotency_key === saved.idempotency_key)) salaryPayments.push(saved);
    pendingOlaPayoutKey = null;
    renderOlaSalary();
    dbToast('Выплата сохранена', true);
};

function renderFinances() {
    const savedTransactions = transactions.filter(t => !t._pending);

    // Выбор: Все / Доходы / Расходы  +  разбивка по месяцам
    const type = window.finType || '';           // '', income, expense
    const typed = type ? savedTransactions.filter(t => t.type === type) : savedTransactions;

    // Суммы по месяцам для выбранного типа
    const monthSum = {};
    typed.forEach(t => {
        const m = (t.date || '').slice(0, 7);
        if (m) monthSum[m] = (monthSum[m] || 0) + t.amount;
    });
    const months = Object.keys(monthSum).sort().reverse();
    const totalAll = typed.reduce((s, t) => s + t.amount, 0);

    const sumClass = type === 'income' ? 'is-income' : type === 'expense' ? 'is-expense' : '';
    const item = (val, label, sum) =>
        `<button class="cat-item ${sumClass} ${window.finMonth === val ? 'active' : ''}" data-fmonth="${val}">
            <span class="cat-item-label">${label}</span><b class="fin-sum">${fmtCur(sum)}</b>
        </button>`;
    // «Всё время» + месяцы, сгруппированные по годам (год — заголовком)
    let html = item('', 'Всё время', totalAll);
    const byYear = {};
    months.forEach(m => { const y = m.slice(0, 4); (byYear[y] = byYear[y] || []).push(m); });
    Object.keys(byYear).sort().reverse().forEach(y => {
        const yearSum = byYear[y].reduce((s, m) => s + monthSum[m], 0);
        html += `<div class="fin-year-head"><span>${y}</span><b>${fmtCur(yearSum)}</b></div>`;
        byYear[y].forEach(m => {
            const mo = +m.slice(5, 7);
            html += item(m, MONTH_NAMES_FULL[mo - 1], monthSum[m]);
        });
    });
    const finMonthsBox = document.getElementById('finMonths');
    finMonthsBox.innerHTML = html;
    finMonthsBox.querySelectorAll('.cat-item').forEach(btn => {
        btn.addEventListener('click', () => { window.finMonth = btn.dataset.fmonth; renderFinances(); });
    });
    // Подсветка активной кнопки Все/Доходы/Расходы
    document.querySelectorAll('#finTypeToggle .fin-tab').forEach(b =>
        b.classList.toggle('active', (b.dataset.fintype || '') === type));

    let filtered = [...typed];
    if (window.finMonth) filtered = filtered.filter(t => (t.date || '').slice(0, 7) === window.finMonth);
    filtered.sort((a, b) => b.date.localeCompare(a.date));

    document.getElementById('financeBody').innerHTML = filtered.length ? filtered.map(t => {
        const order = t.order_id ? orders.find(o => o.id === t.order_id) : null;
        const orderNum = order ? (order.order_number || crmId(order)) : '—';
        return `<tr ${order ? `data-order="${order.id}" style="cursor:pointer"` : ''}>
            <td data-label="Дата">${fmtDate(t.date)}</td>
            <td data-label="Тип"><span class="badge badge-${t.type}">${t.type === 'income' ? 'Приход' : 'Расход'}</span></td>
            <td data-label="Контрагент">${t.entity_name || entityName(t.entity_type, t.entity_id)}</td>
            <td class="td-bold" data-label="Заказ">${orderNum}</td>
            <td class="font-mono text-right text-green" data-label="Приход">${t.type === 'income' ? fmtCur(t.amount) : ''}</td>
            <td class="font-mono text-right text-red" data-label="Расход">${t.type === 'expense' ? fmtCur(t.amount) : ''}</td>
            <td class="text-muted" data-label="Описание">${t.description}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-state">Нет операций</td></tr>';
    document.querySelectorAll('#financeBody tr[data-order]').forEach(row => {
        row.addEventListener('click', () => openOrderDetail(+row.dataset.order));
    });
}

window.finType = window.finType || '';    // '', income, expense
window.finMonth = window.finMonth || '';   // '', 'YYYY-MM'
// Переключатель Все / Доходы / Расходы
document.querySelectorAll('#finTypeToggle .fin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        window.finType = btn.dataset.fintype || '';
        window.finMonth = '';               // сбрасываем месяц при смене типа
        renderFinances();
    });
});

// Кнопка «+ Операция» в Финансах
document.getElementById('btnEmployees').addEventListener('click', openEmployees);
document.getElementById('btnNewTransaction').addEventListener('click', () => {
    const orderOptions = [...orders]
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .map(o => `<option value="${o.id}">${o.order_number || crmId(o)} — ${clientName(o.client_id)}</option>`)
        .join('');
    openModal('Новая финансовая операция', `
        <div class="form-grid">
            <div class="form-group">
                <label>Тип операции</label>
                <select id="txFormType" onchange="updateTxFormCounterparty()">
                    <option value="income">Приход (от клиента)</option>
                    <option value="expense">Оплата поставщику</option>
                </select>
            </div>
            <div class="form-group">
                <label>Дата</label>
                <input type="date" id="txFormDate" value="${todayLocalDate()}">
            </div>
            <div class="form-group">
                <label>Заказ</label>
                <select id="txFormOrder" onchange="updateTxFormCounterparty()">
                    <option value="">Выберите заказ…</option>
                    ${orderOptions}
                </select>
            </div>
            <div class="form-group full" id="txFormCounterparty">
                <label>Контрагент</label>
                <div class="text-muted">Сначала выберите заказ</div>
            </div>
            <div class="form-group">
                <label>Сумма ₽</label>
                <input type="number" id="txFormAmount" placeholder="0" min="0" step="any">
            </div>
            <div class="form-group full">
                <label>Описание</label>
                <input type="text" id="txFormDesc" placeholder="За что платёж">
            </div>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
            <button class="btn btn-primary" onclick="saveNewTransaction()">Сохранить</button>
        </div>
    `);
});

window.updateTxFormCounterparty = function() {
    const orderId = +document.getElementById('txFormOrder')?.value;
    const type = document.getElementById('txFormType')?.value;
    const box = document.getElementById('txFormCounterparty');
    const order = orders.find(o => o.id === orderId);
    if (!box || !order) {
        if (box) box.innerHTML = '<label>Контрагент</label><div class="text-muted">Сначала выберите заказ</div>';
        return;
    }
    if (type === 'income') {
        box.innerHTML = `<label>Клиент заказа</label><div class="detail-value">${clientName(order.client_id)}</div>`;
        return;
    }
    const supplierIds = [...new Set(order.items.map(i => i.supplier_id).filter(Boolean))];
    box.innerHTML = `<label>Поставщик заказа</label><select id="txFormSupplier">
        ${supplierIds.map(id => `<option value="${id}">${supplierName(id)}</option>`).join('')}
    </select>`;
};

window.saveNewTransaction = function() {
    const amount = parseFloat(document.getElementById('txFormAmount').value);
    if (!amount || amount <= 0) { alert('Укажите сумму'); return; }
    const type = document.getElementById('txFormType').value;
    const orderId = +document.getElementById('txFormOrder').value;
    const order = orders.find(o => o.id === orderId);
    if (!order) { alert('Выберите существующий заказ'); return; }
    const supplierId = type === 'expense' ? +document.getElementById('txFormSupplier')?.value : null;
    if (type === 'expense' && !supplierId) { alert('В заказе не указан поставщик'); return; }
    const remaining = paymentRemaining(order, type, supplierId);
    if (amount > remaining + 0.0001) {
        alert(`Сумма больше остатка к оплате (${fmtCur(Math.max(0, remaining))})`);
        return;
    }
    const newId = transactions.length ? Math.max(...transactions.map(t => t.id)) + 1 : 1;
    const tx = {
        id: newId,
        date: document.getElementById('txFormDate').value || todayLocalDate(),
        type: type,
        entity_type: type === 'income' ? 'client' : 'supplier',
        entity_id: type === 'income' ? order.client_id : supplierId,
        order_id: order.id,
        amount: amount,
        description: document.getElementById('txFormDesc').value.trim() || '',
        idempotency_key: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
        _pending: true,
    };
    transactions.push(tx);
    sbInsertTransaction(tx);        // сохраняем операцию в серверную БД
    closeModal();
    rerenderActiveSection();
};


// ─── Warehouse ───────────────────────────────────────────────

function renderWarehouse() {
    document.getElementById('warehouseBody').innerHTML = warehouseStock.map(ws => {
        const p = products.find(x => x.id === ws.product_id) || {};
        const available = ws.quantity - ws.reserved;
        const isLow = available <= ws.min_quantity;
        return `<tr>
            <td class="td-bold" data-label="Артикул">${p.sku || '—'}</td>
            <td data-label="Наименование">${p.name || '—'}</td>
            <td data-label="Категория">${categoryName(p.category_id)}</td>
            <td class="font-mono" data-label="Остаток">${ws.quantity} ${p.unit || ''}</td>
            <td class="font-mono" data-label="Резерв">${ws.reserved}</td>
            <td class="font-mono ${isLow ? 'low-stock' : ''}" data-label="Доступно">${available} ${isLow ? '⚠' : ''}</td>
            <td class="font-mono text-right" data-label="Закуп. цена">${fmtCur(p.purchase_price)}</td>
            <td class="font-mono text-right" data-label="Цена продажи">${fmtCur(p.sale_price)}</td>
            <td data-label=""><button class="btn btn-sm btn-outline" onclick="openProductDetail(${p.id})">Детали</button></td>
        </tr>`;
    }).join('');
}

window.openProductDetail = function(productId) {
    const p = products.find(x => x.id === productId);
    const ws = warehouseStock.find(x => x.product_id === productId);
    if (!p || !ws) return;
    const available = ws.quantity - ws.reserved;

    openModal('Товар: ' + p.name, `
        <div class="detail-grid">
            <div class="detail-item">
                <div class="detail-label">Артикул</div>
                <div class="detail-value td-bold">${p.sku}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Категория</div>
                <div class="detail-value">${categoryName(p.category_id)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Ед. измерения</div>
                <div class="detail-value">${p.unit}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Мин. остаток</div>
                <div class="detail-value">${ws.min_quantity}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Остаток</div>
                <div class="detail-value big">${ws.quantity}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Резерв</div>
                <div class="detail-value big">${ws.reserved}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Доступно</div>
                <div class="detail-value big ${available <= ws.min_quantity ? 'text-red' : 'text-green'}">${available}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Закуп. / Продажа</div>
                <div class="detail-value">${fmtCur(p.purchase_price)} / ${fmtCur(p.sale_price)}</div>
            </div>
        </div>
    `);
};

// Кнопка «+ Товар» в Складе
document.getElementById('btnNewProduct').addEventListener('click', () => {
    openModal('Новый товар', `
        <div class="form-grid">
            <div class="form-group">
                <label>Наименование</label>
                <input type="text" id="prodFormName" placeholder="Окно ПВХ двустворчатое 1400×1300">
            </div>
            <div class="form-group">
                <label>Артикул</label>
                <input type="text" id="prodFormSku" placeholder="OKN-001">
            </div>
            <div class="form-group">
                <label>Категория</label>
                <input type="text" id="prodFormCategory" placeholder="Окна ПВХ">
            </div>
            <div class="form-group">
                <label>Ед. измерения</label>
                <input type="text" id="prodFormUnit" value="шт" placeholder="шт / м² / лист">
            </div>
            <div class="form-group">
                <label>Закупочная цена ₽</label>
                <input type="number" id="prodFormPurchase" placeholder="0" min="0" step="any">
            </div>
            <div class="form-group">
                <label>Цена продажи ₽</label>
                <input type="number" id="prodFormSale" placeholder="0" min="0" step="any">
            </div>
            <div class="form-group">
                <label>Начальный остаток</label>
                <input type="number" id="prodFormQty" value="0" min="0">
            </div>
            <div class="form-group">
                <label>Мин. остаток</label>
                <input type="number" id="prodFormMinQty" value="0" min="0">
            </div>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
            <button class="btn btn-primary" onclick="saveNewProduct()">Добавить товар</button>
        </div>
    `);
});

window.saveNewProduct = function() {
    const name = document.getElementById('prodFormName').value.trim();
    if (!name) { alert('Укажите наименование'); return; }
    const newProdId = products.length ? Math.max(...products.map(p => p.id)) + 1 : 1;
    const catName = document.getElementById('prodFormCategory').value.trim();
    let catId = null;
    if (catName) {
        const existing = categories.find(c => c.name.toLowerCase() === catName.toLowerCase());
        if (existing) { catId = existing.id; }
        else { catId = categories.length ? Math.max(...categories.map(c => c.id)) + 1 : 1; categories.push({ id: catId, name: catName }); }
    }
    products.push({
        id: newProdId, name: name, sku: document.getElementById('prodFormSku').value.trim(),
        category_id: catId, unit: document.getElementById('prodFormUnit').value.trim() || 'шт',
        purchase_price: parseFloat(document.getElementById('prodFormPurchase').value) || 0,
        sale_price: parseFloat(document.getElementById('prodFormSale').value) || 0,
    });
    warehouseStock.push({
        product_id: newProdId,
        quantity: parseFloat(document.getElementById('prodFormQty').value) || 0,
        reserved: 0,
        min_quantity: parseFloat(document.getElementById('prodFormMinQty').value) || 0,
    });
    closeModal();
    rerenderActiveSection();
};

// Кнопка «Приход» в Складе
document.getElementById('btnStockIn').addEventListener('click', () => {
    const opts = products.map(p => `<option value="${p.id}">${p.sku || ''} — ${p.name}</option>`).join('');
    openModal('Приход товара', `
        <div class="form-grid">
            <div class="form-group full">
                <label>Товар</label>
                <select id="stockInProduct">${opts || '<option value="">Нет товаров — сначала добавьте</option>'}</select>
            </div>
            <div class="form-group">
                <label>Количество</label>
                <input type="number" id="stockInQty" value="1" min="1" step="any">
            </div>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
            <button class="btn btn-primary" onclick="saveStockIn()">Оприходовать</button>
        </div>
    `);
});

window.saveStockIn = function() {
    const prodId = +document.getElementById('stockInProduct').value;
    const qty = parseFloat(document.getElementById('stockInQty').value) || 0;
    if (!prodId || qty <= 0) { alert('Укажите товар и количество'); return; }
    const ws = warehouseStock.find(x => x.product_id === prodId);
    if (ws) { ws.quantity += qty; }
    else { warehouseStock.push({ product_id: prodId, quantity: qty, reserved: 0, min_quantity: 0 }); }
    closeModal();
    rerenderActiveSection();
};


// ─── Global Search ───────────────────────────────────────────

const searchInput = document.getElementById('globalSearch');
const searchDropdown = document.getElementById('searchDropdown');
const searchNorm = value => String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
const searchHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const searchRank = (value, q) => {
    const text = searchNorm(value);
    return text === q ? 0 : text.startsWith(q) ? 1 : text.includes(q) ? 2 : 9;
};

searchInput.addEventListener('input', () => {
    const q = searchNorm(searchInput.value.trim());
    if (q.length < 2) { searchDropdown.classList.remove('open'); return; }

    let html = '', clientHtml = '', supplierHtml = '', productHtml = '';
    const qDigits = q.replace(/\D/g, '');

    // Сначала показываем точные сущности — они не должны прятаться под десятками заказов.
    const matchedClients = clients.filter(c =>
        [clientLabel(c), c.email, c.address].some(v => searchNorm(v).includes(q)) ||
        (qDigits && String(c.phone || '').replace(/\D/g, '').includes(qDigits))
    ).sort((a, b) => searchRank(clientLabel(a), q) - searchRank(clientLabel(b), q)).slice(0, 8);
    if (matchedClients.length) {
        clientHtml += '<div class="search-group-title">Клиенты</div>';
        matchedClients.forEach(c => {
            clientHtml += `<div class="search-item" data-action="client" data-id="${c.id}">
                <span class="search-item-main">${searchHtml(clientLabel(c))}</span>
                <span class="search-item-sub">${searchHtml(c.phone || c.address)}</span>
            </div>`;
        });
    }

    const matchedSuppliers = suppliers.filter(s =>
        [s.name, s.contact_person, s.email].some(v => searchNorm(v).includes(q)) ||
        (qDigits && String(s.phone || '').replace(/\D/g, '').includes(qDigits))
    ).sort((a, b) => searchRank(a.name, q) - searchRank(b.name, q)).slice(0, 8);
    if (matchedSuppliers.length) {
        supplierHtml += '<div class="search-group-title">Поставщики</div>';
        matchedSuppliers.forEach(s => {
            supplierHtml += `<div class="search-item" data-action="supplier" data-id="${s.id}">
                <span class="search-item-main">${searchHtml(s.name)}</span>
                <span class="search-item-sub">${searchHtml(s.phone || s.contact_person)}</span>
            </div>`;
        });
    }

    const matchedProductNames = getProductNameSuggestions().filter(name => searchNorm(name).includes(q))
        .sort((a, b) => searchRank(a, q) - searchRank(b, q) || a.localeCompare(b, 'ru')).slice(0, 8);
    if (matchedProductNames.length) {
        productHtml += '<div class="search-group-title">Продукция</div>';
        matchedProductNames.forEach(name => {
            productHtml += `<div class="search-item" data-action="catalog-product" data-name="${encodeURIComponent(name)}">
                <span class="search-item-main">${searchHtml(name)}</span>
                <span class="search-item-sub">${searchHtml(productCategory(name))}</span>
            </div>`;
        });
    }

    html = supplierHtml + productHtml + clientHtml;

    const matchedOrders = orders.filter(o =>
        searchNorm(o.order_number).includes(q) ||
        searchNorm(crmId(o)).includes(q) ||
        searchNorm(clientName(o.client_id)).includes(q) ||
        (qDigits && clientPhone(o.client_id).replace(/\D/g, '').includes(qDigits)) ||
        o.items.some(i => searchNorm(i.product_name).includes(q) || searchNorm(supplierName(i.supplier_id)).includes(q)) ||
        searchNorm(o.production_number).includes(q) || searchNorm(o.notes).includes(q)
    ).slice(0, 8);
    if (matchedOrders.length) {
        html += '<div class="search-group-title">Заказы</div>';
        matchedOrders.forEach(o => {
            const product = o.items.map(i => i.product_name).filter(Boolean).join(', ');
            html += `<div class="search-item" data-action="order" data-id="${o.id}">
                <span class="search-item-main">${searchHtml(o.order_number || crmId(o))} — ${searchHtml(clientName(o.client_id))}<br><span class="text-muted" style="font-size:12px">${searchHtml(product.slice(0, 50))}</span></span>
                <span class="search-item-sub"><span class="badge badge-${o.status}">${statusLabel(o.status)}</span></span>
            </div>`;
        });
    }

    if (!html) html = '<div class="empty-state" style="padding:16px">Ничего не найдено</div>';
    searchDropdown.innerHTML = html;
    searchDropdown.classList.add('open');

    searchDropdown.querySelectorAll('.search-item').forEach(el => {
        el.addEventListener('click', () => {
            const action = el.dataset.action;
            const id = +el.dataset.id;
            searchDropdown.classList.remove('open');
            searchInput.value = '';
            if (action === 'order') openOrderDetail(id);
            if (action === 'client') openClientDetail(id);
            if (action === 'supplier') openSupplierDetail(id);
            if (action === 'catalog-product') {
                const name = decodeURIComponent(el.dataset.name || '');
                navigate('products');
                window.productCat = 'all';
                const input = document.getElementById('productSearch');
                if (input) input.value = name;
                renderProductCatalog();
            }
        });
    });
});

searchInput.addEventListener('blur', () => {
    setTimeout(() => searchDropdown.classList.remove('open'), 200);
});
searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length >= 2) searchDropdown.classList.add('open');
});


// ─── New Order Form ──────────────────────────────────────────

// Авто-показ поля «Размеры»: ключевые слова, по которым считаем что продукт измеряется
const SIZED_KEYWORDS = /окн|двер|балкон|створ|стекл|подоконн|откос|витраж|раздвижн|роллет|жалюзи|москит/i;

function isSizedProduct(name) {
    return name && SIZED_KEYWORDS.test(name);
}

function orderItemRowHTML(item) {
    const it = item || {};
    const name = (it.product_name || '').replace(/"/g, '&quot;');
    const dims = (it.dimensions || '').replace(/"/g, '&quot;');
    const showDims = isSizedProduct(name) || !!dims;
    return `
        <div class="order-item-row">
            <div class="form-group item-col-name">
                <label>Продукция</label>
                <input type="text" class="item-name" list="productsList" value="${name}" placeholder="Название товара">
            </div>
            <div class="form-group item-col-dims" style="${showDims ? '' : 'display:none'}">
                <label>Размеры (Ш × В, мм)</label>
                <input type="text" class="item-dimensions" value="${dims}" placeholder="напр. 1400×1300">
            </div>
            <div class="form-group item-col-qty">
                <label>Кол-во</label>
                <input type="number" class="item-qty" value="${it.quantity ?? 1}" min="0" step="any">
            </div>
            <div class="form-group item-col-purchase">
                <label>Закупка ₽</label>
                <input type="number" class="item-purchase" value="${it.purchase_price ?? ''}" placeholder="0" min="0" step="any">
            </div>
            <div class="form-group item-col-sale">
                <label>Продажа ₽</label>
                <input type="number" class="item-sale" value="${it.sale_price ?? ''}" placeholder="0" min="0" step="any">
            </div>
            <button class="btn btn-sm btn-outline item-remove" onclick="this.closest('.order-item-row').remove()" title="Удалить позицию">✕</button>
        </div>`;
}

// Автопоказ поля «Размеры», когда в названии встречается «окно/дверь/...»
document.addEventListener('input', (e) => {
    if (!e.target.classList.contains('item-name')) return;
    const row = e.target.closest('.order-item-row');
    if (!row) return;
    const dimsBox = row.querySelector('.item-col-dims');
    if (!dimsBox) return;
    if (isSizedProduct(e.target.value)) dimsBox.style.display = '';
});

function openNewOrderForm() {
    // Уникальные названия ранее заказанной продукции — для автодополнения
    const productNames = getProductNameSuggestions();
    const supplierNames = [...new Set(suppliers.map(s => s.name))];

    openModal('Новый заказ', `
        <datalist id="clientsList">
            ${clients.map(c => `<option value="${c.name}">`).join('')}
        </datalist>
        <datalist id="productsList">
            ${productNames.map(n => `<option value="${n.replace(/"/g, '&quot;')}">`).join('')}
        </datalist>
        <datalist id="suppliersList">
            ${supplierNames.map(n => `<option value="${n}">`).join('')}
        </datalist>

        <div class="form-grid">
            <div class="form-group">
                <label>Клиент (ФИО)</label>
                <input type="text" id="formClientName" list="clientsList" placeholder="Фамилия Имя Отчество" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Телефон</label>
                <input type="text" id="formClientPhone" class="phone-input" placeholder="+7 (___) ___-__-__">
                <div id="formClientMatch" class="client-match-hint"></div>
            </div>
            <div class="form-group">
                <label>Дата создания</label>
                <input type="date" id="formCreatedDate" value="${new Date().toISOString().slice(0,10)}">
            </div>
            <div class="form-group">
                <label>Дата доставки</label>
                <input type="date" id="formDeliveryDate">
            </div>
            <div class="form-group">
                <label>Заказ оформил</label>
                <select id="formManagerKey" required>${orderManagerOptions('', false)}</select>
            </div>
            <div class="form-group full">
                <label>Адрес доставки</label>
                <input type="text" id="formDeliveryAddr" class="addr-suggest" placeholder="Начните вводить адрес…" autocomplete="off">
            </div>
        </div>

        <div class="detail-section-title">Продукция</div>
        <p class="text-muted" style="font-size:12px;margin:-4px 0 10px">Вписывайте любые товары вручную — даже те, которых ещё не было в заказах.</p>
        <div id="orderItemsContainer">
            ${orderItemRowHTML()}
        </div>
        <button class="btn btn-sm btn-outline" onclick="addOrderItemRow()" style="margin-top:4px">+ Добавить позицию</button>

        <div class="form-grid" style="margin-top:16px">
            <div class="form-group">
                <label>Поставщик</label>
                <input type="text" id="formSupplier" list="suppliersList" placeholder="Название поставщика" autocomplete="off">
            </div>
            <div class="form-group">
                <label>Номер от производства <span class="text-muted" style="font-weight:400">(если уже есть)</span></label>
                <input type="text" id="formProdNumber" placeholder="Впишете, когда придёт ответ" autocomplete="off">
            </div>
            <div class="form-group full">
                <label>Примечание</label>
                <input type="text" id="formNotes" placeholder="Комментарий к заказу">
            </div>
        </div>

        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
            <button class="btn btn-primary" onclick="saveNewOrder()">Создать заказ</button>
        </div>
    `);
}

window.addOrderItemRow = function() {
    document.getElementById('orderItemsContainer').insertAdjacentHTML('beforeend', orderItemRowHTML());
};

// Телефон → 10 цифр национального номера (для сравнения независимо от формата)
function normPhone(p) {
    let d = (p || '').replace(/\D/g, '');
    if (d[0] === '8') d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    return d.length >= 11 ? d.slice(-10) : (d.length === 10 ? d : '');
}

// Найти клиента по номеру телефона (номер у клиента один, а имя менеджеры
// пишут по-разному). Если под номером несколько записей — берём «главную»:
// с наибольшим числом заказов, при равенстве — с меньшим id.
function findClientByPhone(phone) {
    const n = normPhone(phone);
    if (!n) return null;
    const matches = clients.filter(c => normPhone(c.phone) === n);
    if (matches.length <= 1) return matches[0] || null;
    return matches
        .map(c => ({ c, cnt: orders.filter(o => o.client_id === c.id).length }))
        .sort((a, b) => b.cnt - a.cnt || a.c.id - b.c.id)[0].c;
}

// Найти существующего клиента (сначала по телефону, затем по имени) или создать
function findOrCreateClient(name, phone, address, addressData) {
    // Приоритет — телефон: имя может отличаться (Женя/Евгений/Евгеша), номер один
    let cl = findClientByPhone(phone);
    if (!cl) {
        const norm = name.trim().toLowerCase();
        cl = clients.find(c => c.name.trim().toLowerCase() === norm);
    }
    if (cl) {
        // Дозаполняем телефон/адрес у существующего клиента, если их ещё не было
        const patch = {};
        if (phone && !cl.phone) patch.phone = phone;
        if (address && !cl.address) patch.address = address;
        if (addressData && !cl.address_data) patch.address_data = addressData;
        if (Object.keys(patch).length) { Object.assign(cl, patch); sbUpdateClient(cl, patch); }
        return cl.id;
    }
    const newId = clients.length ? Math.max(...clients.map(c => c.id)) + 1 : 1;
    const row = { id: newId, name: name.trim(), phone: phone || '', email: '', address: address || '',
                  address_data: addressData || null, created_at: new Date().toISOString().slice(0, 10) };
    clients.push(row);
    sbInsertClient(row);            // сохраняем нового клиента в серверную БД
    return newId;
}

// Найти поставщика по названию или создать нового
function findOrCreateSupplier(name) {
    if (!name || !name.trim()) return null;
    const norm = name.trim().toLowerCase();
    let s = suppliers.find(x => x.name.trim().toLowerCase() === norm);
    if (s) return s.id;
    const newId = suppliers.length ? Math.max(...suppliers.map(x => x.id)) + 1 : 1;
    const row = { id: newId, name: name.trim(), contact_person: '', phone: '', email: '' };
    suppliers.push(row);
    sbInsertSupplier(row);          // сохраняем нового поставщика в серверную БД
    return newId;
}

window.saveNewOrder = function() {
    const clientName = document.getElementById('formClientName').value.trim();
    const clientPhone = document.getElementById('formClientPhone').value.trim();
    const managerKey = document.getElementById('formManagerKey').value;
    if (!clientName) { alert('Укажите ФИО клиента'); return; }
    if (!ORDER_MANAGER_LABELS[managerKey]) { alert('Выберите, кто оформил заказ: Саша или Оля'); return; }

    const supplierName = document.getElementById('formSupplier').value.trim();
    const supplierId = findOrCreateSupplier(supplierName);

    const items = [];
    document.querySelectorAll('.order-item-row').forEach(row => {
        const name = row.querySelector('.item-name').value.trim();
        const qty = parseFloat(row.querySelector('.item-qty').value) || 1;
        const purchase = parseFloat(row.querySelector('.item-purchase').value) || 0;
        const sale = parseFloat(row.querySelector('.item-sale').value) || 0;
        const dims = row.querySelector('.item-dimensions')?.value.trim() || '';
        if (name) {
            items.push({ product_name: name, dimensions: dims, supplier_id: supplierId,
                         quantity: qty, purchase_price: purchase, sale_price: sale });
        }
    });
    if (!items.length) { alert('Добавьте хотя бы одну позицию продукции'); return; }

    const addrEl = document.getElementById('formDeliveryAddr');
    const clientAddress = addrEl.value.trim();
    const clientId = findOrCreateClient(clientName, clientPhone, clientAddress, addrDataFrom(addrEl));
    const newId = orders.length ? Math.max(...orders.map(o => o.id)) + 1 : 1;
    const deliveryDate = document.getElementById('formDeliveryDate').value || null;

    const newOrder = {
        id: newId,
        // Номер от производства — пустой при создании; менеджер впишет его, когда
        // придёт ответ с производства. Наш идентификатор для писем — CRM-ID (crmId).
        order_number: (document.getElementById('formProdNumber')?.value || '').trim(),
        client_id: clientId,
        status: 'new',
        manager_key: managerKey,
        delivery_status: null,
        created_at: document.getElementById('formCreatedDate').value || new Date().toISOString().slice(0, 10),
        delivery_date: deliveryDate,
        notes: document.getElementById('formNotes').value.trim(),
        idempotency_key: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
        items: items,
    };
    orders.push(newOrder);
    sbInsertOrder(newOrder);        // сохраняем заказ в серверную БД (idempotency_key защищает от дабл-клика)

    closeModal();
    navigate('orders');
};

document.getElementById('btnNewOrder2').addEventListener('click', openNewOrderForm);
document.getElementById('btnNewSupplier').addEventListener('click', () => openSupplierForm());
document.getElementById('btnNewClient').addEventListener('click', openNewClientForm);
document.getElementById('ordersMonthsToggle').addEventListener('click', () => {
    window.ordersMonthsOpen = !window.ordersMonthsOpen;
    localStorage.setItem('orders_months_open', window.ordersMonthsOpen ? '1' : '0');
    applyOrdersMonthsState();
});

// ─── Подсказки адреса (DaData Suggestions) ───────────────────
// Работает на полях .addr-suggest (адрес в заказе/клиенте). Браузер обращается
// к собственному API CRM, а токен DaData хранится только на VPS. При выборе в
// input._dadata сохраняется структура (регион/город/улица/дом/индекс/координаты).
let addrDadataTimer = null;
function addrSuggestBox() {
    let box = document.getElementById('addrSuggestBox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'addrSuggestBox'; box.className = 'addr-suggest-box';
        document.body.appendChild(box);
    }
    return box;
}
async function fetchDadataAddress(query) {
    try {
        const r = await fetch('/api/address-suggest', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json', 'Accept': 'application/json',
            },
            body: JSON.stringify({ query, count: 7 }),
        });
        if (!r.ok) return [];
        const d = await r.json();
        return d.suggestions || [];   // [{ value, unrestricted_value, data:{...} }]
    } catch (e) { return []; }
}
document.addEventListener('input', e => {
    const t = e.target;
    if (!t.classList || !t.classList.contains('addr-suggest')) return;
    t._dadata = null;                     // изменили руками — сбрасываем привязку структуры
    const box = addrSuggestBox();
    clearTimeout(addrDadataTimer);
    const q = t.value.trim();
    if (q.length < 3) { box.style.display = 'none'; return; }
    addrDadataTimer = setTimeout(async () => {              // debounce 300 мс
        const items = await fetchDadataAddress(q);
        if (!items.length || document.activeElement !== t) { box.style.display = 'none'; return; }
        box.innerHTML = items.map((it, i) =>
            `<div class="addr-suggest-item" data-i="${i}">${(it.value || '').replace(/</g, '&lt;')}</div>`).join('');
        box._items = items; box._input = t;
        const r = t.getBoundingClientRect();
        box.style.left = r.left + 'px'; box.style.top = (r.bottom + 2) + 'px'; box.style.width = r.width + 'px';
        box.style.display = 'block';
        box.querySelectorAll('.addr-suggest-item').forEach(el => {
            el.addEventListener('mousedown', ev => {   // mousedown — успеть до blur
                ev.preventDefault();
                const s = box._items[+el.dataset.i];
                t.value = s.value;
                t._dadata = s.data || null;   // структура: регион/город/улица/дом/индекс/гео
                box.style.display = 'none';
            });
        });
    }, 300);
});
document.addEventListener('click', e => {
    const box = document.getElementById('addrSuggestBox');
    if (box && !e.target.closest('.addr-suggest') && !e.target.closest('#addrSuggestBox')) box.style.display = 'none';
});
// Компактная структура адреса из ответа DaData (для хранения в address_data)
function addrDataFrom(input) {
    const d = input && input._dadata;
    if (!d) return null;
    return {
        region: d.region_with_type || d.region || null,
        city: d.city_with_type || d.settlement_with_type || d.city || null,
        street: d.street_with_type || null,
        house: d.house || null,
        flat: d.flat || null,
        postal_code: d.postal_code || null,
        geo_lat: d.geo_lat || null, geo_lon: d.geo_lon || null,
        fias_id: d.fias_id || null,
    };
}
document.getElementById('productSearch').addEventListener('input', renderProductCatalog);
// Массовый выбор в каталоге продукции
document.getElementById('productSelectAll').addEventListener('change', e => {
    const on = e.target.checked;
    document.querySelectorAll('#productCatalogBody .prod-check').forEach(box => {
        box.checked = on;
        if (on) window.productSelected.add(box.dataset.n); else window.productSelected.delete(box.dataset.n);
    });
    updateProductBulkBar();
});
document.getElementById('productBulkDelete').addEventListener('click', () => hideProductNames([...window.productSelected]));
document.getElementById('productBulkClear').addEventListener('click', () => { window.productSelected.clear(); renderProductCatalog(); });

// ─── Уведомления ─────────────────────────────────────────────
// Единый центр: статусы производства, ближайшие/просроченные доставки, новые
// заказы. Позже сюда же будут падать письма с почты (интеграция с производством).
const NOTIF_SEEN_KEY = 'notif_last_seen_v1';

function buildNotifications() {
    const list = [];
    const today = new Date().toISOString().slice(0, 10);
    const plus7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

    orders.forEach(o => {
        // Статус от производства (появится, когда заработает синхронизация с почтой)
        if (o.production_status) {
            const h = (o.status_history && o.status_history.length) ? o.status_history[o.status_history.length - 1] : null;
            list.push({
                id: 'prod-' + o.id, ts: (h && h.date) || o.created_at, kind: 'production',
                title: `Производство: ${PRODUCTION_STATUS_LABELS[o.production_status] || o.production_status}`,
                sub: `${o.order_number} · ${clientName(o.client_id)}`, orderId: o.id,
            });
        }
    });

    // Доставки: просроченные и ближайшие (7 дней) среди открытых заказов
    orders.filter(o => o.status !== 'closed' && o.delivery_date).forEach(o => {
        if (o.delivery_date < today) {
            list.push({ id: 'del-late-' + o.id, ts: o.delivery_date, kind: 'late',
                title: `Просрочена доставка`, sub: `${o.order_number} · ${clientName(o.client_id)} · ${fmtDate(o.delivery_date)}`, orderId: o.id });
        } else if (o.delivery_date <= plus7) {
            list.push({ id: 'del-soon-' + o.id, ts: o.delivery_date, kind: 'soon',
                title: `Скоро доставка`, sub: `${o.order_number} · ${clientName(o.client_id)} · ${fmtDate(o.delivery_date)}`, orderId: o.id });
        }
    });

    // Новые заказы за последние 14 дней
    const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
    orders.filter(o => o.created_at && o.created_at >= since && o.status === 'new').forEach(o => {
        list.push({ id: 'new-' + o.id, ts: o.created_at, kind: 'new',
            title: `Новый заказ`, sub: `${o.order_number} · ${clientName(o.client_id)}`, orderId: o.id });
    });

    // Новые — сверху
    return list.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 40);
}

const NOTIF_ICONS = {
    production: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 21V9l6-3.2v3.4l6-3.2v3.4l6-3.2V21z"/></svg>',
    late:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>',
    soon:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/></svg>',
    new:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
};

function renderNotifications() {
    const box = document.getElementById('notifDropdown');
    const badge = document.getElementById('notifBadge');
    if (!box) return;
    const items = buildNotifications();
    const lastSeen = localStorage.getItem(NOTIF_SEEN_KEY) || '';
    const unread = items.filter(n => String(n.ts) > lastSeen).length;

    if (badge) {
        if (unread > 0) { badge.textContent = unread > 99 ? '99+' : unread; badge.style.display = ''; }
        else badge.style.display = 'none';
    }

    box.innerHTML = `
        <div class="notif-head">
            <span>Уведомления</span>
            ${items.length ? '<button class="notif-clear" id="notifClear">Отметить прочитанными</button>' : ''}
        </div>
        ${items.length ? items.map(n => `
            <div class="notif-item notif-${n.kind} ${String(n.ts) > lastSeen ? 'is-unread' : ''}" data-order="${n.orderId}">
                <span class="notif-ic">${NOTIF_ICONS[n.kind] || ''}</span>
                <span class="notif-body">
                    <span class="notif-title">${n.title}</span>
                    <span class="notif-sub">${n.sub}</span>
                </span>
            </div>`).join('')
        : '<div class="notif-empty">Пока нет уведомлений.<br>Сюда будут падать статусы заказов и письма с производства.</div>'}
    `;

    box.querySelectorAll('.notif-item').forEach(el => {
        el.addEventListener('click', () => {
            document.getElementById('notifDropdown').classList.remove('open');
            openOrderDetail(+el.dataset.order);
        });
    });
    const clearBtn = document.getElementById('notifClear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
        localStorage.setItem(NOTIF_SEEN_KEY, new Date().toISOString().slice(0, 10));
        renderNotifications();
    });
}

document.getElementById('notifBtn').addEventListener('click', e => {
    e.stopPropagation();
    const dd = document.getElementById('notifDropdown');
    const opening = !dd.classList.contains('open');
    dd.classList.toggle('open');
    if (opening) {
        renderNotifications();
        // помечаем как «просмотрено» (гасим счётчик), список остаётся
        localStorage.setItem(NOTIF_SEEN_KEY, new Date().toISOString().slice(0, 10));
        const badge = document.getElementById('notifBadge');
        setTimeout(() => { if (badge) badge.style.display = 'none'; }, 1200);
    }
});
document.addEventListener('click', e => {
    const dd = document.getElementById('notifDropdown');
    if (dd && dd.classList.contains('open') && !e.target.closest('.notif-wrap')) dd.classList.remove('open');
});

// Backspace в конце форматированного телефона всегда удаляет именно одну цифру,
// а не скобку/дефис, которые форматтер тут же возвращал обратно.
document.addEventListener('beforeinput', e => {
    const t = e.target;
    if (!t?.classList?.contains('phone-input') || e.inputType !== 'deleteContentBackward') return;
    if (t.selectionStart !== t.selectionEnd || t.selectionEnd !== t.value.length) return;
    e.preventDefault();
    let digits = t.value.replace(/\D/g, '');
    if (digits.startsWith('7')) digits = digits.slice(1);
    digits = digits.slice(0, -1);
    t.value = digits ? formatPhoneRu(digits) : '';
    t.dispatchEvent(new Event('input', { bubbles: true }));
});

// Живое форматирование телефона (+7 подставляется само) во всех полях .phone-input.
document.addEventListener('input', e => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('phone-input')) {
        const f = formatPhoneRu(t.value);
        if (t.value !== f) { t.value = f; }
    }
});

// Автозаполнение телефона и адреса при выборе клиента из базы по ИМЕНИ.
// Срабатывает, когда введённое ФИО точно совпадает с клиентом (выбор из списка).
document.addEventListener('input', e => {
    const t = e.target;
    if (!t || (t.id !== 'formClientName' && t.id !== 'editClientName')) return;
    const cl = clients.find(c => c.name.trim().toLowerCase() === t.value.trim().toLowerCase());
    if (!cl) return;
    const phoneEl = document.getElementById(t.id === 'formClientName' ? 'formClientPhone' : 'editClientPhone');
    if (phoneEl && !phoneEl.value.trim() && cl.phone) phoneEl.value = formatPhoneRu(cl.phone);
    const addrEl = document.getElementById('formDeliveryAddr');   // адрес есть только в форме нового заказа
    if (addrEl && !addrEl.value.trim() && cl.address) addrEl.value = cl.address;
});

// Поиск клиента по НОМЕРУ телефона (главный способ: номер один, а имена разные).
// Как только введены 10 цифр — ищем клиента и подставляем имя/адрес + показываем,
// что клиент найден в базе. Работает в форме нового заказа и редактирования.
document.addEventListener('input', e => {
    const t = e.target;
    if (!t || (t.id !== 'formClientPhone' && t.id !== 'editClientPhone')) return;
    const isNew = t.id === 'formClientPhone';
    const hint = document.getElementById(isNew ? 'formClientMatch' : 'editClientMatch');
    if (normPhone(t.value).length !== 10) { if (hint) hint.textContent = ''; return; }
    const cl = findClientByPhone(t.value);
    const nameEl = document.getElementById(isNew ? 'formClientName' : 'editClientName');
    if (!cl) {
        if (hint) { hint.textContent = 'Новый номер — клиента в базе нет'; hint.className = 'client-match-hint is-new'; }
        return;
    }
    // Клиент найден по номеру — подставляем имя (если поле пустое) и адрес
    if (nameEl && !nameEl.value.trim()) nameEl.value = cl.name;
    const addrEl = document.getElementById('formDeliveryAddr');
    if (addrEl && !addrEl.value.trim() && cl.address) addrEl.value = cl.address;
    if (hint) {
        const ordCnt = orders.filter(o => o.client_id === cl.id).length;
        hint.textContent = `Найден в базе: ${cl.name}${ordCnt ? ` · заказов: ${ordCnt}` : ''}`;
        hint.className = 'client-match-hint is-found';
    }
});


// ─── Modal management ────────────────────────────────────────

function openModal(title, bodyHTML) {
    document.getElementById('modalTitle').textContent = title;
    const body = document.getElementById('modalBody');
    delete body.dataset.orderDetail;
    body.innerHTML = bodyHTML;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.remove('order-detail-open', 'employees-open');
    overlay.classList.add('open');
    document.body.classList.add('modal-open');   // блокируем скролл страницы под окном
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('open', 'order-detail-open', 'employees-open');
    document.body.classList.remove('modal-open');
    document.body.classList.remove('print-delivery-order');
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
});


// ─── Init ────────────────────────────────────────────────────

// Граница архива: заказы, созданные ДО этой даты, считаются завершёнными
// (закрыты, все долги обнулены). Меняется одной строкой.
const ARCHIVE_BEFORE = '2026-04-01';

function archiveOldOrders() {
    let closed = 0, settled = 0;
    orders.forEach(o => {
        if (o.created_at && o.created_at < ARCHIVE_BEFORE) {
            if (o.status !== 'closed') { o.status = 'closed'; closed++; }
            if (!o.settled) { o.settled = true; settled++; }
        }
    });
    console.log(`Архив (до ${ARCHIVE_BEFORE}): закрыто ${closed}, оплачено-полностью ${settled}`);
}

// Удаление «мусорных» клиентов — без телефона И без осмысленного имени
// (служебные записи: «в офис», «продажа», «склад», «-», «Без имени» и т.п.).
// Клиенты с телефоном ИЛИ нормальным именем сохраняются.
const JUNK_CLIENT_NAMES = ['', 'без имени', 'в офис', 'офис', 'продажа',
                           'продажа офис', 'склад', '-', '—'];
function removeJunkClients() {
    const before = clients.length;
    clients = clients.filter(c => {
        if ((c.phone || '').trim()) return true;            // есть телефон — оставляем
        const n = (c.name || '').trim().toLowerCase();
        const junk = JUNK_CLIENT_NAMES.includes(n) || n.length < 3;
        return !junk;                                       // нет имени и нет телефона — удаляем
    });
    console.log(`Удалено мусорных клиентов: ${before - clients.length}`);
}

// Загрузка всех строк таблицы с пагинацией (PostgREST отдаёт max 1000 за раз)
async function fetchAll(table, select = '*') {
    let all = [], from = 0; const size = 1000;
    while (true) {
        // is('deleted_at', null) — не грузим мягко удалённые записи
        const { data, error } = await SB.from(table).select(select)
            .is('deleted_at', null).range(from, from + size - 1);
        if (error) throw error;
        all = all.concat(data);
        if (data.length < size) break;
        from += size;
    }
    return all;
}

async function loadData() {
    await ensureAuthenticated();
    try {
        const [c, s, ordRaw, t, payouts, settings] = await Promise.all([
            fetchAll('clients'),
            fetchAll('suppliers'),
            fetchAll('orders', '*, order_items(*)'),
            fetchAll('transactions'),
            fetchAll('salary_payments').catch(() => []),
            fetchAll('app_settings').catch(() => []),
        ]);
        clients = c;
        suppliers = s;
        transactions = t.map(x => ({ ...x, amount: +x.amount }));
        salaryPayments = payouts.map(x => ({ ...x, amount: +x.amount }));
        appSettings = Object.fromEntries(settings.map(row => [row.id, row]));
        // Скрытые/добавленные вручную названия продукции
        try {
            const [{ data: hp }, { data: cp }] = await Promise.all([
                SB.from('product_hidden').select('name'),
                SB.from('product_custom').select('name, category'),
            ]);
            hiddenProducts = new Set((hp || []).map(r => r.name));
            customProducts = new Set((cp || []).map(r => r.name));
            customCatMap = new Map((cp || []).filter(r => r.category).map(r => [r.name, r.category]));
        } catch (e) { hiddenProducts = new Set(); customProducts = new Set(); customCatMap = new Map(); }
        // Разворачиваем вложенные order_items в o.items (с приведением чисел)
        orders = ordRaw.map(o => {
            const items = (o.order_items || []).map(i => ({
                product_name: i.product_name, dimensions: i.dimensions || '',
                supplier_id: i.supplier_id, quantity: +i.quantity,
                purchase_price: +i.purchase_price, sale_price: +i.sale_price,
            }));
            const { order_items, ...rest } = o;
            return { ...rest, items };
        });
        archiveOldOrders();
        console.log(`Загружено с сервера: ${orders.length} заказов, ${clients.length} клиентов, ${suppliers.length} поставщиков, ${transactions.length} транзакций`);
        const initial = location.hash.replace('#', '') || 'delivery';
        navigate(initial);
        renderNotifications();        // счётчик уведомлений в шапке
        subscribeRealtime();          // живая синхронизация: чужие правки видны сразу
    } catch (err) {
        console.error('Ошибка загрузки данных:', err);
        document.querySelector('.content').innerHTML = `
            <div style="padding:40px;text-align:center">
                <h2>Не удалось загрузить данные</h2>
                <p style="color:#dc2626">${err.message || err}</p>
                <p style="color:#64748b">Проверьте подключение к интернету и повторите вход.</p>
            </div>`;
    }
}

// ─── Realtime: живая синхронизация вкладок/пользователей ─────
// При изменении данных другим пользователем локальные массивы обновляются
// и активный раздел перерисовывается — без перезагрузки страницы.
function subscribeRealtime() {
    if (typeof SB.onRevision === 'function') {
        let refreshing = false;
        SB.onRevision(async () => {
            if (refreshing || document.hidden) return;
            refreshing = true;
            try {
                const [c, s, ordRaw, t, payouts, settings] = await Promise.all([
                    fetchAll('clients'), fetchAll('suppliers'),
                    fetchAll('orders', '*, order_items(*)'), fetchAll('transactions'),
                    fetchAll('salary_payments').catch(() => []),
                    fetchAll('app_settings').catch(() => []),
                ]);
                clients = c;
                suppliers = s;
                transactions = t.map(x => ({ ...x, amount: +x.amount }));
                salaryPayments = payouts.map(x => ({ ...x, amount: +x.amount }));
                appSettings = Object.fromEntries(settings.map(row => [row.id, row]));
                orders = ordRaw.map(o => {
                    const items = (o.order_items || []).map(i => ({
                        product_name: i.product_name, dimensions: i.dimensions || '',
                        supplier_id: i.supplier_id, quantity: +i.quantity,
                        purchase_price: +i.purchase_price, sale_price: +i.sale_price,
                    }));
                    const { order_items, ...rest } = o;
                    return { ...rest, items };
                });
                renderSection(location.hash.replace('#', '') || 'delivery');
                if (document.getElementById('modalOverlay')?.classList.contains('employees-open')) renderOlaSalary();
            } catch (e) { console.warn('sync', e); }
            finally { refreshing = false; }
        });
        return;
    }
    const tables = ['clients', 'suppliers', 'orders', 'transactions'];
    const map = () => ({ clients, suppliers, orders, transactions });
    tables.forEach(table => {
        SB.channel('rt_' + table)
            .on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
                try { applyRealtime(table, payload, map()); } catch (e) { console.warn('rt', e); }
            })
            .subscribe();
    });
}

function applyRealtime(table, payload, arrays) {
    const arr = arrays[table];
    if (!arr) return;
    const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
    if (!row) return;
    const idx = arr.findIndex(x => x.id === row.id);
    const isDeleted = payload.eventType === 'DELETE' || (payload.new && payload.new.deleted_at);

    if (isDeleted) {
        if (idx !== -1) arr.splice(idx, 1);
    } else if (payload.eventType === 'INSERT') {
        if (idx === -1) arr.push(table === 'orders' ? { ...payload.new, items: [] } : payload.new);
    } else if (payload.eventType === 'UPDATE') {
        if (idx !== -1) {
            if (table === 'orders') {
                const items = arr[idx].items;          // не затираем локальные позиции
                Object.assign(arr[idx], payload.new, { items });
            } else {
                Object.assign(arr[idx], payload.new);
            }
        }
    }
    rerenderActiveSection && rerenderActiveSection();
}

loadData();
