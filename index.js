// Approved direction: a UI-only, preview-first cleanup manager with configurable
// chat thresholds, a dedicated responsive results window, reference-aware
// lorebook cleanup, and an explicit choice to delete with or without a ZIP backup.
import {
    characters,
    deleteCharacterChatByName,
    getCurrentChatId,
    getRequestHeaders,
    saveSettingsDebounced,
    this_chid,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    deleteGroupChatByName,
    groups,
    selected_group,
} from '../../../group-chats.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { power_user } from '../../../power-user.js';
import { timestampToMoment } from '../../../utils.js';
import {
    deleteWorldInfo,
    selected_world_info,
    world_info,
} from '../../../world-info.js';

const MODULE_NAME = '🧹 BB-Cleanup-Manager';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_INVENTORY_ITEMS = 100_000;
const WORLD_LOAD_CONCURRENCY = 6;
const DEFAULT_SETTINGS = Object.freeze({
    daysOld: 30,
    maxMessages: 5,
});

const state = {
    busy: false,
    scannedAt: null,
    chats: [],
    allChatKeys: new Set(),
    lorebooks: [],
    worldData: new Map(),
    allWorldNames: new Set(),
    selectedChats: new Set(),
    selectedLorebooks: new Set(),
    activeTab: 'chats',
    searchByTab: { chats: '', lorebooks: '' },
    sortByTab: { chats: 'oldest', lorebooks: 'memory-first' },
    managerPopup: null,
    managerRoot: null,
};

function isMobileViewport() {
    return globalThis.matchMedia?.('(max-width: 760px)').matches ?? false;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[character]));
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function getSettings() {
    const saved = extension_settings[MODULE_NAME];
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }

    const settings = extension_settings[MODULE_NAME];
    settings.daysOld = clampInteger(settings.daysOld, 1, 3650, DEFAULT_SETTINGS.daysOld);
    settings.maxMessages = clampInteger(settings.maxMessages, 0, 1000, DEFAULT_SETTINGS.maxMessages);
    return settings;
}

async function postJson(endpoint, body) {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });

    if (!response.ok) {
        throw new Error(`${endpoint}: HTTP ${response.status}`);
    }

    return response.json();
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let cursor = 0;

    async function worker() {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await mapper(items[index], index);
        }
    }

    const workerCount = Math.min(concurrency, Math.max(items.length, 1));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function chatKey(chat) {
    if (chat.group) return `group:${chat.group}:${chat.fileId}`;
    if (chat.avatar) return `character:${chat.avatar}:${chat.fileId}`;
    return `root:${chat.fileId}`;
}

function getActiveChatKey() {
    const currentChatId = String(getCurrentChatId() || '').trim();
    if (!currentChatId) return null;
    if (selected_group) return `group:${selected_group}:${currentChatId}`;

    const avatar = this_chid !== undefined ? characters[this_chid]?.avatar : null;
    return avatar ? `character:${avatar}:${currentChatId}` : null;
}

function parseChatTimestamp(value) {
    const parsed = timestampToMoment(value);
    return parsed?.isValid?.() ? parsed.valueOf() : null;
}

function normalizeChat(rawChat) {
    const fileId = String(rawChat?.file_id || rawChat?.file_name || '').replace(/\.jsonl$/i, '');
    const avatar = rawChat?.avatar ? String(rawChat.avatar) : null;
    const group = rawChat?.group ? String(rawChat.group) : null;
    const character = avatar ? characters.find(item => item?.avatar === avatar) : null;
    const groupData = group ? groups.find(item => String(item?.id) === group) : null;
    const timestamp = parseChatTimestamp(rawChat?.last_mes);
    const normalized = {
        avatar,
        group,
        fileId,
        fileName: String(rawChat?.file_name || `${fileId}.jsonl`),
        fileSize: String(rawChat?.file_size || '—'),
        messageCount: Math.max(0, Number(rawChat?.chat_items) || 0),
        timestamp,
        metadata: rawChat?.chat_metadata && typeof rawChat.chat_metadata === 'object'
            ? rawChat.chat_metadata
            : {},
        ownerName: group
            ? String(groupData?.name || `Группа ${group}`)
            : avatar
                ? String(character?.name || avatar.replace(/\.png$/i, ''))
                : 'Неопознанный чат',
    };
    normalized.key = chatKey(normalized);
    return normalized;
}

async function fetchChatInventory() {
    const data = await postJson('/api/chats/recent', {
        max: MAX_INVENTORY_ITEMS,
        metadata: true,
    });
    return Array.isArray(data) ? data.map(normalizeChat).filter(chat => chat.fileId) : [];
}

async function fetchWorldNames() {
    const data = await postJson('/api/settings/get', {});
    return Array.isArray(data?.world_names)
        ? Array.from(new Set(data.world_names.map(String).filter(Boolean)))
        : [];
}

async function fetchWorldData(name) {
    try {
        return await postJson('/api/worldinfo/get', { name });
    } catch (error) {
        console.warn(`${MODULE_NAME}: could not load lorebook "${name}".`, error);
        return null;
    }
}

function collectKnownStrings(value, knownNames, callback) {
    const pending = [value];
    const visited = new WeakSet();

    while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current === 'string') {
            if (knownNames.has(current)) callback(current);
            continue;
        }
        if (!current || typeof current !== 'object' || visited.has(current)) continue;

        visited.add(current);
        for (const nestedValue of Object.values(current)) {
            pending.push(nestedValue);
        }
    }
}

function collectLorebookFields(value, knownNames, callback) {
    if (!value || typeof value !== 'object') return;

    const pending = [value];
    const visited = new WeakSet();

    while (pending.length > 0) {
        const current = pending.pop();
        if (visited.has(current)) continue;
        visited.add(current);

        for (const [key, nestedValue] of Object.entries(current)) {
            if (/lorebook/i.test(key)) {
                collectKnownStrings(nestedValue, knownNames, callback);
            }
            if (nestedValue && typeof nestedValue === 'object') {
                pending.push(nestedValue);
            }
        }
    }
}

