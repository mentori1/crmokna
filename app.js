/* ============================================================
   CRM Овсянников — Application
   ============================================================ */

// ─── Авторизация (для публичной демо-версии) ─────────────────
// Включается, только если в HTML присутствует #loginScreen.
// Хеш пары "логин:пароль" SHA-256 захардкожен ниже.
// Сменить можно так:
//   python3 -c "import hashlib; print(hashlib.sha256(b'НОВЫЙЛОГИН:НОВЫЙПАРОЛЬ').hexdigest())"
// и заменить значение AUTH_HASH.
const AUTH_HASH = 'eee74eb34dca056035c0c1552580a54bc90ac99eaa8f558a43df866e4544218b';
const AUTH_STORAGE_KEY = 'ovsyannikov_crm_auth_v1';

async function sha256(str) {
    const buf = new TextEncoder().encode(str);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ensureAuthenticated() {
    const loginEl = document.getElementById('loginScreen');
    if (!loginEl) return true;  // нет логин-экрана — авторизация не нужна
    // На localhost логин не нужен (твоя домашняя версия)
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') {
        loginEl.remove();
        return true;
    }
    // Уже залогинен?
    if (sessionStorage.getItem(AUTH_STORAGE_KEY) === AUTH_HASH) {
        loginEl.style.display = 'none';
        return true;
    }

    loginEl.style.display = 'flex';
    return new Promise(resolve => {
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const u = document.getElementById('loginUser').value.trim();
            const p = document.getElementById('loginPass').value;
            const h = await sha256(u + ':' + p);
            const errEl = document.getElementById('loginError');
            if (h === AUTH_HASH) {
                sessionStorage.setItem(AUTH_STORAGE_KEY, AUTH_HASH);
                loginEl.style.display = 'none';
                resolve(true);
            } else {
                errEl.textContent = 'Неверный логин или пароль';
                errEl.classList.add('show');
                document.getElementById('loginPass').value = '';
            }
        });
    });
}


const STATUS_LABELS = {
    new:                     'Новый',
    in_progress:             'В работе',
    ordered_from_supplier:   'Заказан у поставщика',
    received_at_warehouse:   'Получен на склад',
    delivering:              'Доставляется',
    delivered:               'Доставлен',
    closed:                  'Закрыт'
};

// Статусы доставки (раздел «Доставка»)
const DELIVERY_STATUS_LABELS = {
    none:             'Не назначен',
    car_going:        'Машина едет за грузом',
    shipped_supplier: 'Груз отгружен',
    at_warehouse:     'Груз на складе',
    sent_client:      'Отправлен клиенту',
    received:         'Получен клиентом'
};

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
    const txs = transactions.filter(t => t.order_id === o.id);
    const paidByClient = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const paidToSupplier = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    return { totalPurchase, totalSale, margin, paidByClient, paidToSupplier,
             clientDebt: totalSale - paidByClient, supplierDebt: totalPurchase - paidToSupplier };
}

let transactions = [];


// ─── Utility ─────────────────────────────────────────────────

const fmt = n => new Intl.NumberFormat('ru-RU').format(Math.round(n));
const fmtCur = n => fmt(n) + ' ₽';
const fmtDate = d => {
    if (!d) return '—';
    const parts = d.split('-');
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
};
const clientName = id => (clients.find(c => c.id === id) || {}).name || '—';
const clientPhone = id => (clients.find(c => c.id === id) || {}).phone || '';
const supplierName = id => (suppliers.find(s => s.id === id) || {}).name || '—';
const categoryName = id => (categories.find(c => c.id === id) || {}).name || '—';

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
    navItems.forEach(n => n.classList.toggle('active', n.dataset.section === sectionId));
    sections.forEach(s => s.classList.toggle('active', s.id === 'section-' + sectionId));
    if (location.hash !== '#' + sectionId) location.hash = sectionId;
    renderSection(sectionId);
    closeSidebarMobile();
}
window.addEventListener('hashchange', () => {
    const id = location.hash.replace('#', '') || 'dashboard';
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

// Кнопки периода на дашборде
document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        window.dashPeriod = btn.dataset.period;
        renderDashboard();
    });
});

// На телефоне: после выбора раздела прячем боковое меню
function closeSidebarMobile() {
    if (window.innerWidth <= 860) {
        document.getElementById('sidebar').classList.remove('open');
    }
}

function renderSection(id) {
    switch (id) {
        case 'dashboard':  renderDashboard(); break;
        case 'orders':     renderOrders(); break;
        case 'delivery':   renderDelivery(); break;
        case 'clients':    renderClients(); break;
        case 'suppliers':  renderSuppliers(); break;
        case 'finances':   renderFinances(); break;
        case 'warehouse':  renderWarehouse(); break;
    }
}


// ─── Dashboard ───────────────────────────────────────────────

let revenueChart, statusChart;

// Текущий выбранный период дашборда ('30'|'90'|'180'|'365'|'all')
window.dashPeriod = 'all';

const PERIOD_LABELS = { '30': 'за 30 дней', '90': 'за квартал', '180': 'за полгода', '365': 'за год', 'all': 'за всё время' };

// Граница периода: ISO-дата начала окна (или null для «всё время»)
function periodStartDate(period) {
    if (period === 'all') return null;
    const d = new Date();
    d.setDate(d.getDate() - parseInt(period, 10));
    return d.toISOString().slice(0, 10);
}

