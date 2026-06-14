// ==============================
// Configuração e estado global
// ==============================

const STORAGE_KEY_API_URL = 'well_container_monitor_api_url';
const STORAGE_KEY_INTERVAL = 'well_container_monitor_interval';
const STORAGE_KEY_GRAFANA_URL = 'well_container_monitor_grafana_url';
const STORAGE_KEY_PROMETHEUS_URL = 'well_container_monitor_prometheus_url';

const GRAFANA_DASHBOARD_PATH = '/d/docker-host-overview/docker-services-overview?orgId=1&theme=dark&kiosk';

function getApiBaseUrl() {
    const saved = localStorage.getItem(STORAGE_KEY_API_URL);
    if (saved) return saved.replace(/\/$/, '');
    return `${window.location.protocol}//${window.location.hostname}:5050`;
}

function getGrafanaBaseUrl() {
    const saved = localStorage.getItem(STORAGE_KEY_GRAFANA_URL);
    if (saved) return saved.replace(/\/$/, '');
    return `${window.location.protocol}//${window.location.hostname}:3000`;
}

function getPrometheusBaseUrl() {
    const saved = localStorage.getItem(STORAGE_KEY_PROMETHEUS_URL);
    if (saved) return saved.replace(/\/$/, '');
    return `${window.location.protocol}//${window.location.hostname}:9090`;
}

let API_BASE = getApiBaseUrl();

let containers = [];
let summary = {};
let images = [];
let selectedContainerId = null;
let socket = null;

let terminalInstance = null;
let terminalFitAddon = null;

const DESTRUCTIVE_ACTIONS = {
    stop: 'parar',
    restart: 'reiniciar',
    pause: 'pausar',
};

// ==============================
// Utilitários
// ==============================

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDateTime(isoString) {
    if (!isoString) return '-';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('pt-BR');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 4000);
}

function confirmarAcao(mensagem, titulo = 'Confirmar ação') {
    return new Promise(resolve => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        if (!modal || !okBtn || !cancelBtn) {
            resolve(window.confirm(mensagem));
            return;
        }

        titleEl.textContent = titulo;
        messageEl.textContent = mensagem;
        modal.classList.remove('hidden');

        function limpar(resultado) {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', onConfirmar);
            cancelBtn.removeEventListener('click', onCancelar);
            resolve(resultado);
        }

        function onConfirmar() { limpar(true); }
        function onCancelar() { limpar(false); }

        okBtn.addEventListener('click', onConfirmar);
        cancelBtn.addEventListener('click', onCancelar);
    });
}

const STATUS_LABELS = {
    running: 'Running',
    exited: 'Exited',
    restarting: 'Restarting',
    paused: 'Paused',
    created: 'Created',
    dead: 'Dead',
};

const HEALTH_LABELS = {
    healthy: 'Healthy',
    unhealthy: 'Unhealthy',
    starting: 'Starting',
    none: 'Sem healthcheck',
};

function statusBadge(status) {
    const label = STATUS_LABELS[status] || status;
    return `<span class="badge badge-${status}"><i class="fas fa-circle"></i>${escapeHtml(label)}</span>`;
}

function healthBadge(health) {
    const status = health && health.status ? health.status : 'none';
    const label = HEALTH_LABELS[status] || status;
    return `<span class="badge badge-${status}"><i class="fas fa-circle"></i>${escapeHtml(label)}</span>`;
}

function statusDot(status) {
    return `<span class="status-dot ${status}" title="${escapeHtml(STATUS_LABELS[status] || status)}"></span>`;
}

function miniBar(percent) {
    const value = Math.min(100, Math.max(0, percent || 0));
    let cls = '';
    if (value >= 85) cls = 'high';
    else if (value >= 60) cls = 'medium';
    return `<span class="mini-bar"><span class="mini-bar-fill ${cls}" style="width:${value}%"></span></span>${value.toFixed(1)}%`;
}