function createReferenceMap(worldNames, allChats, worldData) {
    const knownNames = new Set(worldNames);
    const references = new Map(worldNames.map(name => [name, []]));

    const addReference = (name, reference) => {
        if (!knownNames.has(name)) return;
        const existing = references.get(name);
        const signature = `${reference.type}:${reference.chatKey || ''}:${reference.label}`;
        if (!existing.some(item => `${item.type}:${item.chatKey || ''}:${item.label}` === signature)) {
            existing.push(reference);
        }
    };

    for (const name of selected_world_info || []) {
        addReference(name, { type: 'global', label: 'Глобальное подключение' });
    }

    for (const character of characters) {
        const characterName = String(character?.name || character?.avatar || 'Персонаж');
        const primary = character?.data?.extensions?.world;
        if (primary) addReference(primary, { type: 'character', label: `Персонаж: ${characterName}` });
        collectLorebookFields(character?.data?.extensions, knownNames, name => {
            addReference(name, { type: 'character', label: `Расширения персонажа: ${characterName}` });
        });
    }

    for (const binding of world_info?.charLore || []) {
        for (const name of binding?.extraBooks || []) {
            addReference(name, { type: 'character', label: `Доп. лорбук персонажа: ${binding?.name || 'неизвестно'}` });
        }
    }

    for (const [avatar, descriptor] of Object.entries(power_user?.persona_descriptions || {})) {
        const name = descriptor?.lorebook;
        const personaName = power_user?.personas?.[avatar] || avatar;
        if (name) addReference(name, { type: 'persona', label: `Персона: ${personaName}` });
    }

    collectLorebookFields(extension_settings, knownNames, name => {
        addReference(name, { type: 'extension-settings', label: 'Настройки расширений' });
    });

    for (const chat of allChats) {
        const metadata = chat.metadata || {};
        const label = `Чат: ${chat.ownerName} / ${chat.fileId}`;
        const addChatReference = name => addReference(name, {
            type: 'chat',
            chatKey: chat.key,
            label,
        });

        if (metadata.world_info) addChatReference(metadata.world_info);
        collectLorebookFields(metadata, knownNames, addChatReference);
    }

    for (const [sourceName, data] of worldData.entries()) {
        for (const entry of Object.values(data?.entries || {})) {
            const canonicalName = String(entry?.STMB_canonicalLorebook || '').trim();
            if (canonicalName && canonicalName !== sourceName) {
                addReference(canonicalName, {
                    type: 'lorebook-link',
                    label: `Связь Memory Books из: ${sourceName}`,
                });
            }
        }
    }

    return references;
}

function isMemoryBook(data) {
    return Object.values(data?.entries || {}).some(entry => {
        if (!entry || typeof entry !== 'object') return false;
        if (entry.stmemorybooks === true) return true;
        return Object.keys(entry).some(key => /^STMB_|^stmb/i.test(key));
    });
}

function buildCandidates(allChats, worldNames, worldData) {
    const settings = getSettings();
    const cutoff = Date.now() - settings.daysOld * DAY_MS;
    const activeChatKey = getActiveChatKey();
    const chatCandidates = allChats
        .filter(chat => chat.avatar || chat.group)
        .filter(chat => chat.key !== activeChatKey)
        .filter(chat => chat.timestamp !== null && chat.timestamp <= cutoff)
        .filter(chat => chat.messageCount <= settings.maxMessages)
        .sort((left, right) => left.timestamp - right.timestamp);
    const candidateKeys = new Set(chatCandidates.map(chat => chat.key));
    const referenceMap = createReferenceMap(worldNames, allChats, worldData);
    const lorebookCandidates = [];

    for (const name of worldNames) {
        const data = worldData.get(name);
        if (!data) continue;

        const references = referenceMap.get(name) || [];
        const hardReferences = references.filter(reference => reference.type !== 'chat');
        const chatReferences = references.filter(reference => reference.type === 'chat');
        if (hardReferences.length > 0) continue;

        if (chatReferences.length === 0) {
            lorebookCandidates.push({
                name,
                data,
                entriesCount: Object.keys(data?.entries || {}).length,
                memoryBook: isMemoryBook(data),
                mode: 'unused',
                chatReferences: [],
            });
            continue;
        }

        if (chatReferences.every(reference => candidateKeys.has(reference.chatKey))) {
            lorebookCandidates.push({
                name,
                data,
                entriesCount: Object.keys(data?.entries || {}).length,
                memoryBook: isMemoryBook(data),
                mode: 'candidate-chats',
                chatReferences,
            });
        }
    }

    lorebookCandidates.sort((left, right) => {
        if (left.memoryBook !== right.memoryBook) return left.memoryBook ? -1 : 1;
        return left.name.localeCompare(right.name, 'ru');
    });

    return { chatCandidates, lorebookCandidates };
}

function setStatus(message, type = '') {
    const elements = $('#bbcm-status').add(state.managerRoot ? $(state.managerRoot).find('#bbcm-manager-status') : $());
    elements.removeClass('bbcm-status-error bbcm-status-success');
    if (type) elements.addClass(`bbcm-status-${type}`);
    elements.text(message);
}

function setBusy(busy) {
    state.busy = busy;
    $('#bbcm-settings button, #bbcm-settings input').prop('disabled', busy);
    if (state.managerRoot) {
        $(state.managerRoot).find('button, input, select').prop('disabled', busy);
    }
    $('#bbcm-scan').toggleClass('bbcm-spinning', busy);
    if (!busy) {
        $('#bbcm-days-old, #bbcm-max-messages').prop('disabled', false);
        renderManager();
        updateSelectionControls();
    }
}