function renderDashboard() {
    const period = window.dashPeriod;
    const since = periodStartDate(period);
    const inPeriod = o => !since || (o.created_at && o.created_at >= since);
    const periodOrders = orders.filter(inPeriod);

    // Заказы/выручка/прибыль — за период; долги — текущие (остаток на сейчас, по всем заказам)
    let totalRevenue = 0, totalProfit = 0;
    periodOrders.forEach(o => {
        const c = calcOrder(o);
        totalRevenue += c.totalSale;
        totalProfit += c.margin;
    });
    let totalClientDebt = 0, totalSupplierDebt = 0;
    orders.forEach(o => {
        const c = calcOrder(o);
        totalClientDebt += Math.max(0, c.clientDebt);
        totalSupplierDebt += Math.max(0, c.supplierDebt);
    });
    const label = PERIOD_LABELS[period];

    document.getElementById('dashMetrics').innerHTML = `
        <div class="metric-card blue">
            <div class="metric-label">Заказов</div>
            <div class="metric-value">${periodOrders.length}</div>
            <div class="metric-sub">${label}</div>
        </div>
        <div class="metric-card green">
            <div class="metric-label">Выручка</div>
            <div class="metric-value">${fmtCur(totalRevenue)}</div>
            <div class="metric-sub">${label}</div>
        </div>
        <div class="metric-card cyan">
            <div class="metric-label">Прибыль</div>
            <div class="metric-value">${fmtCur(totalProfit)}</div>
            <div class="metric-sub">${label}</div>
        </div>
        <div class="metric-card amber">
            <div class="metric-label">Долг клиентов</div>
            <div class="metric-value">${fmtCur(totalClientDebt)}</div>
            <div class="metric-sub">текущий остаток</div>
        </div>
        <div class="metric-card red">
            <div class="metric-label">Долг поставщикам</div>
            <div class="metric-value">${fmtCur(totalSupplierDebt)}</div>
            <div class="metric-sub">текущий остаток</div>
        </div>
    `;

    const recent = [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5);
    document.getElementById('dashRecentOrders').innerHTML = `
        <table class="mini-table">
            <thead><tr><th>№</th><th>Клиент</th><th>Сумма</th><th>Статус</th></tr></thead>
            <tbody>${recent.map(o => {
                const c = calcOrder(o);
                return `<tr data-order="${o.id}" style="cursor:pointer">
                    <td class="td-bold">${o.order_number}</td>
                    <td>${clientName(o.client_id)}</td>
                    <td class="font-mono">${fmtCur(c.totalSale)}</td>
                    <td><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;

    document.getElementById('dashRecentOrders').querySelectorAll('tr[data-order]').forEach(tr => {
        tr.addEventListener('click', () => openOrderDetail(+tr.dataset.order));
    });

    const upcoming = orders
        .filter(o => !['closed','delivered'].includes(o.status) && o.delivery_date)
        .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date))
        .slice(0, 5);
    document.getElementById('dashUpcoming').innerHTML = upcoming.length ? `
        <table class="mini-table">
            <thead><tr><th>Доставка</th><th>Заказ</th><th>Клиент</th><th>Статус</th></tr></thead>
            <tbody>${upcoming.map(o => `
                <tr data-order="${o.id}" style="cursor:pointer">
                    <td class="td-bold">${fmtDate(o.delivery_date)}</td>
                    <td>${o.order_number}</td>
                    <td>${clientName(o.client_id)}</td>
                    <td><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></td>
                </tr>`).join('')}</tbody>
        </table>` : '<div class="empty-state">Нет запланированных доставок</div>';

    document.getElementById('dashUpcoming').querySelectorAll('tr[data-order]').forEach(tr => {
        tr.addEventListener('click', () => openOrderDetail(+tr.dataset.order));
    });

    renderCharts();
}