// ==============================
// Navegação entre páginas
// ==============================

function inicializarNavegacao() {
    const navItems = document.querySelectorAll('.nav-item');
    const pages = document.querySelectorAll('.page');
    const pageTitle = document.getElementById('page-title');

    const titles = {
        dashboard: 'Dashboard',
        containers: 'Containers',
        logs: 'Logs',
        images: 'Imagens',
        metrics: 'Métricas Históricas',
        settings: 'Configurações',
    };

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const target = item.dataset.page;

            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            pages.forEach(p => p.classList.remove('active'));
            const page = document.getElementById(`page-${target}`);
            if (page) page.classList.add('active');

            pageTitle.textContent = titles[target] || target;

            if (target === 'logs') {
                popularSelectLogs();
            }
            if (target === 'metrics') {
                carregarPaginaMetricas();
            }
            if (target === 'images') {
                carregarImagens();
            }
        });
    });
}

// ==============================
// Métricas Históricas (Grafana / Prometheus)
// ==============================

function carregarPaginaMetricas() {
    const grafanaBase = getGrafanaBaseUrl();
    const prometheusBase = getPrometheusBaseUrl();

    const iframe = document.getElementById('grafana-iframe');
    const grafanaLink = document.getElementById('grafana-link');
    const prometheusLink = document.getElementById('prometheus-link');

    if (iframe) iframe.src = `${grafanaBase}${GRAFANA_DASHBOARD_PATH}`;
    if (grafanaLink) grafanaLink.href = `${grafanaBase}${GRAFANA_DASHBOARD_PATH}`;
    if (prometheusLink) prometheusLink.href = prometheusBase;
}

// ==============================
// Imagens
// ==============================