function formatDate(timestamp) {
    if (timestamp === null) return 'Неизвестно';
    return new Intl.DateTimeFormat('ru-RU', {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(timestamp));
}

function encodeKey(value) {
    return encodeURIComponent(value);
}

function decodeKey(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return String(value || '');
    }
}

function canSelectLorebook(lorebook) {
    if (lorebook.mode === 'unused') return true;
    return lorebook.chatReferences.every(reference => state.selectedChats.has(reference.chatKey));
}

function validateLorebookSelection() {
    for (const lorebook of state.lorebooks) {
        if (!canSelectLorebook(lorebook)) state.selectedLorebooks.delete(lorebook.name);
    }
}

function parseFileSize(value) {
    const match = String(value || '').trim().match(/^([\d.,]+)\s*(B|KB|MB|GB|TB)?$/i);
    if (!match) return 0;
    const amount = Number(match[1].replace(',', '.'));
    const power = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(String(match[2] || 'B').toUpperCase());
    return Number.isFinite(amount) ? amount * 1024 ** Math.max(power, 0) : 0;
}

function getVisibleChats() {
    const query = state.searchByTab.chats.trim().toLocaleLowerCase('ru');
    const chats = state.chats.filter(chat => !query || `${chat.ownerName} ${chat.fileId}`.toLocaleLowerCase('ru').includes(query));
    const sort = state.sortByTab.chats;
    return chats.sort((left, right) => {
        if (sort === 'newest') return right.timestamp - left.timestamp;
        if (sort === 'messages-asc') return left.messageCount - right.messageCount || left.timestamp - right.timestamp;
        if (sort === 'messages-desc') return right.messageCount - left.messageCount || left.timestamp - right.timestamp;
        if (sort === 'size-asc') return parseFileSize(left.fileSize) - parseFileSize(right.fileSize);
        if (sort === 'size-desc') return parseFileSize(right.fileSize) - parseFileSize(left.fileSize);
        return left.timestamp - right.timestamp;
    });
}

function getVisibleLorebooks() {
    const query = state.searchByTab.lorebooks.trim().toLocaleLowerCase('ru');
    const lorebooks = state.lorebooks.filter(book => !query || book.name.toLocaleLowerCase('ru').includes(query));
    const sort = state.sortByTab.lorebooks;
    return lorebooks.sort((left, right) => {
        if (sort === 'name') return left.name.localeCompare(right.name, 'ru');
        if (sort === 'entries-asc') return left.entriesCount - right.entriesCount || left.name.localeCompare(right.name, 'ru');
        if (sort === 'entries-desc') return right.entriesCount - left.entriesCount || left.name.localeCompare(right.name, 'ru');
        if (left.memoryBook !== right.memoryBook) return left.memoryBook ? -1 : 1;
        return left.name.localeCompare(right.name, 'ru');
    });
}

function renderChatCards() {
    if (!state.managerRoot) return;
    const list = $(state.managerRoot).find('#bbcm-chat-list');
    const chats = getVisibleChats();
    if (chats.length === 0) {
        list.html('<div class="bbcm-empty">Подходящих чатов не найдено.</div>');
        return;
    }

    list.html(chats.map(chat => `
        <article class="bbcm-result-card ${state.selectedChats.has(chat.key) ? 'bbcm-card-selected' : ''}" data-kind="chat" data-key="${encodeKey(chat.key)}">
            <div class="bbcm-card-topline">
                <input type="checkbox" class="bbcm-card-checkbox bbcm-chat-select" data-key="${encodeKey(chat.key)}" aria-label="Выбрать чат ${escapeHtml(chat.fileId)}" ${state.selectedChats.has(chat.key) ? 'checked' : ''}>
                <span class="bbcm-badge"><i class="fa-solid ${chat.group ? 'fa-users' : 'fa-user'}"></i> ${chat.group ? 'Группа' : 'Персонаж'}</span>
                <button type="button" class="menu_button bbcm-icon-button bbcm-preview-chat" data-key="${encodeKey(chat.key)}" title="Предпросмотр" aria-label="Предпросмотр"><i class="fa-solid fa-eye"></i></button>
            </div>
            <div class="bbcm-card-owner" title="${escapeHtml(chat.ownerName)}">${escapeHtml(chat.ownerName)}</div>
            <div class="bbcm-card-title" title="${escapeHtml(chat.fileId)}">${escapeHtml(chat.fileId)}</div>
            <div class="bbcm-card-meta">
                <span><i class="fa-regular fa-comments"></i> ${chat.messageCount}</span>
                <span><i class="fa-regular fa-hard-drive"></i> ${escapeHtml(chat.fileSize)}</span>
                <span><i class="fa-regular fa-calendar"></i> ${escapeHtml(formatDate(chat.timestamp))}</span>
            </div>
        </article>
    `).join(''));
}

