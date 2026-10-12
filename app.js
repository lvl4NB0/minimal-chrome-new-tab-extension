let downloadUserData = null;

(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const status = byId("status");
  const extras = byId("extras");
  const todoList = byId("todo-list");
  const targetList = byId("target-list");
  const searchInput = byId("search-input");
  const suggestions = byId("suggestions");

  let todos = [];
  let targets = [];
  let countdownTimer = null;
  let saveQueued = false;
  let suggestTimer = null;
  let suggestController = null;
  let suggestGeneration = 0;
  let activeSuggestion = -1;
  let currentSuggestions = [];

  const makeId = () => (crypto.randomUUID ? crypto.randomUUID() :
    `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function say(message) {
    status.textContent = message;
    if (message) window.setTimeout(() => {
      if (status.textContent === message) status.textContent = "";
    }, 2500);
  }

  function saveSoon() {
    if (saveQueued) return;
    saveQueued = true;
    queueMicrotask(async () => {
      saveQueued = false;
      try { await chrome.storage.local.set({ todos, targets }); }
      catch { say("保存できませんでした。拡張機能の権限を確認してください。"); }
    });
  }

  // Search suggestions are requested only after the user starts typing.
  // Google endpoint is an unofficial suggestion endpoint, so failures are intentionally non-fatal.
  function hideSuggestions() {
    suggestions.hidden = true;
    suggestions.replaceChildren();
    searchInput.setAttribute("aria-expanded", "false");
    activeSuggestion = -1;
    currentSuggestions = [];
  }

  function chooseSuggestion(value) {
    searchInput.value = value;
    hideSuggestions();
    byId("search-form").requestSubmit();
  }

  function renderSuggestions(items) {
    currentSuggestions = items;
    activeSuggestion = -1;
    const fragment = document.createDocumentFragment();
    for (const value of items) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = value;
      button.addEventListener("pointerdown", (event) => {
        // Keep the input focused until the selected query is submitted.
        event.preventDefault();
        chooseSuggestion(value);
      });
      li.append(button);
      fragment.append(li);
    }
    suggestions.replaceChildren(fragment);
    suggestions.hidden = items.length === 0;
    searchInput.setAttribute("aria-expanded", String(items.length > 0));
  }

  async function fetchSuggestions(query, generation) {
    if (suggestController) suggestController.abort();
    suggestController = new AbortController();
    try {
      const url = new URL("https://suggestqueries.google.com/complete/search");
      url.searchParams.set("client", "firefox");
      url.searchParams.set("q", query);
      const response = await fetch(url, {
        signal: suggestController.signal,
        cache: "default",
        credentials: "omit"
      });
      if (!response.ok) throw new Error("Suggestion request failed");
      const data = await response.json();
      if (generation !== suggestGeneration || searchInput.value.trim() !== query) return;
      const items = Array.isArray(data?.[1])
        ? data[1].filter(item => typeof item === "string").slice(0, 8)
        : [];
      renderSuggestions(items);
    } catch (error) {
      if (error.name !== "AbortError" && generation === suggestGeneration) hideSuggestions();
    }
  }

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();
    suggestGeneration++;
    const generation = suggestGeneration;
    if (suggestTimer !== null) clearTimeout(suggestTimer);
    if (suggestController) suggestController.abort();
    if (!query) {
      hideSuggestions();
      return;
    }
    // Start almost immediately, but coalesce rapid keystrokes to avoid excess requests.
    suggestTimer = window.setTimeout(() => void fetchSuggestions(query, generation), 100);
  });

  searchInput.addEventListener("keydown", (event) => {
    if (suggestions.hidden || currentSuggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeSuggestion = (activeSuggestion + delta + currentSuggestions.length) % currentSuggestions.length;
      const buttons = suggestions.querySelectorAll("button");
      buttons.forEach((button, index) => {
        button.setAttribute("aria-selected", String(index === activeSuggestion));
      });
    } else if (event.key === "Enter" && activeSuggestion >= 0) {
      event.preventDefault();
      chooseSuggestion(currentSuggestions[activeSuggestion]);
    } else if (event.key === "Escape") {
      hideSuggestions();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".search-wrap")) hideSuggestions();
  });
  byId("search-form").addEventListener("submit", () => hideSuggestions());

  // Google apps launcher: local links only; no API or additional network request until clicked.
  const appsButton = byId("apps-button");
  const appsMenu = byId("apps-menu");
  function setAppsOpen(open) {
    appsMenu.hidden = !open;
    appsButton.setAttribute("aria-expanded", String(open));
  }
  appsButton.addEventListener("click", () => setAppsOpen(appsMenu.hidden));
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".topbar")) setAppsOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setAppsOpen(false);
  });

  function formatRemaining(isoDate) {
    const ms = new Date(isoDate).getTime() - Date.now();
    if (!Number.isFinite(ms)) return "日時を確認してください";
    if (ms <= 0) return "予定時刻を過ぎています";
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `あと ${days}日 ${hours}時間 ${minutes}分`;
    if (hours > 0) return `あと ${hours}時間 ${minutes}分`;
    return `あと ${minutes}分`;
  }

  function makeButton(label, action, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", title || label);
    button.addEventListener("click", action);
    return button;
  }

  function renderTodos() {
    const fragment = document.createDocumentFragment();
    if (todos.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "Todoはありません";
      fragment.append(empty);
    }
    for (const todo of todos) {
      const li = document.createElement("li");
      li.className = `item${todo.done ? " done" : ""}`;
      const main = document.createElement("div");
      main.className = "item-main";
      const title = document.createElement("span");
      title.className = "item-title";
      title.textContent = todo.title;
      main.append(title);
      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(makeButton(todo.done ? "戻す" : "完了", () => {
        todo.done = !todo.done; saveSoon(); renderTodos();
      }, todo.done ? "未完了に戻す" : "完了にする"));
      actions.append(makeButton("削除", () => {
        todos = todos.filter(x => x.id !== todo.id); saveSoon(); renderTodos();
      }, "Todoを削除"));
      li.append(main, actions);
      fragment.append(li);
    }
    todoList.replaceChildren(fragment);
  }

  function renderTargets() {
    const fragment = document.createDocumentFragment();
    if (targets.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "予定はありません";
      fragment.append(empty);
    }
    const ordered = [...targets].sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const target of ordered) {
      const li = document.createElement("li");
      li.className = "item";
      const main = document.createElement("div");
      main.className = "item-main";
      const title = document.createElement("span");
      title.className = "item-title";
      title.textContent = target.title;
      const meta = document.createElement("span");
      meta.className = "item-meta";
      meta.dataset.targetId = target.id;
      meta.textContent = `${new Date(target.date).toLocaleString()} · ${formatRemaining(target.date)}`;
      main.append(title, meta);
      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(makeButton("削除", () => {
        targets = targets.filter(x => x.id !== target.id); saveSoon(); renderTargets();
      }, "カウントダウンを削除"));
      li.append(main, actions);
      fragment.append(li);
    }
    targetList.replaceChildren(fragment);
  }

  function updateCountdownText() {
    for (const element of targetList.querySelectorAll("[data-target-id]")) {
      const target = targets.find(x => x.id === element.dataset.targetId);
      if (target) element.textContent = `${new Date(target.date).toLocaleString()} · ${formatRemaining(target.date)}`;
    }
  }

  byId("todo-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = byId("todo-title");
    const title = input.value.trim();
    if (!title) return;
    todos.push({ id: makeId(), title, done: false });
    input.value = ""; saveSoon(); renderTodos();
  });

  byId("target-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = byId("target-title").value.trim();
    const date = byId("target-date").value;
    if (!title || !date || !Number.isFinite(new Date(date).getTime())) {
      say("予定名と正しい日時を入力してください。"); return;
    }
    targets.push({ id: makeId(), title, date: new Date(date).toISOString() });
    byId("target-title").value = ""; byId("target-date").value = "";
    saveSoon(); renderTargets();
  });

  downloadUserData = async function(){
    let todosData, targetsData;
    try{
      [todosData, targetsData] = await getStorage();
    }catch(e){ console.log(`保存データを読み込めませんでした。: ${e}`); return;}
    const data = {
                "todos" : todosData,
                "targets" : targetsData
            };
            const jsonString = JSON.stringify(data, null, 2);
            
            const blob = new Blob([jsonString], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = "minimal-new-tab_data.json";
            document.body.appendChild(a);
            a.click();

            document.body.removeChild(a);
            URL.revokeObjectURL(url);
  }

  const fileInput = document.getElementById("file-input");
  const backupCheck = document.getElementById("backup-check");
  async function getBackup(){
    let backup;
    try { backup = await getStorage() }
    catch(e){
      console.error(e)
      return {backup: null, success: false}
    }
    return {backup: backup, success: true}
  }

   async function importUserData(userData, shouldMakeBackup = true){
    todos = userData.todos;
    targets = userData.targets;
    if(shouldMakeBackup){ 
      const {backup, success} = await getBackup();
      if(!success){ 
        say("バックアップの作成に失敗したため中断しました。");
        return;
      }
      await chrome.storage.local.set({todos, targets, backup});
    }else{
      await chrome.storage.local.set({todos, targets})
    }
    initializeExtras()
    say("読み込みに成功しました。")
  }
  fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      let jsonData = {};
      try{
        jsonData = JSON.parse(e.target.result);
      }catch(e){
        if(e instanceof SyntaxError){ say("不正なjsonファイルです。"); }
        else console.error(e);
        return;
      }
      if(!jsonData.hasOwnProperty("todos") || !jsonData.hasOwnProperty("targets")){
        say("要求される形式と異なるjsonファイルです。");
        return;
      }
      importUserData(jsonData, backupCheck.checked)
    };
    reader.readAsText(file);
  });

  async function getStorage(){
    const saved = await chrome.storage.local.get(["todos", "targets"]);
    const todosData = Array.isArray(saved.todos) ? saved.todos : [];
    const targetsData = Array.isArray(saved.targets) ? saved.targets : [];
    return [todosData, targetsData]
  }

  async function initializeExtras() {
    try {
      [todos, targets] = await getStorage()
    } catch { say("保存データを読み込めませんでした。"); }
    renderTodos(); renderTargets(); extras.hidden = false;
    if (countdownTimer !== null) clearInterval(countdownTimer);
    countdownTimer = window.setInterval(updateCountdownText, 60000);
  }

  function startAfterInitialPaint() {
    window.setTimeout(() => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => { void initializeExtras(); }, { timeout: 1500 });
      } else {
        void initializeExtras();
      }
    }, 20);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
    } else if (!extras.hidden && countdownTimer === null) {
      updateCountdownText(); countdownTimer = window.setInterval(updateCountdownText, 60000);
    }
  });

  startAfterInitialPaint();
})();