async function carregarImagens() {
    const tbody = document.getElementById('images-table-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Carregando...</td></tr>';

    try {
        images = await requestJson(`${API_BASE}/api/images`);
        renderImagesTable();
    } catch (error) {
        console.error('[WELL_CONTAINER_MONITOR] Erro ao carregar imagens:', error);
        showToast('Não foi possível carregar as imagens. Verifique a API.', 'error');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Erro ao carregar imagens.</td></tr>';
    }
}

function obterImagensFiltradas() {
    const nome = (document.getElementById('filter-image-name')?.value || '').toLowerCase().trim();
    const uso = document.getElementById('filter-image-usage')?.value || '';

    return images.filter(item => {
        if (nome && !item.tags.some(tag => tag.toLowerCase().includes(nome))) return false;
        if (uso === 'in-use' && !item.in_use) return false;
        if (uso === 'unused' && item.in_use) return false;
        return true;
    });
}

function renderImagesTable() {
    const tbody = document.getElementById('images-table-body');
    const countEl = document.getElementById('images-count');
    if (!tbody) return;

    const filtradas = obterImagensFiltradas();
    if (countEl) countEl.textContent = filtradas.length;

    if (!filtradas.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Nenhuma imagem encontrada.</td></tr>';
        return;
    }

    tbody.innerHTML = filtradas
        .map(item => {
            const tagsHtml = item.tags.map(tag => `<div>${escapeHtml(tag)}</div>`).join('');
            const statusHtml = item.in_use
                ? `<span class="badge badge-running"><i class="fas fa-circle"></i>Em uso</span>`
                : `<span class="badge badge-exited"><i class="fas fa-circle"></i>Não utilizada</span>`;
            const usadaPor = item.used_by.length
                ? item.used_by.map(name => escapeHtml(name)).join(', ')
                : '-';

            return `
                <tr>
                    <td>${tagsHtml}</td>
                    <td>${escapeHtml(item.short_id)}</td>
                    <td>${formatBytes(item.size_bytes)}</td>
                    <td>${formatDateTime(item.created_at)}</td>
                    <td>${statusHtml}</td>
                    <td>${usadaPor}</td>
                    <td>
                        <div class="table-actions">
                            <button class="table-action-btn" data-action="delete-image" data-id="${item.id}" title="Excluir imagem"><i class="fas fa-trash"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        })
        .join('');

    tbody.querySelectorAll('[data-action="delete-image"]').forEach(btn => {
        btn.addEventListener('click', () => excluirImagem(btn.dataset.id));
    });
}

async function excluirImagem(imageId, force = false) {
    const item = images.find(img => img.id === imageId);
    const nomeImagem = item ? item.tags[0] : imageId;

    if (!force) {
        const confirmado = await confirmarAcao(
            `Tem certeza que deseja excluir a imagem "${nomeImagem}"?`,
            'Confirmar exclusão'
        );
        if (!confirmado) return;
    }

    try {
        await requestJson(`${API_BASE}/api/images/${imageId}${force ? '?force=true' : ''}`, { method: 'DELETE' });
        showToast('Imagem removida com sucesso.', 'success');
        await carregarImagens();
    } catch (error) {
        const match = error.message.match(/^in_use:(.*)$/);
        if (match) {
            const containerNames = match[1].split(',').filter(Boolean).join(', ');
            const confirmado = await confirmarAcao(
                `A imagem "${nomeImagem}" está em uso pelo(s) container(s) em execução: ${containerNames}. ` +
                `Eles serão finalizados para permitir a exclusão. Deseja continuar?`,
                'Finalizar containers e excluir imagem'
            );
            if (confirmado) await excluirImagem(imageId, true);
            return;
        }

        console.error('[WELL_CONTAINER_MONITOR] Erro ao excluir imagem:', error);
        showToast(`Erro ao excluir imagem: ${error.message}`, 'error');
    }
}

// ==============================
// Carregamento de dados
// ==============================

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        let detail = '';
        try {
            const data = await response.json();
            if (data.error === 'in_use' && Array.isArray(data.running_containers)) {
                detail = `in_use:${data.running_containers.join(',')}`;
            } else {
                detail = data.error || '';
            }
        } catch (e) {
            // ignore
        }
        throw new Error(detail || `Erro HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    return response.json();
}

async function carregarContainers() {
    try {
        const [containersData, summaryData] = await Promise.all([
            requestJson(`${API_BASE}/api/containers`),
            requestJson(`${API_BASE}/api/summary`),
        ]);
        containers = containersData;
        summary = summaryData;
        atualizarUI();
    } catch (error) {
        console.error('[WELL_CONTAINER_MONITOR] Erro ao carregar containers:', error);
        showToast('Não foi possível carregar os containers. Verifique a API.', 'error');
    }
}

function atualizarUI() {
    atualizarTimestamp();
    renderSummary();
    renderDashboardTable();
    renderContainersTable();
    renderDetalhes();
    popularSelectLogs();
}

function atualizarTimestamp() {
    const el = document.getElementById('last-update');
    if (el) el.textContent = `Atualizado em ${new Date().toLocaleTimeString('pt-BR')}`;
}

// ==============================
// Dashboard (resumo + tabela)
// ==============================

function renderSummary() {
    const map = {
        'sum-total': summary.total ?? '-',
        'sum-running': summary.running ?? '-',
        'sum-stopped': summary.stopped ?? '-',
        'sum-healthy': summary.healthy ?? '-',
        'sum-unhealthy': summary.unhealthy ?? '-',
        'sum-cpu': summary.cpu_percent_total !== undefined ? `${summary.cpu_percent_total.toFixed(1)}%` : '-',
        'sum-mem': summary.memory_usage_bytes_total !== undefined ? formatBytes(summary.memory_usage_bytes_total) : '-',
    };

    Object.entries(map).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    });
}

function renderDashboardTable() {
    const tbody = document.getElementById('dashboard-table-body');
    if (!tbody) return;

    if (!containers.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-row">Nenhum container encontrado.</td></tr>';
        return;
    }

    const ordenados = [...containers].sort((a, b) => a.name.localeCompare(b.name));

    tbody.innerHTML = ordenados
        .map(item => {
            const cpu = item.stats ? item.stats.cpu_percent : 0;
            const mem = item.stats ? item.stats.memory.percent : 0;
            return `
                <tr data-id="${item.id}" class="row-select">
                    <td>${statusBadge(item.status)}</td>
                    <td>${escapeHtml(item.name)}</td>
                    <td>${escapeHtml(item.image)}</td>
                    <td>${miniBar(cpu)}</td>
                    <td>${miniBar(mem)}</td>
                    <td>${healthBadge(item.health)}</td>
                    <td>${escapeHtml(item.uptime)}</td>
                </tr>
            `;
        })
        .join('');

    tbody.querySelectorAll('tr.row-select').forEach(tr => {
        tr.addEventListener('click', () => {
            selectedContainerId = tr.dataset.id;
            ativarPaginaContainers();
            renderDetalhes();
        });
    });
}

function ativarPaginaContainers() {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-page="containers"]').classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-containers').classList.add('active');
    document.getElementById('page-title').textContent = 'Containers';
}