function renderCharts() {
    // Группируем заказы по месяцам и берём последние 12 месяцев с активностью
    const MONTH_NAMES = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
    const buckets = {};
    orders.forEach(o => {
        const m = o.created_at.slice(0, 7);
        if (!buckets[m]) buckets[m] = { rev: 0, prof: 0 };
        const c = calcOrder(o);
        buckets[m].rev += c.totalSale;
        buckets[m].prof += c.margin;
    });
    const months = Object.keys(buckets).sort().slice(-12);
    const monthLabels = months.map(m => {
        const [y, mm] = m.split('-');
        return `${MONTH_NAMES[+mm - 1]} ${y.slice(2)}`;
    });
    const revenueByMonth = months.map(m => buckets[m].rev);
    const profitByMonth  = months.map(m => buckets[m].prof);

    if (revenueChart) revenueChart.destroy();
    const ctx1 = document.getElementById('revenueChart').getContext('2d');
    revenueChart = new Chart(ctx1, {
        type: 'bar',
        data: {
            labels: monthLabels,
            datasets: [
                { label: 'Выручка', data: revenueByMonth, backgroundColor: '#3b82f6', borderRadius: 4 },
                { label: 'Прибыль', data: profitByMonth, backgroundColor: '#22c55e', borderRadius: 4 },
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { font: { size: 12 } } } },
            scales: {
                y: { ticks: { callback: v => fmt(v) + ' ₽' }, grid: { color: '#f1f5f9' } },
                x: { grid: { display: false } }
            }
        }
    });

    const statusCounts = {};
    Object.keys(STATUS_LABELS).forEach(s => statusCounts[s] = 0);
    orders.forEach(o => statusCounts[o.status]++);
    const statusColors = {
        new: '#3b82f6', in_progress: '#f59e0b', ordered_from_supplier: '#a855f7',
        received_at_warehouse: '#06b6d4', delivering: '#f97316', delivered: '#22c55e', closed: '#94a3b8'
    };

    if (statusChart) statusChart.destroy();
    const ctx2 = document.getElementById('statusChart').getContext('2d');
    statusChart = new Chart(ctx2, {
        type: 'doughnut',
        data: {
            labels: Object.values(STATUS_LABELS),
            datasets: [{
                data: Object.values(statusCounts),
                backgroundColor: Object.keys(STATUS_LABELS).map(s => statusColors[s]),
                borderWidth: 0, spacing: 2
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '60%',
            plugins: {
                legend: { position: 'right', labels: { font: { size: 12 }, padding: 12, usePointStyle: true, pointStyleWidth: 10 } }
            }
        }
    });
}


// ─── Orders ──────────────────────────────────────────────────

window.ordersPage = 1;
const ORDERS_PER_PAGE = 50;

function renderOrders() {
    const status = document.getElementById('filterStatus').value;
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo = document.getElementById('filterDateTo').value;

    let filtered = orders;
    if (status) filtered = filtered.filter(o => o.status === status);
    if (dateFrom) filtered = filtered.filter(o => o.created_at >= dateFrom);
    if (dateTo) filtered = filtered.filter(o => o.created_at <= dateTo);

    filtered = filtered.sort((a, b) => b.created_at.localeCompare(a.created_at));

    const totalPages = Math.max(1, Math.ceil(filtered.length / ORDERS_PER_PAGE));
    if (window.ordersPage > totalPages) window.ordersPage = 1;
    const start = (window.ordersPage - 1) * ORDERS_PER_PAGE;
    const pageRows = filtered.slice(start, start + ORDERS_PER_PAGE);

    document.getElementById('ordersBody').innerHTML = pageRows.length ? pageRows.map(o => {
        const c = calcOrder(o);
        return `<tr data-order="${o.id}">
            <td class="td-bold">${o.order_number}</td>
            <td>${fmtDate(o.created_at)}</td>
            <td>${clientName(o.client_id)}<br><span class="text-muted" style="font-size:12px">${clientPhone(o.client_id)}</span></td>
            <td class="font-mono text-right">${fmtCur(c.totalSale)}</td>
            <td class="font-mono text-right">${fmtCur(c.paidByClient)}</td>
            <td class="font-mono text-right ${c.margin > 0 ? 'text-green' : ''}">${fmtCur(c.margin)}</td>
            <td><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></td>
            <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openOrderDetail(${o.id})">Открыть</button></td>
        </tr>`;
    }).join('') : '<tr><td colspan="8" class="empty-state">Нет заказов</td></tr>';

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
        tr.addEventListener('click', () => openOrderDetail(+tr.dataset.order));
    });
}
// Сбрасываем страницу при изменении фильтров
['filterStatus','filterDateFrom','filterDateTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { window.ordersPage = 1; });
});

document.getElementById('filterStatus').addEventListener('change', renderOrders);
document.getElementById('filterDateFrom').addEventListener('change', renderOrders);
document.getElementById('filterDateTo').addEventListener('change', renderOrders);


// ─── Delivery ────────────────────────────────────────────────