function renderLorebookCards() {
    if (!state.managerRoot) return;
    validateLorebookSelection();
    const list = $(state.managerRoot).find('#bbcm-lorebook-list');
    const lorebooks = getVisibleLorebooks();
    if (lorebooks.length === 0) {
        list.html('<div class="bbcm-empty">Непривязанных лорбуков не найдено.</div>');
        return;
    }

    list.html(lorebooks.map(lorebook => {
        const selectable = canSelectLorebook(lorebook);
        const reason = lorebook.mode === 'unused'
            ? 'Нигде не привязан'
            : selectable
                ? `Освободится после удаления ${lorebook.chatReferences.length} выбранных чатов`
                : `Используется только в ${lorebook.chatReferences.length} чатах-кандидатах`;
        const references = lorebook.chatReferences.map(reference => reference.label).join('\n');
        return `
            <article class="bbcm-result-card ${selectable ? '' : 'bbcm-card-disabled'} ${state.selectedLorebooks.has(lorebook.name) ? 'bbcm-card-selected' : ''}" data-kind="lorebook" data-name="${escapeHtml(lorebook.name)}">
                <div class="bbcm-card-topline">
                    <input type="checkbox" class="bbcm-card-checkbox bbcm-lorebook-select" data-name="${escapeHtml(lorebook.name)}" aria-label="Выбрать лорбук ${escapeHtml(lorebook.name)}" ${state.selectedLorebooks.has(lorebook.name) ? 'checked' : ''} ${selectable ? '' : 'disabled'}>
                    ${lorebook.memoryBook ? '<span class="bbcm-badge bbcm-memory-badge"><i class="fa-solid fa-brain"></i> Memory Book</span>' : '<span class="bbcm-badge"><i class="fa-solid fa-book"></i> Lorebook</span>'}
                    <button type="button" class="menu_button bbcm-icon-button bbcm-preview-lorebook" data-name="${escapeHtml(lorebook.name)}" title="Предпросмотр" aria-label="Предпросмотр"><i class="fa-solid fa-eye"></i></button>
                </div>
                <div class="bbcm-card-owner" title="${escapeHtml(lorebook.name)}">${escapeHtml(lorebook.name)}</div>
                <div class="bbcm-card-meta">
                    <span><i class="fa-solid fa-list"></i> ${lorebook.entriesCount} записей</span>
                </div>
                <div class="bbcm-card-reason" title="${escapeHtml(references)}">${escapeHtml(reason)}</div>
            </article>
        `;
    }).join(''));
}

function getVisibleItems() {
    return state.activeTab === 'chats' ? getVisibleChats() : getVisibleLorebooks();
}

function updateSelectionControls() {
    const selectedCount = state.selectedChats.size + state.selectedLorebooks.size;
    $('#bbcm-open-manager').prop('disabled', state.busy || !state.scannedAt);
    if (!state.managerRoot) return;

    const root = $(state.managerRoot);
    const visibleItems = getVisibleItems();
    const selectableItems = state.activeTab === 'chats' ? visibleItems : visibleItems.filter(canSelectLorebook);
    const allVisibleSelected = selectableItems.length > 0 && selectableItems.every(item => (
        state.activeTab === 'chats' ? state.selectedChats.has(item.key) : state.selectedLorebooks.has(item.name)
    ));
    root.find('#bbcm-select-visible').prop('checked', allVisibleSelected).prop('disabled', state.busy || selectableItems.length === 0);
    root.find('#bbcm-export-selected, #bbcm-delete-selected').prop('disabled', state.busy || selectedCount === 0);
    root.find('#bbcm-selected-count').text(`Выбрано: ${state.selectedChats.size} чатов, ${state.selectedLorebooks.size} лорбуков`);
    root.find('#bbcm-visible-count').text(`Показано: ${visibleItems.length}`);
}

function renderSortOptions() {
    if (!state.managerRoot) return;
    const select = $(state.managerRoot).find('#bbcm-sort');
    const options = state.activeTab === 'chats'
        ? [
            ['oldest', 'Сначала самые старые'],
            ['newest', 'Сначала самые новые'],
            ['messages-asc', 'Меньше сообщений'],
            ['messages-desc', 'Больше сообщений'],
            ['size-asc', 'Меньше размер'],
            ['size-desc', 'Больше размер'],
        ]
        : [
            ['memory-first', 'Сначала Memory Books'],
            ['name', 'По названию'],
            ['entries-asc', 'Меньше записей'],
            ['entries-desc', 'Больше записей'],
        ];
    select.html(options.map(([value, label]) => `<option value="${value}">${label}</option>`).join(''));
    select.val(state.sortByTab[state.activeTab]);
}

function renderManager() {
    if (!state.managerRoot) return;
    const root = $(state.managerRoot);
    root.find('#bbcm-manager-chat-count, #bbcm-tab-chat-count').text(state.chats.length);
    root.find('#bbcm-manager-lorebook-count, #bbcm-tab-lorebook-count').text(state.lorebooks.length);
    root.find('.bbcm-tab').attr('aria-selected', 'false').removeClass('bbcm-tab-active');
    root.find(`.bbcm-tab[data-tab="${state.activeTab}"]`).attr('aria-selected', 'true').addClass('bbcm-tab-active');
    root.find('.bbcm-tab-panel').prop('hidden', true);
    root.find(`#bbcm-${state.activeTab}-panel`).prop('hidden', false);
    root.find('#bbcm-search')
        .val(state.searchByTab[state.activeTab])
        .attr('placeholder', state.activeTab === 'chats' ? 'Поиск по персонажу или чату…' : 'Поиск по названию лорбука…');
    renderSortOptions();
    renderChatCards();
    renderLorebookCards();
    updateSelectionControls();
    if (state.busy) root.find('button, input, select').prop('disabled', true);
}

function collapseMobileOverview() {
    if (!state.managerRoot || !isMobileViewport()) return;
    const overview = $(state.managerRoot).find('.bbcm-mobile-overview').get(0);
    if (overview) overview.open = false;
}

function renderResults() {
    $('#bbcm-result-summary').prop('hidden', false);
    $('#bbcm-summary-text').text(`Найдено: ${state.chats.length} чатов, ${state.lorebooks.length} лорбуков.`);
    $('#bbcm-open-manager-count').text(state.chats.length + state.lorebooks.length);
    renderManager();
    updateSelectionControls();
}

