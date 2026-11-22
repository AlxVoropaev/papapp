import { api as backendApi, cloud, shortCodes, subscribeVideos } from './backend.js';
import { createWebUpdater } from './web-update.js';
import { categoryList, categoryName, validCategoryName, videoTags } from './catalog.js';
import { normalizeYoutubeTitle, youtubeId, youtubeTitle } from './youtube.js';
import { createTagSuggestions } from './tag-suggestions.js';

const app = document.querySelector('#app');
const libraryActions = document.querySelector('#library-actions');
const modal = document.querySelector('#modal');
const modalTitle = document.querySelector('#dialog-title');
const modalBody = document.querySelector('#dialog-body');
const toast = document.querySelector('#toast');
let categories = categoryList();
let disposeModal;
let session;
let videos = [];
let filter = 'Все';
let status = '';
let toastTimer;
let player;
let playbackEpoch = 0;
let youtubeApi;
let refreshId = 0;
let pendingShare;
let unsubscribe;
let pendingRequests = 0;
let installingApk = false;
function safeToReplaceApp() {
  return Boolean(window.polkaReady) && document.visibilityState === 'visible'
    && !modal.open && !player && !pendingRequests
    && (!pendingShare || session?.role === 'child')
    && !document.querySelector('form')
    && !document.activeElement?.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
const webVersion = document.querySelector('meta[name="polka-version"]')?.content;
const releaseVersion = typeof __POLKA_RELEASE_VERSION__ === 'string' ? __POLKA_RELEASE_VERSION__ : '';
const metadataEndpoint = typeof __POLKA_VIDEO_TITLE_ENDPOINT__ === 'string' ? __POLKA_VIDEO_TITLE_ENDPOINT__ : '';
const updates = createWebUpdater({
  version: webVersion,
  canReload: () => !installingApk && navigator.onLine && safeToReplaceApp(),
  reload: () => location.reload()
});
// Called only by the Android host using evaluateJavascript; no native bridge is exposed to frames.
window.polkaBeginApkUpdate = () => {
  if (installingApk) return true;
  if (!safeToReplaceApp()) return false;
  installingApk = true;
  document.body.inert = true;
  return true;
};
window.polkaEndApkUpdate = () => {
  installingApk = false;
  document.body.inert = false;
  updates.reconsider();
};

async function api(...args) {
  pendingRequests++;
  try {
    return await backendApi(...args);
  } finally {
    pendingRequests--;
    updates.reconsider();
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label, className, action) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

const iconPaths = {
  refresh: 'M20 4v5h-5M4 20v-5h5M5 9a8 8 0 0 1 13-3l2 3M4 15l2 3a8 8 0 0 0 13-3',
  add: 'M12 5v14M5 12h14',
  settings: 'M10 3h4l.7 3 1.4.8 3-.9 2 3.5-2.2 2v1.6l2.2 2-2 3.5-3-.9-1.4.8-.7 3h-4l-.7-3-1.4-.8-3 .9-2-3.5 2.2-2v-1.6l-2.2-2 2-3.5 3 .9L9.3 6zM15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0z',
  edit: 'm14.5 5.5 4 4M4 20l1-5L16 4a2.8 2.8 0 0 1 4 4L9 19z',
  remove: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5'
};

function iconButton(icon, label, action, accessibleName = label) {
  const node = button('', 'icon-button', action);
  node.title = label;
  node.setAttribute('aria-label', accessibleName);
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', iconPaths[icon]);
  svg.append(path);
  node.append(svg);
  return node;
}

const refreshButton = iconButton('refresh', 'Обновить', () => refresh(true));
const addButton = iconButton('add', 'Добавить видео', () => add());
addButton.classList.add('primary');
const settingsButton = iconButton('settings', 'Настройки', parentSettings);
libraryActions.append(refreshButton, addButton, settingsButton);

function message(text) {
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function showModal(title, content, className = '') {
  disposeModal?.();
  disposeModal = undefined;
  playbackEpoch++;
  player?.destroy();
  player = null;
  modal.className = className;
  modalTitle.textContent = title;
  modalBody.replaceChildren(content);
  if (!modal.open) modal.showModal();
}

document.querySelector('#close').onclick = () => modal.close();
modal.addEventListener('close', () => {
  // A queued close event can arrive after login has already opened the shared-link form.
  if (modal.open) return;
  disposeModal?.();
  disposeModal = undefined;
  playbackEpoch++;
  player?.destroy();
  player = null;
  modalBody.replaceChildren();
  updates.reconsider();
});
window.polkaCloseDialog = () => {
  if (!modal.open) return false;
  modal.close();
  return true;
};
window.polkaPausePlayback = () => player?.pauseVideo?.();

function field(name, label, { type = 'text', placeholder = '', required = false, minLength, maxLength, autocomplete, value = '', inputMode, hint } = {}) {
  const wrapper = element('label', '', label);
  const control = element(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') control.type = type;
  Object.assign(control, { name, placeholder, required, value });
  control.setAttribute('aria-label', label);
  if (minLength) control.minLength = minLength;
  if (maxLength) control.maxLength = maxLength;
  if (autocomplete) control.autocomplete = autocomplete;
  if (inputMode) control.inputMode = inputMode;
  wrapper.append(control);
  if (hint) wrapper.append(element('span', 'hint', hint));
  return wrapper;
}

function form(fields, label, onSubmit) {
  const node = element('form');
  const error = element('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const submit = element('button', 'primary', label);
  node.append(...fields, error, submit);
  node.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try {
      const values = new FormData(node);
      const data = Object.fromEntries(values);
      if (node.querySelector('[data-categories]')) data.categories = values.getAll('categories');
      await onSubmit(data);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  return node;
}

async function openSession(next) {
  session = next;
  refreshId++;
  videos = [];
  filter = 'Все';
  categories = categoryList();
  status = 'Загружаем видео…';
  if (modal.open) modal.close();
  renderLibrary();
  unsubscribe?.();
  unsubscribe = subscribeVideos(next, applyVideos, libraryError, applyCategories);
  if (!cloud) await refresh();
  if (session?.role === 'parent' && pendingShare) {
    const url = pendingShare;
    pendingShare = undefined;
    add(url);
  }
}

function welcome(error = '') {
  libraryActions.hidden = true;
  const wrap = element('section', 'welcome');
  const hero = element('div', 'hero');
  hero.append(element('h1', '', 'Видео от папы'), element('p', '', 'Семейная подборка любимых видео.'));
  const actions = element('div', 'panel stack');
  if (error) {
    actions.append(element('p', 'form-error', error), button('Повторить', 'primary', start));
  } else {
    actions.append(
      button('Ввести код с телефона папы', 'primary', join),
      button('Создать полку', 'secondary', create),
      button('Войти как родитель', 'quiet', login)
    );
  }
  wrap.append(hero, actions);
  app.replaceChildren(wrap);
}

function create() {
  showModal('Создать полку', form([
    field('name', 'Название полки', { value: 'Видео полка', required: true, maxLength: 60 }),
    ...(cloud ? [field('email', 'Почта родителя', { type: 'email', required: true, autocomplete: 'email', maxLength: 254 })] : []),
    field('password', 'Пароль родителя', { type: 'password', minLength: 8, maxLength: 128, required: true, autocomplete: 'new-password', hint: 'Минимум 8 символов' }),
    ...(cloud || document.documentElement.dataset.setupKey === 'required' ? [
      field('setupKey', 'Ключ создания', { type: 'password', required: true, maxLength: 256 })
    ] : [])
  ], 'Создать', async data => openSession(await api('families', 'POST', data))));
}

function login() {
  const panel = element('div', 'stack');
  panel.append(form([
    cloud ? field('email', 'Почта родителя', { type: 'email', required: true, maxLength: 254, autocomplete: 'username' })
      : field('family', 'Номер полки', { required: true, maxLength: 12, autocomplete: 'username' }),
    field('password', 'Пароль родителя', { type: 'password', required: true, maxLength: 128, autocomplete: 'current-password' })
  ], 'Войти', async data => openSession(await api('login', 'POST', data))));
  if (cloud) panel.append(button('Забыли пароль?', 'quiet', resetPassword));
  showModal('Войти как родитель', panel);
}

function resetPassword() {
  showModal('Восстановить пароль', form([
    field('email', 'Почта родителя', { type: 'email', required: true, maxLength: 254, autocomplete: 'email' })
  ], 'Отправить ссылку', async data => {
    await api('reset-password', 'POST', data);
    modal.close();
    message('Если аккаунт существует, ссылка придёт на почту.');
  }));
}

function join() {
  showModal('Подключить полку', form([
    field('code', cloud ? 'Код подключения' : 'Код из 6 цифр', { inputMode: shortCodes ? 'numeric' : 'text', required: true, maxLength: cloud ? 38 : 15, autocomplete: 'one-time-code', hint: 'На телефоне папы откройте «Настройки» → «Подключить устройство».' })
  ], 'Подключить', async data => openSession(await api('join', 'POST', data))));
}

function categoryField(values = []) {
  const group = element('fieldset', 'tag-picker');
  group.dataset.categories = '';
  group.append(element('legend', '', 'Темы'));
  for (const category of categories.filter(c => c.id !== 'Другое')) {
    const label = element('label', 'tag-option');
    const checkbox = element('input');
    Object.assign(checkbox, { type: 'checkbox', name: 'categories', value: category.id, checked: values.includes(category.id) });
    label.append(checkbox, element('span', '', category.name));
    group.append(label);
  }
  group.append(element('p', 'hint', 'Можно выбрать до 9 тем. Без тем видео попадёт в «Другое».'));
  return group;
}

function add(url = '') {
  const urlField = field('url', 'Ссылка на YouTube', { required: true, inputMode: 'url', placeholder: 'https://youtu.be/…', maxLength: 2048, value: url });
  const titleField = field('title', 'Название', { maxLength: 160, required: true });
  const urlInput = urlField.querySelector('input');
  const titleInput = titleField.querySelector('input');
  const tags = categoryField();
  const suggestions = createTagSuggestions({
    request: title => api('tag-suggestions', 'POST', { title }),
    onChange: renderTagSuggestions
  });
  const tagHint = element('p', 'hint tag-suggestion-status');
  tagHint.setAttribute('role', 'status');
  tagHint.setAttribute('aria-live', 'polite');
  const applySuggestions = button('Применить подсказки', 'quiet', () => {
    selectTags(suggestions.accept());
    updateTagSuggestions();
  });
  applySuggestions.hidden = true;
  const suggestionPanel = element('div', 'tag-suggestions');
  suggestionPanel.append(tagHint, applySuggestions);
  tags.append(suggestionPanel);
  function selectTags(ids) {
    for (const input of tags.querySelectorAll('input')) input.checked = ids.includes(input.value);
  }
  function updateTagSuggestions() {
    renderTagSuggestions(suggestions.update(normalizeYoutubeTitle(titleInput.value), categories));
  }
  function renderTagSuggestions(result) {
    if (result.apply) selectTags(result.suggested);
    const names = result.suggested.map(id => categoryName(categories, id)).join(', ');
    const prefix = result.source === 'llm' ? 'AI предложил: ' : 'По названию выбраны: ';
    tagHint.textContent = !titleInput.value.trim() ? 'Предложим темы, когда появится название.'
      : result.apply ? (names ? prefix + names + '. Можно изменить.' : 'Подходящих тем по названию не нашли. Выберите их сами.')
        : (names ? 'Ваш выбор сохранён. Подсказки по названию: ' + names + '.' : 'Ваш выбор сохранён. Других подсказок по названию нет.');
    if (result.loading) tagHint.textContent += ' Проверяем подсказки с AI…';
    else if (result.unavailable) tagHint.textContent += ' AI недоступен; показаны подсказки по словам.';
    applySuggestions.hidden = result.apply || !result.suggested.length;
  }
  tags.addEventListener('change', () => {
    suggestions.markManual();
    updateTagSuggestions();
  });
  updateTagSuggestions();
  const feedback = element('span', 'hint', 'Вставьте ссылку — название загрузится автоматически. Его можно изменить.');
  feedback.setAttribute('role', 'status');
  const retry = button('Повторить загрузку названия', 'quiet', () => lookup(true));
  retry.hidden = true;
  titleField.append(feedback, retry);
  let timer;
  let request;
  let lastId;
  let automaticTitle = '';
  let revision = 0;
  let closed = false;
  titleInput.addEventListener('input', () => { revision++; updateTagSuggestions(); });
  async function lookup(force = false) {
    clearTimeout(timer);
    const id = youtubeId(urlInput.value);
    if (!id || (id === lastId && !force)) return;
    request?.abort();
    request = new AbortController();
    const current = request;
    const editRevision = revision;
    lastId = id;
    retry.hidden = true;
    feedback.textContent = 'Загружаем название с YouTube…';
    try {
      const result = await youtubeTitle(urlInput.value, { signal: current.signal, metadataEndpoint });
      if (closed || current !== request || id !== youtubeId(urlInput.value)) return;
      if (editRevision === revision && (!titleInput.value || titleInput.value === automaticTitle)) {
        titleInput.value = result.title;
        automaticTitle = result.title;
        feedback.textContent = 'Название получено с YouTube. Его можно изменить.';
        updateTagSuggestions();
      } else feedback.textContent = 'Название оставлено как вы ввели.';
    } catch (e) {
      if (closed || current.signal.aborted || current !== request) return;
      feedback.textContent = e.message;
      retry.hidden = false;
    }
  }
  urlInput.addEventListener('input', () => {
    clearTimeout(timer);
    request?.abort();
    request = undefined;
    const id = youtubeId(urlInput.value);
    if (id !== lastId) {
      if (titleInput.value === automaticTitle) titleInput.value = '';
      automaticTitle = '';
      lastId = undefined;
      updateTagSuggestions();
    }
    retry.hidden = true;
    feedback.textContent = id ? 'Загружаем название с YouTube…' : 'Вставьте ссылку на видео YouTube. Название также можно ввести вручную.';
    if (id) timer = setTimeout(() => lookup(true), 400);
  });
  showModal('Добавить видео', form([
    urlField, titleField, tags,
    field('note', 'Заметка для сына', { type: 'textarea', maxLength: 240, placeholder: 'Необязательно' })
  ], 'Добавить на полку', async data => {
    const ownerForm = urlField.closest('form');
    await api('videos', 'POST', data);
    if (ownerForm?.isConnected) modal.close();
    filter = 'Все';
    await refresh();
    message('Видео добавлено');
  }));
  disposeModal = () => { closed = true; clearTimeout(timer); request?.abort(); suggestions.dispose(); };
  if (url) lookup();
}

function editVideo(video) {
  const editor = form([
    field('title', 'Название', { value: video.title, required: true, maxLength: 160 }),
    categoryField(videoTags(video, categories)),
    field('note', 'Заметка для сына', { type: 'textarea', value: video.note, maxLength: 240 })
  ], 'Сохранить', async data => {
    await api('videos/' + video.id, 'PATCH', data);
    if (editor.isConnected) modal.close();
    await refresh();
    message('Видео изменено');
  });
  showModal('Редактировать видео', editor);
}

function categoryEditor() {
  const box = element('div', 'stack category-editor');
  box.append(element('p', 'hint', 'Переименование изменит тему у всех её видео. При удалении темы остальные теги сохранятся. Видео без тегов попадут в «Другое».'));
  for (const category of categories) {
    const row = element('div', 'category-row');
    row.append(element('span', 'category-label', category.name));
    if (category.id !== 'Другое') {
      row.append(button('Изменить', 'quiet', () => categoryRename(category)));
      const remove = button('Удалить', 'quiet', () => categoryRemove(category));
      remove.setAttribute('aria-label', 'Удалить тему ' + category.name);
      row.append(remove);
    } else row.append(element('span', 'hint', 'Для видео без темы'));
    box.append(row);
  }
  const editor = form([field('name', 'Новая тема', { required: true, maxLength: 40, placeholder: 'Например, Космос' })], 'Добавить тему', async data => {
    validCategoryName(data.name);
    const result = await api('categories', 'POST', data);
    applyCategories(result.categories);
    if (editor.isConnected) categoryEditor();
    message('Тема добавлена');
  });
  box.append(editor, button('Назад в настройки', 'quiet', parentSettings));
  showModal('Темы видео', box);
}

function categoryRename(category) {
  const editor = form([field('name', 'Название темы', { value: category.name, required: true, maxLength: 40 })], 'Сохранить', async data => {
    validCategoryName(data.name);
    const result = await api('categories/' + encodeURIComponent(category.id), 'PATCH', data);
    applyCategories(result.categories);
    if (editor.isConnected) categoryEditor();
    message('Тема переименована');
  });
  editor.append(button('Отмена', 'quiet', categoryEditor));
  showModal('Изменить тему', editor);
}

function categoryRemove(category) {
  const box = element('div', 'stack');
  const error = element('p', 'form-error');
  error.setAttribute('role', 'alert');
  const confirm = button('Удалить тему', 'danger', async () => {
    confirm.disabled = true;
    try {
      const result = await api('categories/' + encodeURIComponent(category.id), 'DELETE');
      applyCategories(result.categories);
      if (box.isConnected) categoryEditor();
      message('Тема удалена, видео сохранены');
    } catch (e) { error.textContent = e.message; }
    finally { confirm.disabled = false; }
  });
  box.append(element('p', 'intro', 'Удалить тему «' + category.name + '»? Этот тег исчезнет у её видео. Остальные темы и сами видео сохранятся.'), confirm, button('Отмена', 'quiet', categoryEditor), error);
  showModal('Удалить тему?', box);
}

function remove(video) {
  const box = element('div', 'stack');
  const removeButton = button('Удалить', 'danger', async () => {
    removeButton.disabled = true;
    try {
      await api('videos/' + video.id, 'DELETE');
      modal.close();
      await refresh();
      message('Видео удалено');
    } catch (e) {
      error.textContent = e.message;
    } finally {
      removeButton.disabled = false;
    }
  });
  const error = element('p', 'form-error');
  error.setAttribute('role', 'alert');
  box.append(element('p', 'intro', 'Убрать «' + video.title + '» с полки на всех устройствах?'), removeButton, error);
  showModal('Удалить видео', box);
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApi) return youtubeApi;
  youtubeApi = new Promise((resolve, reject) => {
    const script = element('script');
    script.src = 'https://www.youtube.com/iframe_api';
    const timeout = setTimeout(unavailable, 10000);
    function unavailable() {
      clearTimeout(timeout);
      script.remove();
      youtubeApi = undefined;
      reject(new Error('Не удалось загрузить плеер YouTube.'));
    }
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      resolve(window.YT);
    };
    script.onerror = unavailable;
    document.head.append(script);
  });
  return youtubeApi;
}

function watch(video) {
  const box = element('div');
  const frame = element('div', 'player-frame');
  const mount = element('div');
  const hint = element('p', 'status', 'Загружаем плеер…');
  hint.setAttribute('role', 'status');
  frame.append(mount);
  box.append(frame, hint);
  showModal(video.title, box, 'player');
  const epoch = playbackEpoch;
  const active = () => modal.open && playbackEpoch === epoch;
  const loading = setTimeout(() => {
    if (active()) hint.textContent = 'Плеер долго загружается. Проверьте, доступен ли YouTube в вашей сети.';
  }, 14000);
  loadYouTubeApi().then(YT => {
    if (!active()) {
      clearTimeout(loading);
      return;
    }
    player = new YT.Player(mount, {
      host: 'https://www.youtube-nocookie.com',
      videoId: video.youtube,
      playerVars: { origin: location.origin, rel: 0, playsinline: 1 },
      events: {
        onReady() {
          clearTimeout(loading);
          if (active()) hint.textContent = video.note;
        },
        onStateChange(event) {
          if (active() && event.data === YT.PlayerState.ENDED) modal.close();
        },
        onError(event) {
          clearTimeout(loading);
          if (!active()) return;
          hint.textContent = [100, 101, 150].includes(event.data)
            ? 'Автор ограничил просмотр или видео больше недоступно.'
            : 'YouTube не смог воспроизвести это видео. Попробуйте другое.';
        }
      }
    });
  }).catch(e => {
    clearTimeout(loading);
    if (active()) hint.textContent = e.message;
  });
}

function card(video) {
  const article = element('article', 'card');
  const play = button('', 'card-main', () => watch(video));
  const image = element('img');
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => image.remove());
  image.src = 'https://i.ytimg.com/vi/' + video.youtube + '/hqdefault.jpg';
  const thumb = element('span', 'thumb');
  const playIcon = element('span', 'play', '▶');
  playIcon.setAttribute('aria-hidden', 'true');
  thumb.append(image, playIcon);
  const info = element('span', 'card-text');
  info.append(element('span', 'category', (videoTags(video, categories).map(id => categoryName(categories, id)).join(' · ') || 'Другое')), element('strong', 'card-title', video.title));
  if (video.note) info.append(element('span', 'note', video.note));
  play.append(thumb, info);
  article.append(play);
  if (session.role === 'parent') {
    const actions = element('div', 'card-actions');
    const edit = iconButton('edit', 'Изменить', () => editVideo(video), 'Изменить видео ' + video.title);
    const removeButton = iconButton('remove', 'Удалить', () => remove(video), 'Удалить видео ' + video.title);
    removeButton.classList.add('remove-video');
    actions.append(edit, removeButton);
    article.append(actions);
  }
  return article;
}

function renderLibrary() {
  const parent = session.role === 'parent';
  libraryActions.hidden = false;
  addButton.hidden = !parent;
  settingsButton.hidden = !parent;
  const filters = element('nav', 'filters');
  filters.setAttribute('aria-label', 'Темы видео');
  const effectiveTags = video => { const tags = videoTags(video, categories); return tags.length ? tags : ['Другое']; };
  const available = categories.filter(c => videos.some(video => effectiveTags(video).includes(c.id))).map(c => c.id);
  if (filter !== 'Все' && !available.includes(filter)) filter = 'Все';
  if (available.length) {
    for (const name of ['Все', ...available]) {
      const chip = button(name === 'Все' ? 'Все' : categoryName(categories, name), 'chip', () => {
        filter = name;
        renderLibrary();
        document.querySelector('.chip[aria-pressed=true]')?.focus();
      });
      chip.setAttribute('aria-pressed', String(name === filter));
      filters.append(chip);
    }
  }
  const grid = element('section', 'grid');
  grid.setAttribute('aria-label', 'Видео');
  for (const video of videos.filter(video => filter === 'Все' || effectiveTags(video).includes(filter))) grid.append(card(video));
  const content = [];
  if (status) {
    const feedback = element('p', 'status', status);
    feedback.setAttribute('role', 'status');
    content.push(feedback);
  }
  if (videos.length) content.push(filters, grid);
  else if (!status) {
    const empty = element('section', 'empty');
    const icon = element('img');
    Object.assign(icon, { src: '/icon.svg', width: 52, height: 52, alt: '' });
    empty.append(icon, element('h2', '', 'Полка пока пуста'), element('p', '', parent
      ? 'Вставьте ссылку на первое видео.'
      : 'Когда папа добавит видео, оно появится здесь.'));
    content.push(empty);
  }
  app.replaceChildren(...content);
}

async function refresh(manual = false) {
  if (!session || installingApk) return;
  const revision = ++refreshId;
  try {
    const result = await api('videos');
    if (revision !== refreshId || !session) return;
    if (result.categories) applyCategories(result.categories);
    applyVideos(result.videos);
    if (manual) message('Полка обновлена');
  } catch (e) {
    if (revision !== refreshId || !session) return;
    libraryError(e);
  }
}

function applyCategories(next) {
  if (!session) return;
  if (JSON.stringify(next) === JSON.stringify(categories)) return;
  categories = next;
  renderLibrary();
}

function applyVideos(next) {
  if (!session) return;
  const changed = JSON.stringify(next) !== JSON.stringify(videos) || status;
  videos = next;
  status = '';
  if (changed) renderLibrary();
}

function libraryError(error) {
  if (!session) return;
  if (error.status === 401) {
    stopSession();
    message('Подключите полку снова');
  } else {
    status = error.message;
    renderLibrary();
  }
}

function stopSession() {
  unsubscribe?.();
  unsubscribe = undefined;
  session = null;
  videos = [];
  refreshId++;
  if (modal.open) modal.close();
  welcome();
}

function parentSettings() {
  if (session?.role !== 'parent') return;
  const box = element('div', 'stack');
  const error = element('p', 'form-error');
  error.setAttribute('role', 'alert');
  const pair = button('Подключить устройство', 'primary', async () => {
    pair.disabled = true;
    try {
      const { code } = await api('pair-code', 'POST');
      if (!modal.open || box.parentElement !== modalBody) return;
      const panel = element('div', 'stack');
      const short = code.length === 6;
      const source = element('p', 'pair-code', code.match(short ? /.{3}/g : /.{1,4}/g).join(' '));
      if (!short) source.classList.add('long-code');
      panel.append(source, element('p', 'status', 'Введите код на втором устройстве. Код действует 10 минут и используется один раз. Новый код отменяет предыдущий.'));
      if (navigator.clipboard) panel.append(button('Скопировать код', 'secondary', async () => {
        try {
          await navigator.clipboard.writeText(source.textContent);
          message('Код скопирован');
        } catch {
          message('Выделите и скопируйте код вручную');
        }
      }));
      showModal('Код подключения', panel);
    } catch (e) {
      error.textContent = e.message;
    } finally {
      pair.disabled = false;
    }
  });
  box.append(
    ...(releaseVersion ? [element('p', 'status', 'Версия ' + releaseVersion)] : []),
    ...(cloud ? [] : [element('p', 'status', 'Номер полки ' + session.family + '. Сохраните его для входа вместе с паролем.')]),
    pair,
    button('Темы видео', 'secondary', categoryEditor),
    button('Отключить детские устройства', 'secondary', disconnect),
    button('Выйти', 'quiet', async () => {
      try {
        await api('logout', 'POST');
        stopSession();
      } catch (e) {
        error.textContent = e.message;
      }
    }),
    error
  );
  showModal('Настройки', box);
}

function disconnect() {
  const box = element('div', 'stack');
  const error = element('p', 'form-error');
  const confirm = button('Отключить', 'danger', async () => {
    confirm.disabled = true;
    try {
      await api('child-devices', 'DELETE');
      modal.close();
      message('Детские устройства отключены');
    } catch (e) {
      error.textContent = e.message;
    } finally {
      confirm.disabled = false;
    }
  });
  box.append(element('p', 'status', 'Для повторного подключения потребуется новый код.'), confirm, error);
  showModal('Отключить устройства?', box);
}

window.polkaReceiveShare = url => {
  if (session?.role === 'parent') add(url);
  else {
    if (!session) pendingShare = url;
    message('Добавлять видео можно в родительском режиме.');
  }
};
if (!cloud) setInterval(() => {
  if (document.visibilityState === 'visible' && !modal.open) refresh();
}, 10000);
document.addEventListener('visibilitychange', () => {
  updates.reconsider();
  if (document.visibilityState === 'visible') {
    refresh();
    updates.check();
  }
});
window.addEventListener('online', () => updates.check());
window.addEventListener('pageshow', () => updates.check());
document.addEventListener('focusout', () => updates.reconsider());
if (webVersion) setInterval(() => {
  if (document.visibilityState === 'visible') updates.check();
}, 3 * 60 * 1000);

async function start() {
  try {
    await openSession(await api('session'));
  } catch (e) {
    welcome(e.status === 401 ? '' : e.message);
  }
  window.polkaReady = true;
  updates.check();
}
start();