// ==============================
// Página de containers (tabela + filtros + detalhes)
// ==============================

function obterContainersFiltrados() {
    const nome = (document.getElementById('filter-name')?.value || '').toLowerCase().trim();
    const imagem = (document.getElementById('filter-image')?.value || '').toLowerCase().trim();
    const status = document.getElementById('filter-status')?.value || '';
    const health = document.getElementById('filter-health')?.value || '';

    return containers.filter(item => {
        if (nome && !item.name.toLowerCase().includes(nome)) return false;
        if (imagem && !item.image.toLowerCase().includes(imagem)) return false;
        if (status && item.status !== status) return false;
        if (health && (item.health?.status || 'none') !== health) return false;
        return true;
    });
}

function renderContainersTable() {
    const tbody = document.getElementById('containers-table-body');
    const countEl = document.getElementById('containers-count');
    if (!tbody) return;

    const filtrados = obterContainersFiltrados().sort((a, b) => a.name.localeCompare(b.name));
    if (countEl) countEl.textContent = filtrados.length;

    if (!filtrados.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-row">Nenhum container encontrado.</td></tr>';
        return;
    }

    tbody.innerHTML = filtrados
        .map(item => {
            const portas = (item.ports || [])
                .filter(p => p.host_port)
                .map(p => p.url
                    ? `<a class="port-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.host_port)}→${escapeHtml(p.container_port)}</a>`
                    : `<span>${escapeHtml(p.host_port)}→${escapeHtml(p.container_port)}</span>`)
                .join('');

            const isRunning = item.status === 'running';
            const selecionado = item.id === selectedContainerId ? ' selected-row' : '';

            return `
                <tr data-id="${item.id}" class="row-select${selecionado}">
                    <td>${statusDot(item.status)}</td>
                    <td>${escapeHtml(item.name)}</td>
                    <td>${escapeHtml(item.image)}</td>
                    <td>${statusBadge(item.status)}</td>
                    <td>${healthBadge(item.health)}</td>
                    <td>${portas || '-'}</td>
                    <td>${escapeHtml(item.uptime)}</td>
                    <td>
                        <div class="table-actions">
                            ${isRunning
                                ? `<button class="table-action-btn" data-action="stop" data-id="${item.id}" title="Parar"><i class="fas fa-stop"></i></button>
                                   <button class="table-action-btn" data-action="restart" data-id="${item.id}" title="Reiniciar"><i class="fas fa-rotate-right"></i></button>
                                   <button class="table-action-btn" data-action="terminal" data-id="${item.id}" title="Abrir terminal"><i class="fas fa-terminal"></i></button>`
                                : `<button class="table-action-btn" data-action="start" data-id="${item.id}" title="Iniciar"><i class="fas fa-play"></i></button>`}
                            <button class="table-action-btn" data-action="logs" data-id="${item.id}" title="Ver logs"><i class="fas fa-file-lines"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        })
        .join('');

    tbody.querySelectorAll('tr.row-select').forEach(tr => {
        tr.addEventListener('click', (event) => {
            if (event.target.closest('.table-action-btn')) return;
            selectedContainerId = tr.dataset.id;
            renderContainersTable();
            renderDetalhes();
        });
    });

    tbody.querySelectorAll('.table-action-btn').forEach(btn => {
        btn.addEventListener('click', async (event) => {
            event.stopPropagation();
            const { action, id } = btn.dataset;
            const item = containers.find(c => c.id === id);

            if (action === 'terminal') {
                abrirTerminal(id, item ? item.name : id);
                return;
            }
            if (action === 'logs') {
                abrirLogsDoContainer(id);
                return;
            }
            await executarAcaoContainer(id, action);
        });
    });
}

async function executarAcaoContainer(containerId, action) {
    const labels = { start: 'Iniciando', stop: 'Parando', restart: 'Reiniciando', pause: 'Pausando', unpause: 'Retomando' };

    if (DESTRUCTIVE_ACTIONS[action]) {
        const item = containers.find(c => c.id === containerId);
        const nome = item ? item.name : containerId;
        const confirmado = await confirmarAcao(
            `Tem certeza que deseja ${DESTRUCTIVE_ACTIONS[action]} o container "${nome}"?`,
            'Confirmar ação'
        );
        if (!confirmado) return;
    }

    try {
        await requestJson(`${API_BASE}/api/containers/${containerId}/actions/${action}`, { method: 'POST' });
        showToast(`${labels[action] || 'Ação executada'} com sucesso.`, 'success');
        await carregarContainers();
    } catch (error) {
        console.error('[WELL_CONTAINER_MONITOR] Erro ao executar ação:', error);
        showToast(`Erro ao executar ação: ${error.message}`, 'error');
    }
}

function renderDetalhes() {
    const content = document.getElementById('details-content');
    if (!content) return;

    const item = containers.find(c => c.id === selectedContainerId);
    if (!item) {
        content.innerHTML = '<p class="empty-hint">Selecione um container na tabela para ver detalhes.</p>';
        return;
    }

    const stats = item.stats || {};
    const memory = stats.memory || {};
    const network = stats.network || {};
    const blockIo = stats.block_io || {};
    const health = item.health || {};

    const portasHtml = (item.ports || [])
        .map(p => {
            const destino = p.host_port ? `${p.host_port} → ${p.container_port}/${p.protocol}` : `${p.container_port}/${p.protocol} (não publicada)`;
            return p.url
                ? `<a class="port-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(destino)} · ${escapeHtml(p.url)}</a>`
                : `<div class="detail-row"><span class="value">${escapeHtml(destino)}</span></div>`;
        })
        .join('') || '<p class="empty-hint">Nenhuma porta publicada.</p>';

    const isRunning = item.status === 'running';

    content.innerHTML = `
        <div>
            <div class="detail-row"><span class="label">Nome</span><span class="value">${escapeHtml(item.name)}</span></div>
            <div class="detail-row"><span class="label">ID</span><span class="value">${escapeHtml(item.short_id)}</span></div>
            <div class="detail-row"><span class="label">Imagem</span><span class="value">${escapeHtml(item.image)}</span></div>
            <div class="detail-row"><span class="label">Status</span><span class="value">${statusBadge(item.status)}</span></div>
            <div class="detail-row"><span class="label">Saúde</span><span class="value">${healthBadge(health)}</span></div>
            <div class="detail-row"><span class="label">Criado em</span><span class="value">${formatDateTime(item.created_at)}</span></div>
            <div class="detail-row"><span class="label">Iniciado em</span><span class="value">${formatDateTime(item.started_at)}</span></div>
            <div class="detail-row"><span class="label">Uptime</span><span class="value">${escapeHtml(item.uptime)}</span></div>
            <div class="detail-row"><span class="label">Reinícios</span><span class="value">${item.restart_count}</span></div>
        </div>

        <div>
            <div class="detail-section-title">Saúde do serviço</div>
            <div class="detail-row"><span class="label">Falhas consecutivas</span><span class="value">${health.failing_streak || 0}</span></div>
            <div class="detail-row"><span class="label">Última verificação</span><span class="value">${formatDateTime(health.last_check_at)}</span></div>
            ${health.last_output ? `<div class="detail-row"><span class="label">Última saída</span><span class="value">${escapeHtml(health.last_output)}</span></div>` : ''}
        </div>

        <div>
            <div class="detail-section-title">Métricas</div>
            <div class="detail-row"><span class="label">CPU</span><span class="value">${miniBar(stats.cpu_percent)}</span></div>
            <div class="detail-row"><span class="label">Memória</span><span class="value">${miniBar(memory.percent)}</span></div>
            <div class="detail-row"><span class="label">Uso de memória</span><span class="value">${formatBytes(memory.usage_bytes)} / ${formatBytes(memory.limit_bytes)}</span></div>
            <div class="detail-row"><span class="label">Rede (RX/TX)</span><span class="value">${formatBytes(network.rx_bytes)} / ${formatBytes(network.tx_bytes)}</span></div>
            <div class="detail-row"><span class="label">Disco (leitura/escrita)</span><span class="value">${formatBytes(blockIo.read_bytes)} / ${formatBytes(blockIo.write_bytes)}</span></div>
            <div class="detail-row"><span class="label">PIDs</span><span class="value">${stats.pids || 0}</span></div>
        </div>

        <div>
            <div class="detail-section-title">Portas e acesso</div>
            ${portasHtml}
        </div>

        <div class="detail-actions">
            ${isRunning
                ? `<button class="danger-btn" data-action="stop"><i class="fas fa-stop"></i> Parar</button>
                   <button class="secondary-btn" data-action="restart"><i class="fas fa-rotate-right"></i> Reiniciar</button>
                   <button class="secondary-btn" data-action="pause"><i class="fas fa-pause"></i> Pausar</button>
                   <button class="secondary-btn" data-action="terminal"><i class="fas fa-terminal"></i> Abrir terminal</button>`
                : `<button class="primary-btn" data-action="start"><i class="fas fa-play"></i> Iniciar</button>`}
            ${item.status === 'paused' ? `<button class="secondary-btn" data-action="unpause"><i class="fas fa-play"></i> Retomar</button>` : ''}
            <button class="secondary-btn" data-action="logs"><i class="fas fa-file-lines"></i> Ver logs</button>
        </div>
    `;

    content.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            if (action === 'logs') {
                abrirLogsDoContainer(item.id);
                return;
            }
            if (action === 'terminal') {
                abrirTerminal(item.id, item.name);
                return;
            }
            await executarAcaoContainer(item.id, action);
        });
    });
}