async function scanCleanupCandidates({ preserveSelection = false, nested = false } = {}) {
    if (state.busy && !nested) return;
    if (!nested) setBusy(true);
    setStatus('Сканирую чаты…');

    try {
        const [allChats, worldNames] = await Promise.all([
            fetchChatInventory(),
            fetchWorldNames(),
        ]);

        setStatus(`Проверяю лорбуки: 0 / ${worldNames.length}…`);
        let loadedCount = 0;
        const loadedWorlds = await mapWithConcurrency(worldNames, WORLD_LOAD_CONCURRENCY, async name => {
            const data = await fetchWorldData(name);
            loadedCount++;
            if (loadedCount === worldNames.length || loadedCount % 10 === 0) {
                setStatus(`Проверяю лорбуки: ${loadedCount} / ${worldNames.length}…`);
            }
            return [name, data];
        });
        const worldData = new Map(loadedWorlds.filter(([, data]) => data));
        const { chatCandidates, lorebookCandidates } = buildCandidates(allChats, worldNames, worldData);

        const previousChats = preserveSelection ? state.selectedChats : new Set();
        const previousLorebooks = preserveSelection ? state.selectedLorebooks : new Set();
        state.scannedAt = Date.now();
        state.chats = chatCandidates;
        state.allChatKeys = new Set(allChats.map(chat => chat.key));
        state.lorebooks = lorebookCandidates;
        state.worldData = worldData;
        state.allWorldNames = new Set(worldNames);
        state.selectedChats = new Set(chatCandidates.filter(chat => previousChats.has(chat.key)).map(chat => chat.key));
        state.selectedLorebooks = new Set(lorebookCandidates.filter(book => previousLorebooks.has(book.name)).map(book => book.name));

        renderResults();
        collapseMobileOverview();
        const failedWorlds = worldNames.length - worldData.size;
        const suffix = failedWorlds > 0 ? ` ${failedWorlds} лорбуков не удалось прочитать и они исключены.` : '';
        setStatus(`Проверено ${allChats.length} чатов и ${worldNames.length} лорбуков. Найдено: ${chatCandidates.length} чатов, ${lorebookCandidates.length} лорбуков.${suffix}`, 'success');
        if (!nested && !state.managerRoot) void openManager();
    } catch (error) {
        console.error(`${MODULE_NAME}: scan failed.`, error);
        setStatus(`Ошибка сканирования: ${error.message}`, 'error');
        toastr.error('Не удалось завершить сканирование.', 'BB Cleanup Manager');
        if (nested) throw error;
    } finally {
        if (!nested) setBusy(false);
    }
}

function getChatByKey(key) {
    return state.chats.find(chat => chat.key === key);
}

function getLorebookByName(name) {
    return state.lorebooks.find(lorebook => lorebook.name === name);
}

async function fetchChatMessages(chat) {
    return chat.group
        ? postJson('/api/chats/group/get', { id: chat.fileId })
        : postJson('/api/chats/get', { avatar_url: chat.avatar, file_name: chat.fileId });
}