function renderDelivery() {
    // Открытые заказы = ещё не закрытые
    const openOrders = orders.filter(o => o.status !== 'closed');
    const filter = document.getElementById('filterDeliveryStatus').value;

    let rows = openOrders;
    if (filter) {
        rows = rows.filter(o => (o.delivery_status || 'none') === filter);
    }
    rows = rows.sort((a, b) => b.created_at.localeCompare(a.created_at));

    // Метрики по статусам доставки
    const counts = { none: 0, car_going: 0, shipped_supplier: 0, at_warehouse: 0, sent_client: 0, received: 0 };
    openOrders.forEach(o => { counts[o.delivery_status || 'none']++; });
    document.getElementById('deliveryMetrics').innerHTML = `
        <div class="metric-card blue">
            <div class="metric-label">Открытых заказов</div>
            <div class="metric-value">${openOrders.length}</div>
        </div>
        <div class="metric-card amber">
            <div class="metric-label">В пути / отгружено</div>
            <div class="metric-value">${counts.car_going + counts.shipped_supplier}</div>
        </div>
        <div class="metric-card cyan">
            <div class="metric-label">На складе</div>
            <div class="metric-value">${counts.at_warehouse}</div>
        </div>
        <div class="metric-card green">
            <div class="metric-label">Отправлено клиенту</div>
            <div class="metric-value">${counts.sent_client + counts.received}</div>
        </div>
    `;

    document.getElementById('deliveryBody').innerHTML = rows.length ? rows.map(o => {
        const ds = o.delivery_status || 'none';
        const product = o.items.map(i => i.product_name).join(', ');
        const supplierIds = [...new Set(o.items.map(i => i.supplier_id).filter(Boolean))];
        return `<tr data-order="${o.id}" style="cursor:pointer">
            <td class="td-bold">${o.order_number}</td>
            <td>${fmtDate(o.created_at)}</td>
            <td>${clientName(o.client_id)}<br><span class="text-muted" style="font-size:12px">${clientPhone(o.client_id)}</span></td>
            <td>${product}</td>
            <td>${supplierIds.map(supplierName).join(', ') || '—'}</td>
            <td><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></td>
            <td>
                <select class="delivery-select" data-order="${o.id}" onclick="event.stopPropagation()">
                    ${Object.entries(DELIVERY_STATUS_LABELS).map(([k, v]) =>
                        `<option value="${k}" ${ds === k ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
            </td>
        </tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-state">Нет открытых заказов</td></tr>';

    // Клик по строке — открыть карточку заказа
    document.querySelectorAll('#deliveryBody tr[data-order]').forEach(tr => {
        tr.addEventListener('click', () => openOrderDetail(+tr.dataset.order));
    });

    document.querySelectorAll('.delivery-select').forEach(sel => {
        sel.addEventListener('change', (e) => {
            e.stopPropagation();
            const o = orders.find(x => x.id === +sel.dataset.order);
            if (o) o.delivery_status = sel.value === 'none' ? null : sel.value;
            renderDelivery();
        });
    });
}

document.getElementById('filterDeliveryStatus').addEventListener('change', renderDelivery);


// ─── Order Detail Modal ──────────────────────────────────────

function openOrderDetail(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const c = calcOrder(o);
    const client = clients.find(x => x.id === o.client_id) || {};
    const supplierIds = [...new Set(o.items.map(i => i.supplier_id))];

    openModal('Заказ ' + o.order_number, `
        <div class="detail-grid">
            <div class="detail-item">
                <div class="detail-label">Дата создания</div>
                <div class="detail-value">${fmtDate(o.created_at)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Дата доставки</div>
                <div class="detail-value">${fmtDate(o.delivery_date)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Клиент</div>
                <div class="detail-value">${client.name || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Телефон</div>
                <div class="detail-value">${client.phone || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Поставщик(и)</div>
                <div class="detail-value">${supplierIds.map(supplierName).join(', ')}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Статус</div>
                <div class="detail-value"><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></div>
            </div>
        </div>

        <div class="detail-section-title">Товары</div>
        <table class="items-table">
            <thead><tr><th>Наименование</th><th>Кол-во</th><th>Закупка</th><th>Продажа</th><th>Итого</th></tr></thead>
            <tbody>${o.items.map(i => `
                <tr>
                    <td>${i.product_name}${i.dimensions ? `<br><span class="text-muted" style="font-size:12px">📐 ${i.dimensions}</span>` : ''}</td>
                    <td class="font-mono">${i.quantity}</td>
                    <td class="font-mono">${fmtCur(i.purchase_price)}</td>
                    <td class="font-mono">${fmtCur(i.sale_price)}</td>
                    <td class="font-mono td-bold">${fmtCur(i.sale_price * i.quantity)}</td>
                </tr>`).join('')}
                <tr style="font-weight:600;border-top:2px solid var(--slate-200)">
                    <td colspan="2">Итого</td>
                    <td class="font-mono">${fmtCur(c.totalPurchase)}</td>
                    <td></td>
                    <td class="font-mono">${fmtCur(c.totalSale)}</td>
                </tr>
            </tbody>
        </table>

        <div class="detail-section-title">Финансы</div>
        <div class="detail-grid">
            <div class="detail-item">
                <div class="detail-label">Закупочная цена</div>
                <div class="detail-value">${fmtCur(c.totalPurchase)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Цена продажи</div>
                <div class="detail-value">${fmtCur(c.totalSale)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Маржа (продажа − закупка)</div>
                <div class="detail-value big ${c.margin >= 0 ? 'text-green' : 'text-red'}">${fmtCur(c.margin)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Маржинальность</div>
                <div class="detail-value big">${c.totalSale > 0 ? Math.round(c.margin / c.totalSale * 100) : 0}%</div>
            </div>
        </div>

        <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
                <span>Оплата клиентом: <b>${fmtCur(c.paidByClient)}</b> из ${fmtCur(c.totalSale)}</span>
                <span class="${c.clientDebt > 0 ? 'text-red' : 'text-green'}">${c.clientDebt > 0 ? 'Долг: ' + fmtCur(c.clientDebt) : 'Оплачено'}</span>
            </div>
            ${paymentBar(c.paidByClient, c.totalSale)}
        </div>

        <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
                <span>Оплачено поставщику: <b>${fmtCur(c.paidToSupplier)}</b> из ${fmtCur(c.totalPurchase)}</span>
                <span class="${c.supplierDebt > 0 ? 'text-red' : 'text-green'}">${c.supplierDebt > 0 ? 'Долг: ' + fmtCur(c.supplierDebt) : 'Оплачено'}</span>
            </div>
            ${paymentBar(c.paidToSupplier, c.totalPurchase)}
        </div>

        <div class="detail-section-title">Добавить платёж</div>
        <div class="payment-form">
            <div class="form-group">
                <label>Сумма ₽</label>
                <input type="number" id="paymentAmount" placeholder="10 000" min="0" step="any">
            </div>
            <div class="form-group">
                <label>Тип</label>
                <select id="paymentType">
                    <option value="income">Оплата от клиента</option>
                    <option value="expense">Оплата поставщику</option>
                </select>
            </div>
            <div class="form-group">
                <label>Описание</label>
                <input type="text" id="paymentDesc" placeholder="Предоплата / остаток / и т.д.">
            </div>
            <button class="btn btn-primary payment-submit" onclick="addPayment(${o.id})">+ Добавить платёж</button>
        </div>

        <div class="form-actions" style="margin-top:24px">
            <button class="btn btn-outline" onclick="openOrderEditForm(${o.id})" style="margin-right:auto">✏ Редактировать</button>
            <select id="modalStatusSelect" style="padding:8px 12px;border:1px solid var(--slate-300);border-radius:6px;font-size:13px">
                ${Object.entries(STATUS_LABELS).map(([k,v]) => `<option value="${k}" ${o.status===k?'selected':''}>${v}</option>`).join('')}
            </select>
            <button class="btn btn-success" onclick="changeOrderStatus(${o.id})">Сохранить статус</button>
        </div>
    `);
}

// Редактирование существующего заказа: ФИО клиента, телефон, продукция, поставщик
window.openOrderEditForm = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const client = clients.find(x => x.id === o.client_id) || {};
    const productNames = [...new Set(orders.flatMap(ord => ord.items.map(i => i.product_name)).filter(Boolean))].slice(0, 500);
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
                <input type="text" id="editClientPhone" value="${(client.phone||'').replace(/"/g,'&quot;')}" placeholder="+7 (___) ___-__-__">
            </div>
            <div class="form-group">
                <label>Дата создания</label>
                <input type="date" id="editCreatedDate" value="${o.created_at || ''}">
            </div>
            <div class="form-group">
                <label>Дата доставки</label>
                <input type="date" id="editDeliveryDate" value="${o.delivery_date || ''}">
            </div>
        </div>

        <div class="detail-section-title">Продукция</div>
        <div id="editItemsContainer">
            ${o.items.map(i => orderItemRowHTML(i)).join('')}
        </div>
        <button class="btn btn-sm btn-outline" onclick="document.getElementById('editItemsContainer').insertAdjacentHTML('beforeend', orderItemRowHTML())" style="margin-top:4px">+ Добавить позицию</button>

        <div class="form-grid" style="margin-top:16px">
            <div class="form-group">
                <label>Поставщик</label>
                <input type="text" id="editSupplier" list="suppliersList" value="${curSupplier.replace(/"/g,'&quot;')}" autocomplete="off">
            </div>
            <div class="form-group">
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
    if (cl && phone) cl.phone = phone;
    o.items = items;
    o.created_at = document.getElementById('editCreatedDate').value || o.created_at;
    o.delivery_date = document.getElementById('editDeliveryDate').value || null;
    o.notes = document.getElementById('editNotes').value.trim();

    openOrderDetail(o.id);
    // обновим таблицу под модалкой
    const active = document.querySelector('.nav-item.active');
    if (active) renderSection(active.dataset.section);
};