// ==============================
// Logs
// ==============================

function popularSelectLogs() {
    const select = document.getElementById('logs-container-select');
    if (!select) return;

    const valorAtual = select.value;
    select.innerHTML = '<option value="">Selecione um container</option>' +
        [...containers]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
            .join('');

    if (valorAtual && containers.some(c => c.id === valorAtual)) {
        select.value = valorAtual;
    }
}

function abrirLogsDoContainer(containerId) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-page="logs"]').classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-logs').classList.add('active');
    document.getElementById('page-title').textContent = 'Logs';

    popularSelectLogs();
    const select = document.getElementById('logs-container-select');
    if (select) select.value = containerId;
    carregarLogs();
}

async function carregarLogs() {
    const select = document.getElementById('logs-container-select');
    const tailSelect = document.getElementById('logs-tail-select');
    const output = document.getElementById('logs-output');
    if (!select || !output) return;

    const containerId = select.value;
    if (!containerId) {
        output.textContent = 'Selecione um container para visualizar os logs.';
        return;
    }

    const tail = tailSelect ? tailSelect.value : 200;

    output.textContent = 'Carregando logs...';
    try {
        const data = await requestJson(`${API_BASE}/api/containers/${containerId}/logs?tail=${tail}`);
        output.textContent = data.logs || '(sem saída de log)';
        output.scrollTop = output.scrollHeight;
    } catch (error) {
        console.error('[WELL_CONTAINER_MONITOR] Erro ao carregar logs:', error);
        output.textContent = `Erro ao carregar logs: ${error.message}`;
    }
}