function truncate(value, maxLength = 1200) {
    const text = String(value ?? '').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

async function previewChat(chat) {
    try {
        const data = await fetchChatMessages(chat);
        const messages = (Array.isArray(data) ? data.slice(1) : [])
            .filter(message => message && !message.is_system)
            .slice(-12);
        const content = messages.length > 0
            ? messages.map(message => `
                <div class="bbcm-preview-message">
                    <strong>${escapeHtml(message.name || (message.is_user ? 'Пользователь' : chat.ownerName))}</strong>
                    <div>${escapeHtml(truncate(message?.extra?.display_text || message.mes || '')).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('')
            : '<p class="opacity50p">В чате нет отображаемых сообщений.</p>';

        await Popup.show.text(
            `Предпросмотр: ${chat.ownerName}`,
            `<div class="bbcm-preview"><p><code>${escapeHtml(chat.fileId)}</code></p>${content}</div>`,
            { wide: true, large: true, allowVerticalScrolling: true, leftAlign: true },
        );
    } catch (error) {
        console.error(`${MODULE_NAME}: chat preview failed.`, error);
        toastr.error('Не удалось открыть чат.', 'BB Cleanup Manager');
    }
}

async function previewLorebook(lorebook) {
    const entries = Object.values(lorebook.data?.entries || {}).slice(0, 20);
    const content = entries.length > 0
        ? entries.map(entry => `
            <div class="bbcm-preview-message">
                <strong>${escapeHtml(entry.comment || entry.title || `Запись ${entry.uid ?? entry.id ?? ''}`)}</strong>
                <div>${escapeHtml(truncate(entry.content || '')).replace(/\n/g, '<br>')}</div>
            </div>
        `).join('')
        : '<p class="opacity50p">Лорбук пуст.</p>';

    await Popup.show.text(
        `Лорбук: ${lorebook.name}`,
        `<div class="bbcm-preview">${content}${lorebook.entriesCount > 20 ? '<p class="opacity50p">Показаны первые 20 записей.</p>' : ''}</div>`,
        { wide: true, large: true, allowVerticalScrolling: true, leftAlign: true },
    );
}

function safeArchiveName(value) {
    return String(value || 'unnamed')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\.+$/g, '')
        .trim() || 'unnamed';
}

function shortHash(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

async function exportChatRaw(chat) {
    const data = await postJson('/api/chats/export', {
        is_group: Boolean(chat.group),
        avatar_url: chat.avatar,
        file: `${chat.fileId}.jsonl`,
        exportfilename: `${chat.fileId}.jsonl`,
        format: 'jsonl',
    });
    if (typeof data?.result !== 'string') throw new Error(`Пустой экспорт чата "${chat.fileId}".`);
    return data.result;
}

async function ensureJsZip() {
    if (!globalThis.JSZip) await import('../../../../lib/jszip.min.js');
    if (!globalThis.JSZip) throw new Error('JSZip не загрузился.');
    return globalThis.JSZip;
}

function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function createSelectedBackup() {
    const selectedChats = state.chats.filter(chat => state.selectedChats.has(chat.key));
    const selectedLorebooks = state.lorebooks.filter(book => state.selectedLorebooks.has(book.name));
    if (selectedChats.length === 0 && selectedLorebooks.length === 0) {
        throw new Error('Ничего не выбрано.');
    }

    const JSZip = await ensureJsZip();
    const zip = new JSZip();
    const manifest = {
        exportedAt: new Date().toISOString(),
        chats: [],
        lorebooks: [],
    };

    for (const chat of selectedChats) {
        const raw = await exportChatRaw(chat);
        const ownerId = chat.group || chat.avatar || chat.ownerName;
        const ownerFolder = safeArchiveName(`${chat.group ? 'group' : 'character'}-${chat.ownerName}-${shortHash(ownerId)}`);
        const path = `chats/${ownerFolder}/${safeArchiveName(chat.fileId)}.jsonl`;
        zip.file(path, raw);
        manifest.chats.push({
            path,
            type: chat.group ? 'group' : 'character',
            owner: chat.ownerName,
            avatar: chat.avatar,
            group: chat.group,
            fileId: chat.fileId,
        });
    }

    for (const lorebook of selectedLorebooks) {
        const freshData = await fetchWorldData(lorebook.name);
        if (!freshData) throw new Error(`Не удалось экспортировать лорбук "${lorebook.name}".`);
        const path = `lorebooks/${safeArchiveName(lorebook.name)}-${shortHash(lorebook.name)}.json`;
        zip.file(path, JSON.stringify(freshData, null, 2));
        manifest.lorebooks.push({ path, name: lorebook.name });
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(blob, `sillytavern-cleanup-backup-${stamp}.zip`);
    return manifest;
}

async function exportSelected() {
    if (state.busy) return;
    setBusy(true);
    setStatus('Создаю ZIP-бэкап…');
    try {
        const manifest = await createSelectedBackup();
        setStatus(`Бэкап создан: ${manifest.chats.length} чатов, ${manifest.lorebooks.length} лорбуков.`, 'success');
        toastr.success('ZIP-бэкап скачан.', 'BB Cleanup Manager');
    } catch (error) {
        console.error(`${MODULE_NAME}: backup failed.`, error);
        setStatus(`Ошибка создания бэкапа: ${error.message}`, 'error');
        toastr.error('Не удалось создать бэкап.', 'BB Cleanup Manager');
    } finally {
        setBusy(false);
    }
}

async function getFreshReferences(worldData) {
    const [allChats, worldNames] = await Promise.all([
        fetchChatInventory(),
        fetchWorldNames(),
    ]);
    return {
        allChats,
        worldNames,
        references: createReferenceMap(worldNames, allChats, worldData),
    };
}

async function deleteSelected() {
    if (state.busy) return;
    const selectedChats = state.chats.filter(chat => state.selectedChats.has(chat.key));
    const selectedLorebooks = state.lorebooks.filter(book => state.selectedLorebooks.has(book.name));
    if (selectedChats.length === 0 && selectedLorebooks.length === 0) return;

    const deletionChoice = await Popup.show.confirm(
        'Безвозвратное удаление',
        `Будет удалено <strong>${selectedChats.length}</strong> чатов и <strong>${selectedLorebooks.length}</strong> лорбуков.<br><br><strong>Удаление без бэкапа нельзя отменить средствами SillyTavern.</strong> Выберите способ удаления.`,
        {
            okButton: false,
            cancelButton: false,
            defaultResult: POPUP_RESULT.CANCELLED,
            customButtons: [
                {
                    text: 'Создать ZIP и удалить',
                    icon: 'fa-file-zipper',
                    result: POPUP_RESULT.AFFIRMATIVE,
                    appendAtEnd: true,
                },
                {
                    text: 'Удалить без бэкапа',
                    tooltip: 'Удалить выбранные данные без возможности восстановления из ZIP',
                    icon: 'fa-trash-can',
                    classes: ['redWarningBG'],
                    result: POPUP_RESULT.CUSTOM1,
                    appendAtEnd: true,
                },
                {
                    text: 'Отмена',
                    result: POPUP_RESULT.CANCELLED,
                    appendAtEnd: true,
                },
            ],
        },
    );
    if (![POPUP_RESULT.AFFIRMATIVE, POPUP_RESULT.CUSTOM1].includes(deletionChoice)) return;
    const createBackup = deletionChoice === POPUP_RESULT.AFFIRMATIVE;

    setBusy(true);
    const requestedChatKeys = new Set(selectedChats.map(chat => chat.key));
    const requestedWorldNames = new Set(selectedLorebooks.map(book => book.name));
    const skipped = [];

    try {
        if (createBackup) {
            setStatus('Создаю ZIP-бэкап…');
            await createSelectedBackup();
        } else {
            setStatus('Удаляю выбранное без бэкапа…');
        }

        for (let index = 0; index < selectedChats.length; index++) {
            const chat = selectedChats[index];
            setStatus(`Удаляю чаты: ${index + 1} / ${selectedChats.length}…`);

            if (chat.key === getActiveChatKey()) {
                skipped.push(`Активный чат: ${chat.ownerName} / ${chat.fileId}`);
                continue;
            }

            if (chat.group) {
                await deleteGroupChatByName(chat.group, chat.fileId);
                continue;
            }

            const characterId = characters.findIndex(character => character?.avatar === chat.avatar);
            if (characterId < 0) {
                skipped.push(`Не найден персонаж: ${chat.ownerName}`);
                continue;
            }
            await deleteCharacterChatByName(String(characterId), chat.fileId);
        }

        if (selectedLorebooks.length > 0) {
            const fresh = await getFreshReferences(state.worldData);
            for (let index = 0; index < selectedLorebooks.length; index++) {
                const lorebook = selectedLorebooks[index];
                setStatus(`Удаляю лорбуки: ${index + 1} / ${selectedLorebooks.length}…`);
                const references = fresh.references.get(lorebook.name) || [];
                if (references.length > 0) {
                    skipped.push(`Лорбук всё ещё используется: ${lorebook.name}`);
                    continue;
                }

                const deleted = await deleteWorldInfo(lorebook.name);
                if (!deleted) skipped.push(`Не удалось удалить лорбук: ${lorebook.name}`);
            }
        }

        const beforeChatKeys = requestedChatKeys;
        const beforeWorldNames = requestedWorldNames;
        await scanCleanupCandidates({ nested: true });
        const deletedChatCount = Array.from(beforeChatKeys).filter(key => !state.allChatKeys.has(key)).length;
        const deletedLorebookCount = Array.from(beforeWorldNames).filter(name => !state.allWorldNames.has(name)).length;
        const skippedSuffix = skipped.length > 0 ? ` Пропущено: ${skipped.length}.` : '';
        setStatus(`Удалено: ${deletedChatCount} чатов и ${deletedLorebookCount} лорбуков.${skippedSuffix}`, 'success');
        if (skipped.length > 0) console.warn(`${MODULE_NAME}: skipped cleanup items:`, skipped);
        const completionMessage = createBackup
            ? 'Очистка завершена, ZIP-бэкап скачан. Результаты пересканированы.'
            : 'Очистка без бэкапа завершена. Результаты пересканированы.';
        toastr.success(completionMessage, 'BB Cleanup Manager');
    } catch (error) {
        console.error(`${MODULE_NAME}: cleanup failed.`, error);
        try {
            await scanCleanupCandidates({ nested: true });
        } catch (rescanError) {
            console.error(`${MODULE_NAME}: recovery scan failed.`, rescanError);
        }
        setStatus(`Очистка остановлена: ${error.message}`, 'error');
        toastr.error('Очистка остановлена. Проверьте результаты пересканирования.', 'BB Cleanup Manager');
    } finally {
        setBusy(false);
    }
}

function settingsMarkup() {
    const settings = getSettings();
    return `
        <div id="bbcm-settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>BB Cleanup Manager</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <p class="bbcm-description">Ищет старые короткие чаты и лорбуки без полезных привязок. Сам ничего не удаляет: сначала сканирование, выбор и ZIP-бэкап.</p>
                    <div class="bbcm-settings-grid">
                        <label>
                            <span>Чат старше, дней</span>
                            <input id="bbcm-days-old" class="text_pole" type="number" min="1" max="3650" step="1" value="${settings.daysOld}">
                        </label>
                        <label>
                            <span>Не больше сообщений</span>
                            <input id="bbcm-max-messages" class="text_pole" type="number" min="0" max="1000" step="1" value="${settings.maxMessages}">
                        </label>
                    </div>
                    <div class="buttons_block bbcm-primary-actions">
                        <button id="bbcm-scan" type="button" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            Сканировать
                        </button>
                    </div>
                    <div id="bbcm-status" class="bbcm-status" role="status">Сканирование ещё не запускалось.</div>
                    <div id="bbcm-result-summary" class="bbcm-result-summary" hidden>
                        <div>
                            <strong id="bbcm-summary-text">Найдено: 0 чатов, 0 лорбуков.</strong>
                            <small>Просмотр и выбор открываются в отдельном адаптивном окне.</small>
                        </div>
                        <button id="bbcm-open-manager" type="button" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-broom-ball"></i>
                            Открыть менеджер
                            <span id="bbcm-open-manager-count" class="bbcm-count">0</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function managerMarkup() {
    return `
        <div id="bbcm-manager" class="bbcm-manager">
            <details class="bbcm-mobile-overview" open>
                <summary class="bbcm-mobile-overview-summary">
                    <span><i class="fa-solid fa-broom-ball"></i> Обзор сканирования</span>
                    <i class="fa-solid fa-chevron-down bbcm-mobile-overview-chevron"></i>
                </summary>
                <div class="bbcm-manager-header">
                    <div>
                        <h3><i class="fa-solid fa-broom-ball"></i> Менеджер очистки</h3>
                        <p>Проверьте кандидатов перед экспортом или удалением.</p>
                    </div>
                    <button id="bbcm-manager-rescan" type="button" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i> Пересканировать</button>
                </div>
                <div class="bbcm-manager-stats">
                    <div><i class="fa-regular fa-comments"></i><span><strong id="bbcm-manager-chat-count">0</strong><small>чатов</small></span></div>
                    <div><i class="fa-solid fa-book"></i><span><strong id="bbcm-manager-lorebook-count">0</strong><small>лорбуков</small></span></div>
                </div>
                <div id="bbcm-manager-status" class="bbcm-status" role="status"></div>
            </details>
            <div class="bbcm-tabs" role="tablist" aria-label="Тип данных">
                <button type="button" class="bbcm-tab" data-tab="chats" role="tab">Чаты <span id="bbcm-tab-chat-count" class="bbcm-count">0</span></button>
                <button type="button" class="bbcm-tab" data-tab="lorebooks" role="tab">Лорбуки <span id="bbcm-tab-lorebook-count" class="bbcm-count">0</span></button>
            </div>
            <div class="bbcm-manager-toolbar">
                <label class="bbcm-search-field">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="bbcm-search" class="text_pole" type="search" autocomplete="off">
                </label>
                <select id="bbcm-sort" class="text_pole" aria-label="Сортировка"></select>
                <label class="checkbox_label bbcm-select-visible-label">
                    <input id="bbcm-select-visible" type="checkbox">
                    <span>Выбрать видимые</span>
                </label>
                <span id="bbcm-visible-count" class="bbcm-visible-count">Показано: 0</span>
            </div>
            <div class="bbcm-manager-content">
                <section id="bbcm-chats-panel" class="bbcm-tab-panel" role="tabpanel">
                    <div id="bbcm-chat-list" class="bbcm-card-list"></div>
                </section>
                <section id="bbcm-lorebooks-panel" class="bbcm-tab-panel" role="tabpanel" hidden>
                    <p class="bbcm-hint">Лорбук, связанный только с чатами-кандидатами, станет доступен после выбора всех этих чатов.</p>
                    <div id="bbcm-lorebook-list" class="bbcm-card-list"></div>
                </section>
            </div>
            <div class="bbcm-manager-footer">
                <strong id="bbcm-selected-count">Выбрано: 0 чатов, 0 лорбуков</strong>
                <div class="buttons_block">
                    <button id="bbcm-export-selected" type="button" class="menu_button menu_button_icon" disabled><i class="fa-solid fa-file-zipper"></i> Скачать ZIP</button>
                    <button id="bbcm-delete-selected" type="button" class="menu_button menu_button_icon redWarningBG" disabled><i class="fa-solid fa-trash-can"></i> Удалить</button>
                </div>
            </div>
        </div>
    `;
}

async function openManager() {
    if (!state.scannedAt) {
        toastr.info('Сначала запустите сканирование.', 'BB Cleanup Manager');
        return;
    }
    if (state.managerPopup) return;

    const popup = new Popup(managerMarkup(), POPUP_TYPE.TEXT, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: false,
        okButton: false,
        cancelButton: 'Закрыть',
        onClosing: () => {
            if (!state.busy) return true;
            toastr.info('Дождитесь завершения текущей операции.', 'BB Cleanup Manager');
            return false;
        },
    });
    state.managerPopup = popup;
    state.managerRoot = popup.dlg.querySelector('#bbcm-manager');
    bindManagerEvents();
    const drawerStatus = $('#bbcm-status');
    $(state.managerRoot).find('#bbcm-manager-status')
        .text(drawerStatus.text())
        .toggleClass('bbcm-status-success', drawerStatus.hasClass('bbcm-status-success'))
        .toggleClass('bbcm-status-error', drawerStatus.hasClass('bbcm-status-error'));
    renderManager();
    collapseMobileOverview();

    try {
        await popup.show();
    } finally {
        state.managerPopup = null;
        state.managerRoot = null;
    }
}

function bindEvents() {
    const root = $('#bbcm-settings');

    root.on('change', '#bbcm-days-old, #bbcm-max-messages', function () {
        const settings = getSettings();
        settings.daysOld = clampInteger($('#bbcm-days-old').val(), 1, 3650, DEFAULT_SETTINGS.daysOld);
        settings.maxMessages = clampInteger($('#bbcm-max-messages').val(), 0, 1000, DEFAULT_SETTINGS.maxMessages);
        $('#bbcm-days-old').val(settings.daysOld);
        $('#bbcm-max-messages').val(settings.maxMessages);
        saveSettingsDebounced();
        if (state.scannedAt) setStatus('Настройки изменены. Запустите сканирование ещё раз.');
    });

    root.on('click', '#bbcm-scan', () => scanCleanupCandidates());
    root.on('click', '#bbcm-open-manager', openManager);
}

function bindManagerEvents() {
    if (!state.managerRoot) return;
    const root = $(state.managerRoot);

    root.on('click', '#bbcm-manager-rescan', () => scanCleanupCandidates({ preserveSelection: true }));
    root.on('click', '#bbcm-export-selected', exportSelected);
    root.on('click', '#bbcm-delete-selected', deleteSelected);

    root.on('click', '.bbcm-tab', function () {
        const tab = String(this.dataset.tab || '');
        if (!['chats', 'lorebooks'].includes(tab)) return;
        state.activeTab = tab;
        renderManager();
    });

    root.on('input', '#bbcm-search', function () {
        state.searchByTab[state.activeTab] = String(this.value || '');
        renderChatCards();
        renderLorebookCards();
        updateSelectionControls();
    });

    root.on('change', '#bbcm-sort', function () {
        state.sortByTab[state.activeTab] = String(this.value || '');
        renderChatCards();
        renderLorebookCards();
        updateSelectionControls();
    });

    root.on('change', '#bbcm-select-visible', function () {
        const items = getVisibleItems();
        if (state.activeTab === 'chats') {
            items.forEach(chat => this.checked ? state.selectedChats.add(chat.key) : state.selectedChats.delete(chat.key));
        } else {
            items.filter(canSelectLorebook).forEach(book => this.checked ? state.selectedLorebooks.add(book.name) : state.selectedLorebooks.delete(book.name));
        }
        renderManager();
    });

    root.on('change', '.bbcm-chat-select', function () {
        const key = decodeKey(this.dataset.key);
        if (this.checked) state.selectedChats.add(key);
        else state.selectedChats.delete(key);
        renderManager();
    });

    root.on('change', '.bbcm-lorebook-select', function () {
        const name = String(this.dataset.name || '');
        if (this.checked) state.selectedLorebooks.add(name);
        else state.selectedLorebooks.delete(name);
        renderManager();
    });

    root.on('click', '.bbcm-result-card', function (event) {
        if ($(event.target).closest('button, input, label, a').length > 0) return;
        const checkbox = $(this).find('.bbcm-card-checkbox:not(:disabled)').get(0);
        if (!checkbox) return;
        checkbox.checked = !checkbox.checked;
        $(checkbox).trigger('change');
    });

    root.on('click', '.bbcm-preview-chat', function () {
        const chat = getChatByKey(decodeKey(this.dataset.key));
        if (chat) previewChat(chat);
    });

    root.on('click', '.bbcm-preview-lorebook', function () {
        const lorebook = getLorebookByName(String(this.dataset.name || ''));
        if (lorebook) previewLorebook(lorebook);
    });
}

jQuery(async () => {
    const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!target || document.querySelector('#bbcm-settings')) return;
    target.insertAdjacentHTML('beforeend', settingsMarkup());
    bindEvents();
});