window.changeOrderStatus = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const sel = document.getElementById('modalStatusSelect');
    if (sel) { o.status = sel.value; }
    closeModal();
    renderSection(document.querySelector('.nav-item.active').dataset.section);
};

// Перерисовать активную секцию (после любого изменения данных).
// Используется чтобы все разделы синхронно отражали новые заказы/платежи.
function rerenderActiveSection() {
    const active = document.querySelector('.nav-item.active');
    if (active) renderSection(active.dataset.section);
}

// Добавить платёж (от клиента или поставщику) к заказу
window.addPayment = function(orderId) {
    const o = orders.find(x => x.id === orderId);
    if (!o) return;
    const amount = parseFloat(document.getElementById('paymentAmount').value);
    if (!amount || amount <= 0) { alert('Укажите сумму платежа'); return; }
    const type = document.getElementById('paymentType').value;
    const desc = document.getElementById('paymentDesc').value.trim() || (type === 'income' ? 'Оплата от клиента' : 'Оплата поставщику');
    const supplierId = o.items.find(i => i.supplier_id)?.supplier_id;

    const newId = transactions.length ? Math.max(...transactions.map(t => t.id)) + 1 : 1;
    transactions.push({
        id: newId,
        date: new Date().toISOString().slice(0, 10),
        type: type,
        entity_type: type === 'income' ? 'client' : 'supplier',
        entity_id: type === 'income' ? o.client_id : (supplierId || o.client_id),
        order_id: o.id,
        amount: amount,
        description: desc,
    });
    // Перерисовываем карточку (текущая модалка) И активную секцию под ней (Дашборд / Заказы / Финансы / Клиенты / Поставщики)
    openOrderDetail(o.id);
    rerenderActiveSection();
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
            <td class="td-bold">${cl.name}</td>
            <td>${cl.phone}</td>
            <td class="font-mono">${cl.orderCount}</td>
            <td class="font-mono text-right">${fmtCur(cl.totalPurchases)}</td>
            <td class="font-mono text-right ${cl.totalDebt > 0 ? 'text-red' : ''}">${cl.totalDebt > 0 ? fmtCur(cl.totalDebt) : '—'}</td>
            <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openClientDetail(${cl.id})">Карточка</button></td>
        </tr>`).join('');

    document.querySelectorAll('#clientsBody tr[data-client]').forEach(tr => {
        tr.addEventListener('click', () => openClientDetail(+tr.dataset.client));
    });
}

window.openClientDetail = function(clientId) {
    const cl = clients.find(x => x.id === clientId);
    if (!cl) return;
    const cOrders = orders.filter(o => o.client_id === cl.id);
    const totalPurchases = cOrders.reduce((s, o) => s + calcOrder(o).totalSale, 0);
    const totalDebt = cOrders.reduce((s, o) => s + Math.max(0, calcOrder(o).clientDebt), 0);

    openModal('Клиент: ' + cl.name, `
        <div class="detail-grid">
            <div class="detail-item">
                <div class="detail-label">Телефон</div>
                <div class="detail-value">${cl.phone}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Email</div>
                <div class="detail-value">${cl.email || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Адрес</div>
                <div class="detail-value">${cl.address || '—'}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Заказов</div>
                <div class="detail-value big">${cOrders.length}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Сумма покупок</div>
                <div class="detail-value big">${fmtCur(totalPurchases)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Задолженность</div>
                <div class="detail-value big ${totalDebt > 0 ? 'text-red' : 'text-green'}">${totalDebt > 0 ? fmtCur(totalDebt) : 'Нет'}</div>
            </div>
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
                    <td><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></td>
                </tr>`;
            }).join('') : '<tr><td colspan="5" class="empty-state">Нет заказов</td></tr>'}</tbody>
        </table>
    `);
};


// ─── Suppliers ───────────────────────────────────────────────

function renderSuppliers() {
    const rows = suppliers.map(s => {
        const sOrders = orders.filter(o => o.items.some(i => i.supplier_id === s.id));
        const totalPurchases = sOrders.reduce((sum, o) => {
            return sum + o.items.filter(i => i.supplier_id === s.id).reduce((s2, i) => s2 + i.purchase_price * i.quantity, 0);
        }, 0);
        const paid = transactions.filter(t => t.entity_type === 'supplier' && t.entity_id === s.id).reduce((s2, t) => s2 + t.amount, 0);
        return { ...s, orderCount: sOrders.length, totalPurchases, debt: Math.max(0, totalPurchases - paid) };
    });

    document.getElementById('suppliersBody').innerHTML = rows.map(s => `
        <tr data-supplier="${s.id}">
            <td class="td-bold">${s.name}</td>
            <td>${s.contact_person || '—'}</td>
            <td>${s.phone}</td>
            <td class="font-mono">${s.orderCount}</td>
            <td class="font-mono text-right">${fmtCur(s.totalPurchases)}</td>
            <td class="font-mono text-right ${s.debt > 0 ? 'text-red' : ''}">${s.debt > 0 ? fmtCur(s.debt) : '—'}</td>
            <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation();openSupplierDetail(${s.id})">Карточка</button></td>
        </tr>`).join('');

    document.querySelectorAll('#suppliersBody tr[data-supplier]').forEach(tr => {
        tr.addEventListener('click', () => openSupplierDetail(+tr.dataset.supplier));
    });
}

window.openSupplierDetail = function(supplierId) {
    const s = suppliers.find(x => x.id === supplierId);
    if (!s) return;
    const sOrders = orders.filter(o => o.items.some(i => i.supplier_id === s.id));
    const totalPurchases = sOrders.reduce((sum, o) => {
        return sum + o.items.filter(i => i.supplier_id === s.id).reduce((s2, i) => s2 + i.purchase_price * i.quantity, 0);
    }, 0);
    const paid = transactions.filter(t => t.entity_type === 'supplier' && t.entity_id === s.id).reduce((s2, t) => s2 + t.amount, 0);
    const debt = Math.max(0, totalPurchases - paid);

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
                    <td><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></td>
                </tr>`;
            }).join('')}</tbody>
        </table>
    `);
};