// ==============================
// Terminal
// ==============================

function abrirTerminal(containerId, containerName) {
    if (!socket || !socket.connected) {
        showToast('Conexão WebSocket indisponível. Não é possível abrir o terminal.', 'error');
        return;
    }

    const modal = document.getElementById('terminal-modal');
    const title = document.getElementById('terminal-title');
    const status = document.getElementById('terminal-status');
    const body = document.getElementById('terminal-body');
    if (!modal || !body) return;

    title.textContent = `Terminal — ${containerName}`;
    status.textContent = 'Conectando...';
    modal.classList.remove('hidden');

    body.innerHTML = '';

    if (typeof Terminal === 'undefined') {
        status.textContent = 'Biblioteca de terminal não carregada.';
        return;
    }

    terminalInstance = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: 13,
        theme: {
            background: '#0a0e13',
            foreground: '#c9d1d9',
        },
    });
    terminalFitAddon = new FitAddon.FitAddon();
    terminalInstance.loadAddon(terminalFitAddon);
    terminalInstance.open(body);
    terminalFitAddon.fit();

    terminalInstance.onData(data => {
        socket.emit('terminal_input', { data });
    });

    socket.emit('terminal_start', { container_id: containerId });
}

function fecharTerminal() {
    const modal = document.getElementById('terminal-modal');
    if (modal) modal.classList.add('hidden');

    if (socket) socket.emit('terminal_stop');

    if (terminalInstance) {
        terminalInstance.dispose();
        terminalInstance = null;
    }
    terminalFitAddon = null;
}

function inicializarTerminal() {
    const closeBtn = document.getElementById('terminal-close-btn');
    const overlay = document.getElementById('terminal-modal');

    if (closeBtn) closeBtn.addEventListener('click', fecharTerminal);
    if (overlay) {
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) fecharTerminal();
        });
    }

    window.addEventListener('resize', () => {
        if (!terminalFitAddon || !terminalInstance) return;
        terminalFitAddon.fit();
        const dims = terminalFitAddon.proposeDimensions();
        if (dims && socket) {
            socket.emit('terminal_resize', { rows: dims.rows, cols: dims.cols });
        }
    });
}

// ==============================
// WebSocket
// ==============================

function conectarWebSocket() {
    if (typeof io === 'undefined') return;

    socket = io(API_BASE, { transports: ['websocket', 'polling'] });
    const indicator = document.getElementById('conn-indicator');

    socket.on('connect', () => {
        if (indicator) {
            indicator.className = 'conn-indicator connected';
            indicator.innerHTML = '<i class="fas fa-circle"></i> Conectado';
        }
    });

    socket.on('disconnect', () => {
        if (indicator) {
            indicator.className = 'conn-indicator disconnected';
            indicator.innerHTML = '<i class="fas fa-circle"></i> Desconectado';
        }
    });

    socket.on('containers_update', (data) => {
        containers = data.containers || [];
        summary = data.summary || {};
        atualizarUI();
    });

    socket.on('terminal_ready', () => {
        const status = document.getElementById('terminal-status');
        if (status) status.textContent = 'Conectado.';

        if (terminalInstance && terminalFitAddon) {
            terminalFitAddon.fit();
            const dims = terminalFitAddon.proposeDimensions();
            if (dims) socket.emit('terminal_resize', { rows: dims.rows, cols: dims.cols });
            terminalInstance.focus();
        }
    });

    socket.on('terminal_output', (data) => {
        if (terminalInstance) terminalInstance.write(data.data || '');
    });

    socket.on('terminal_error', (data) => {
        const status = document.getElementById('terminal-status');
        if (status) status.textContent = `Erro: ${data.error}`;
        showToast(`Erro ao abrir terminal: ${data.error}`, 'error');
    });

    socket.on('terminal_closed', () => {
        const status = document.getElementById('terminal-status');
        if (status) status.textContent = 'Sessão finalizada.';
    });
}