// ─── Finances ────────────────────────────────────────────────

function renderFinances() {
    const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const totalExpense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

    let totalClientDebt = 0, totalSupplierDebt = 0, totalRevenue = 0, totalProfit = 0;
    orders.forEach(o => {
        const c = calcOrder(o);
        totalRevenue += c.totalSale;
        totalProfit += c.margin;
        totalClientDebt += Math.max(0, c.clientDebt);
        totalSupplierDebt += Math.max(0, c.supplierDebt);
    });

    document.getElementById('financeMetrics').innerHTML = `
        <div class="metric-card green">
            <div class="metric-label">Выручка</div>
            <div class="metric-value">${fmtCur(totalRevenue)}</div>
        </div>
        <div class="metric-card cyan">
            <div class="metric-label">Прибыль (маржа)</div>
            <div class="metric-value">${fmtCur(totalProfit)}</div>
        </div>
        <div class="metric-card amber">
            <div class="metric-label">Дебиторская задолж.</div>
            <div class="metric-value">${fmtCur(totalClientDebt)}</div>
            <div class="metric-sub">должны нам клиенты</div>
        </div>
        <div class="metric-card red">
            <div class="metric-label">Кредиторская задолж.</div>
            <div class="metric-value">${fmtCur(totalSupplierDebt)}</div>
            <div class="metric-sub">мы должны поставщикам</div>
        </div>
    `;

    const txType = document.getElementById('filterTxType').value;
    const txFrom = document.getElementById('filterTxFrom').value;
    const txTo = document.getElementById('filterTxTo').value;

    let filtered = [...transactions];
    if (txType) filtered = filtered.filter(t => t.type === txType);
    if (txFrom) filtered = filtered.filter(t => t.date >= txFrom);
    if (txTo) filtered = filtered.filter(t => t.date <= txTo);
    filtered.sort((a, b) => b.date.localeCompare(a.date));

    document.getElementById('financeBody').innerHTML = filtered.length ? filtered.map(t => {
        const orderNum = t.order_id ? (orders.find(o => o.id === t.order_id) || {}).order_number || '' : '';
        return `<tr>
            <td>${fmtDate(t.date)}</td>
            <td><span class="badge badge-${t.type}">${t.type === 'income' ? 'Приход' : 'Расход'}</span></td>
            <td>${entityName(t.entity_type, t.entity_id)}</td>
            <td class="td-bold">${orderNum}</td>
            <td class="font-mono text-right text-green">${t.type === 'income' ? fmtCur(t.amount) : ''}</td>
            <td class="font-mono text-right text-red">${t.type === 'expense' ? fmtCur(t.amount) : ''}</td>
            <td class="text-muted">${t.description}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-state">Нет операций</td></tr>';
}

document.getElementById('filterTxType').addEventListener('change', renderFinances);
document.getElementById('filterTxFrom').addEventListener('change', renderFinances);
document.getElementById('filterTxTo').addEventListener('change', renderFinances);

// Кнопка «+ Операция» в Финансах
document.getElementById('btnNewTransaction').addEventListener('click', () => {
    const allClients = clients.map(c => `<option value="client:${c.id}">${c.name}</option>`).join('');
    const allSuppliers = suppliers.map(s => `<option value="supplier:${s.id}">${s.name}</option>`).join('');
    openModal('Новая финансовая операция', `
        <div class="form-grid">
            <div class="form-group">
                <label>Тип операции</label>
                <select id="txFormType">
                    <option value="income">Приход (от клиента)</option>
                    <option value="expense">Расход (поставщику)</option>
                </select>
            </div>
            <div class="form-group">
                <label>Дата</label>
                <input type="date" id="txFormDate" value="${new Date().toISOString().slice(0,10)}">
            </div>
            <div class="form-group">
                <label>Контрагент</label>
                <select id="txFormEntity">
                    <optgroup label="Клиенты">${allClients}</optgroup>
                    <optgroup label="Поставщики">${allSuppliers}</optgroup>
                </select>
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

window.saveNewTransaction = function() {
    const amount = parseFloat(document.getElementById('txFormAmount').value);
    if (!amount || amount <= 0) { alert('Укажите сумму'); return; }
    const type = document.getElementById('txFormType').value;
    const [entityType, entityId] = document.getElementById('txFormEntity').value.split(':');
    const newId = transactions.length ? Math.max(...transactions.map(t => t.id)) + 1 : 1;
    transactions.push({
        id: newId,
        date: document.getElementById('txFormDate').value || new Date().toISOString().slice(0, 10),
        type: type,
        entity_type: entityType,
        entity_id: +entityId,
        order_id: null,
        amount: amount,
        description: document.getElementById('txFormDesc').value.trim() || '',
    });
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
            <td class="td-bold">${p.sku || '—'}</td>
            <td>${p.name || '—'}</td>
            <td>${categoryName(p.category_id)}</td>
            <td class="font-mono">${ws.quantity} ${p.unit || ''}</td>
            <td class="font-mono">${ws.reserved}</td>
            <td class="font-mono ${isLow ? 'low-stock' : ''}">${available} ${isLow ? '⚠' : ''}</td>
            <td class="font-mono text-right">${fmtCur(p.purchase_price)}</td>
            <td class="font-mono text-right">${fmtCur(p.sale_price)}</td>
            <td><button class="btn btn-sm btn-outline" onclick="openProductDetail(${p.id})">Детали</button></td>
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

searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) { searchDropdown.classList.remove('open'); return; }

    let html = '';

    const matchedOrders = orders.filter(o =>
        o.order_number.toLowerCase().includes(q) ||
        clientName(o.client_id).toLowerCase().includes(q) ||
        clientPhone(o.client_id).replace(/\D/g, '').includes(q.replace(/\D/g, ''))
    ).slice(0, 5);
    if (matchedOrders.length) {
        html += '<div class="search-group-title">Заказы</div>';
        matchedOrders.forEach(o => {
            html += `<div class="search-item" data-action="order" data-id="${o.id}">
                <span class="search-item-icon">📋</span>
                <span class="search-item-main">${o.order_number} — ${clientName(o.client_id)}</span>
                <span class="search-item-sub"><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></span>
            </div>`;
        });
    }

    const matchedClients = clients.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.phone.replace(/\D/g, '').includes(q.replace(/\D/g, ''))
    ).slice(0, 5);
    if (matchedClients.length) {
        html += '<div class="search-group-title">Клиенты</div>';
        matchedClients.forEach(c => {
            html += `<div class="search-item" data-action="client" data-id="${c.id}">
                <span class="search-item-icon">👤</span>
                <span class="search-item-main">${c.name}</span>
                <span class="search-item-sub">${c.phone}</span>
            </div>`;
        });
    }

    const matchedProducts = products.filter(p =>
        p.name.toLowerCase().includes(q) || (p.sku && p.sku.toLowerCase().includes(q))
    ).slice(0, 5);
    if (matchedProducts.length) {
        html += '<div class="search-group-title">Товары</div>';
        matchedProducts.forEach(p => {
            html += `<div class="search-item" data-action="product" data-id="${p.id}">
                <span class="search-item-icon">📦</span>
                <span class="search-item-main">${p.name}</span>
                <span class="search-item-sub">${p.sku}</span>
            </div>`;
        });
    }

    const matchedSuppliers = suppliers.filter(s =>
        s.name.toLowerCase().includes(q) || (s.contact_person && s.contact_person.toLowerCase().includes(q))
    ).slice(0, 3);
    if (matchedSuppliers.length) {
        html += '<div class="search-group-title">Поставщики</div>';
        matchedSuppliers.forEach(s => {
            html += `<div class="search-item" data-action="supplier" data-id="${s.id}">
                <span class="search-item-icon">🏭</span>
                <span class="search-item-main">${s.name}</span>
                <span class="search-item-sub">${s.phone}</span>
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
            if (action === 'product') { navigate('warehouse'); openProductDetail(id); }
            if (action === 'supplier') openSupplierDetail(id);
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
    const productNames = [...new Set(orders.flatMap(o => o.items.map(i => i.product_name)).filter(Boolean))].slice(0, 500);
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
                <input type="text" id="formClientPhone" placeholder="+7 (___) ___-__-__">
            </div>
            <div class="form-group">
                <label>Дата создания</label>
                <input type="date" id="formCreatedDate" value="${new Date().toISOString().slice(0,10)}">
            </div>
            <div class="form-group">
                <label>Дата доставки</label>
                <input type="date" id="formDeliveryDate">
            </div>
            <div class="form-group full">
                <label>Адрес доставки</label>
                <input type="text" id="formDeliveryAddr" placeholder="ул. Ленина, 10">
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

// Найти существующего клиента по имени (без учёта регистра) или создать нового
function findOrCreateClient(name, phone) {
    const norm = name.trim().toLowerCase();
    let cl = clients.find(c => c.name.trim().toLowerCase() === norm);
    if (cl) {
        if (phone && !cl.phone) cl.phone = phone;  // дополним телефон, если не был указан
        return cl.id;
    }
    const newId = clients.length ? Math.max(...clients.map(c => c.id)) + 1 : 1;
    clients.push({ id: newId, name: name.trim(), phone: phone || '', email: '', address: '',
                   created_at: new Date().toISOString().slice(0, 10) });
    return newId;
}

// Найти поставщика по названию или создать нового
function findOrCreateSupplier(name) {
    if (!name || !name.trim()) return null;
    const norm = name.trim().toLowerCase();
    let s = suppliers.find(x => x.name.trim().toLowerCase() === norm);
    if (s) return s.id;
    const newId = suppliers.length ? Math.max(...suppliers.map(x => x.id)) + 1 : 1;
    suppliers.push({ id: newId, name: name.trim(), contact_person: '', phone: '', email: '' });
    return newId;
}

window.saveNewOrder = function() {
    const clientName = document.getElementById('formClientName').value.trim();
    const clientPhone = document.getElementById('formClientPhone').value.trim();
    if (!clientName) { alert('Укажите ФИО клиента'); return; }

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

    const clientId = findOrCreateClient(clientName, clientPhone);
    const newId = orders.length ? Math.max(...orders.map(o => o.id)) + 1 : 1;
    const deliveryDate = document.getElementById('formDeliveryDate').value || null;

    orders.push({
        id: newId,
        order_number: 'ЗК-' + String(newId).padStart(3, '0'),
        client_id: clientId,
        status: 'new',
        delivery_status: null,
        created_at: document.getElementById('formCreatedDate').value || new Date().toISOString().slice(0, 10),
        delivery_date: deliveryDate,
        notes: document.getElementById('formNotes').value.trim(),
        items: items,
    });

    closeModal();
    navigate('orders');
};

document.getElementById('btnNewOrder').addEventListener('click', openNewOrderForm);
document.getElementById('btnNewOrder2').addEventListener('click', openNewOrderForm);


// ─── Modal management ────────────────────────────────────────

function openModal(title, bodyHTML) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHTML;
    document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
});


// ─── Init ────────────────────────────────────────────────────

async function loadData() {
    // Сначала спрашиваем логин/пароль (если есть #loginScreen)
    await ensureAuthenticated();
    try {
        const [c, s, o, t] = await Promise.all([
            fetch('data/clients.json').then(r => r.json()),
            fetch('data/suppliers.json').then(r => r.json()),
            fetch('data/orders.json').then(r => r.json()),
            fetch('data/transactions.json').then(r => r.json()),
        ]);
        clients = c;
        suppliers = s;
        orders = o;
        transactions = t;
        console.log(`Загружено: ${orders.length} заказов, ${clients.length} клиентов, ${suppliers.length} поставщиков, ${transactions.length} транзакций`);
        const initial = location.hash.replace('#', '') || 'dashboard';
        navigate(initial);
    } catch (err) {
        console.error('Ошибка загрузки данных:', err);
        document.querySelector('.content').innerHTML = `
            <div style="padding:40px;text-align:center">
                <h2>Не удалось загрузить данные</h2>
                <p style="color:#dc2626">${err.message}</p>
                <p style="color:#64748b">Запустите парсер: <code>python3 import/parse_csv.py</code></p>
            </div>`;
    }
}

loadData();