// ==============================
// Configurações
// ==============================

function inicializarConfiguracoes() {
    const apiUrlInput = document.getElementById('settings-api-url');
    const intervalInput = document.getElementById('settings-refresh-interval');
    const grafanaUrlInput = document.getElementById('settings-grafana-url');
    const prometheusUrlInput = document.getElementById('settings-prometheus-url');
    const saveBtn = document.getElementById('settings-save-btn');

    if (apiUrlInput) apiUrlInput.value = API_BASE;
    if (intervalInput) intervalInput.value = localStorage.getItem(STORAGE_KEY_INTERVAL) || '5';
    if (grafanaUrlInput) grafanaUrlInput.value = getGrafanaBaseUrl();
    if (prometheusUrlInput) prometheusUrlInput.value = getPrometheusBaseUrl();

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const novaUrl = (apiUrlInput.value || '').trim().replace(/\/$/, '');
            const novoIntervalo = intervalInput.value || '5';
            const novaGrafanaUrl = (grafanaUrlInput?.value || '').trim().replace(/\/$/, '');
            const novaPrometheusUrl = (prometheusUrlInput?.value || '').trim().replace(/\/$/, '');

            if (novaUrl) localStorage.setItem(STORAGE_KEY_API_URL, novaUrl);
            localStorage.setItem(STORAGE_KEY_INTERVAL, novoIntervalo);
            if (novaGrafanaUrl) localStorage.setItem(STORAGE_KEY_GRAFANA_URL, novaGrafanaUrl);
            if (novaPrometheusUrl) localStorage.setItem(STORAGE_KEY_PROMETHEUS_URL, novaPrometheusUrl);

            showToast('Configurações salvas. Recarregando...', 'success');
            setTimeout(() => window.location.reload(), 800);
        });
    }
}

// ==============================
// Inicialização
// ==============================

function inicializarFiltros() {
    ['filter-name', 'filter-image', 'filter-status', 'filter-health'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', renderContainersTable);
            el.addEventListener('change', renderContainersTable);
        }
    });

    ['filter-image-name', 'filter-image-usage'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', renderImagesTable);
            el.addEventListener('change', renderImagesTable);
        }
    });

    const imagesRefreshBtn = document.getElementById('images-refresh-btn');
    if (imagesRefreshBtn) imagesRefreshBtn.addEventListener('click', carregarImagens);
}

function inicializarLogs() {
    const refreshBtn = document.getElementById('logs-refresh-btn');
    const select = document.getElementById('logs-container-select');
    const tailSelect = document.getElementById('logs-tail-select');

    if (refreshBtn) refreshBtn.addEventListener('click', carregarLogs);
    if (select) select.addEventListener('change', carregarLogs);
    if (tailSelect) tailSelect.addEventListener('change', carregarLogs);
}

function inicializarApp() {
    inicializarNavegacao();
    inicializarFiltros();
    inicializarLogs();
    inicializarConfiguracoes();
    inicializarTerminal();

    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', carregarContainers);

    carregarContainers();
    conectarWebSocket();
}

document.addEventListener('DOMContentLoaded', inicializarApp);
