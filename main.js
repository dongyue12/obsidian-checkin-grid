"use strict";
/*
 * Checkin Grid — markdown 原生打卡插件
 * 数据全部存在 ```checkin 代码块里，一行一个习惯：
 *   - 早起 | 2026-11-05, 2026-11-06
 * 点击格子即打勾/取消，改动直接写回笔记。
 */
const { Plugin, MarkdownRenderChild, Modal, Notice, setIcon, debounce } = require("obsidian");

const ALIASES = ["checkin", "daka", "打卡"];
const DAY_OPTIONS = [7, 14, 30];
const WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/* ---------------- 日期工具 ---------------- */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function today0() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/* ---------------- 解析 / 序列化 ---------------- */
function parseSource(source) {
  const habits = [];
  const otherLines = [];
  source.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/^-\s+(.*?)\s*(?:\|\s*(.*))?$/);
    if (!m) {
      otherLines.push(raw);
      return;
    }
    const name = (m[1] || "").trim();
    if (!name) return;
    const dates = (m[2] || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    habits.push({ name, dates: new Set(dates) });
  });
  return { habits, otherLines };
}

function serializeLine(habit) {
  const ds = [...habit.dates].sort().join(", ");
  return ds ? `- ${habit.name} | ${ds}` : `- ${habit.name}`;
}

/* ---------------- 主插件 ---------------- */
class CheckinGridPlugin extends Plugin {
  async onload() {
    this.views = new Set();
    this.settings = Object.assign({ days: 7 }, await this.loadData());
    ALIASES.forEach((alias) => {
      this.registerMarkdownCodeBlockProcessor(alias, (source, el, ctx) => {
        ctx.addChild(new CheckinView(el, source, ctx, this.app, this, alias));
      });
    });
  }
  onunload() {
    if (this.views) this.views.clear();
  }
  async setDays(n) {
    this.settings.days = n;
    await this.saveData(this.settings);
    // 切换天数后表格宽度变了，重新定位到今天
    for (const v of this.views) {
      v.autoPositioned = false;
      v.userScrolled = false;
      v.lastScroll = null;
      v.render();
    }
  }
}

/* ---------------- 渲染 ---------------- */
class CheckinView extends MarkdownRenderChild {
  constructor(containerEl, source, ctx, app, plugin, alias) {
    super(containerEl);
    this.source = source;
    this.ctx = ctx;
    this.app = app;
    this.plugin = plugin;
    this.alias = alias;
    this.habits = [];
    this.otherLines = [];
    this.lastScroll = null;
    this.autoPositioned = false;
    this.userScrolled = false;
    this._ro = null;
    this.save = debounce(() => this.saveChanges(), 400, true);
  }

  onload() {
    this.parse();
    this.render();
    this.plugin.views.add(this);
  }

  onunload() {
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    this.plugin.views.delete(this);
  }

  parse() {
    const parsed = parseSource(this.source);
    this.habits = parsed.habits;
    this.otherLines = parsed.otherLines;
  }

  get days() {
    return this.plugin.settings.days || 7;
  }

  windowDates() {
    const t = today0();
    const out = [];
    for (let i = this.days - 1; i >= 0; i--) out.push(addDays(t, -i));
    return out;
  }

  streakOf(habit) {
    const t = today0();
    let cursor = habit.dates.has(ymd(t)) ? t : addDays(t, -1);
    let n = 0;
    while (habit.dates.has(ymd(cursor))) {
      n++;
      cursor = addDays(cursor, -1);
    }
    return n;
  }

  render() {
    const prev = this.containerEl.querySelector(".checkin-scroll");
    if (prev) this.lastScroll = prev.scrollLeft;
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }

    this.containerEl.empty();
    const wrapper = this.containerEl.createDiv({ cls: "checkin-wrapper" });
    // 内联兜底：样式文件没同步/被主题覆盖时，仍保证整块不超出屏幕宽度
    const setS = (el, prop, val) => el.style.setProperty(prop, val, "important");
    setS(wrapper, "width", "100%");
    setS(wrapper, "max-width", "100%");
    setS(wrapper, "box-sizing", "border-box");
    setS(wrapper, "overflow", "hidden");
    const coarse = typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;

    const todayKey = ymd(today0());
    const doneToday = this.habits.filter((h) => h.dates.has(todayKey)).length;

    const topbar = wrapper.createDiv({ cls: "checkin-topbar" });
    topbar.createSpan({ cls: "checkin-title", text: "打卡" });
    const topRight = topbar.createDiv({ cls: "checkin-top-right" });
    const todayEl = topRight.createSpan({
      cls: `checkin-today${doneToday === this.habits.length && doneToday > 0 ? " is-all-done" : ""}`,
      text: this.habits.length ? `今日 ${doneToday}/${this.habits.length}` : "今日 0/0",
    });
    todayEl.title = "点击定位到今天";
    todayEl.classList.add("is-clickable");
    todayEl.onclick = () => this.scrollToToday();
    const locateBtn = topRight.createEl("button", {
      cls: "checkin-locate-btn",
      text: "回到今天",
    });
    locateBtn.setAttribute("aria-label", "定位到今天");
    locateBtn.onclick = () => this.scrollToToday();

    if (this.habits.length === 0) {
      const empty = wrapper.createDiv({ cls: "checkin-empty" });
      empty.createDiv({ text: "还没有习惯。点下面的「添加习惯」，或直接在代码块里写：" });
      empty.createEl("code", { text: "- 早起 | 2026-11-05, 2026-11-06" });
    } else {
      const scroll = wrapper.createDiv({ cls: "checkin-scroll" });
      const table = scroll.createEl("table", { cls: "checkin-table" });
      setS(scroll, "display", "block");
      setS(scroll, "width", "100%");
      setS(scroll, "max-width", "100%");
      setS(scroll, "box-sizing", "border-box");
      setS(scroll, "overflow-x", "auto");
      setS(scroll, "overflow-y", "hidden");
      setS(table, "border-collapse", "collapse");
      setS(table, "margin", "0");
      setS(table, "width", "100%");

      // 表头
      const thead = table.createEl("thead");
      const hrow = thead.createEl("tr");
      const nameTh = hrow.createEl("th", { cls: "checkin-th-name", text: "习惯" });
      // 横向滚动时习惯列必须固定，否则表头会露出被截断的日期列
      setS(nameTh, "position", "sticky");
      setS(nameTh, "left", "0");
      setS(nameTh, "z-index", "3");
      setS(nameTh, "background", "var(--background-secondary)");
      this.windowDates().forEach((d) => {
        const key = ymd(d);
        const th = hrow.createEl("th", {
          cls: `checkin-th-day${key === todayKey ? " is-today" : ""}`,
        });
        if (coarse) setS(th, "min-width", "32px");
        th.createDiv({ cls: "checkin-md", text: `${d.getMonth() + 1}/${d.getDate()}` });
        th.createDiv({ cls: "checkin-wd", text: WEEK_LABELS[d.getDay()] });
      });
      hrow.createEl("th", { cls: "checkin-th-stat", text: "连续" });
      hrow.createEl("th", { cls: "checkin-th-stat", text: "完成" });

      // 数据行
      const tbody = table.createEl("tbody");
      this.habits.forEach((habit, idx) => {
        const tr = tbody.createEl("tr");
        const nameTd = tr.createEl("td", { cls: "checkin-name" });
        setS(nameTd, "max-width", coarse ? "100px" : "200px");
        setS(nameTd, "position", "sticky");
        setS(nameTd, "left", "0");
        setS(nameTd, "z-index", "2");
        setS(nameTd, "background", "var(--background-primary)");
        const label = nameTd.createSpan({ cls: "checkin-name-text", text: habit.name });
        label.title = `${habit.name}（点击重命名）`;
        label.onclick = () => this.startRename(habit, nameTd);

        const actions = nameTd.createSpan({ cls: "checkin-row-actions" });
        const editBtn = actions.createEl("button", { cls: "checkin-icon-btn" });
        setIcon(editBtn, "pencil");
        editBtn.setAttribute("aria-label", `重命名「${habit.name}」`);
        editBtn.onclick = (e) => {
          e.stopPropagation();
          this.startRename(habit, nameTd);
        };
        const delBtn = actions.createEl("button", { cls: "checkin-icon-btn checkin-icon-danger" });
        setIcon(delBtn, "trash-2");
        delBtn.setAttribute("aria-label", `删除「${habit.name}」`);
        delBtn.onclick = (e) => {
          e.stopPropagation();
          this.startDelete(habit, nameTd);
        };

        this.windowDates().forEach((d) => {
          const key = ymd(d);
          const on = habit.dates.has(key);
          const future = d > today0();
          const td = tr.createEl("td", { cls: "checkin-td-cell" });
          if (coarse) setS(td, "min-width", "32px");
          const btn = td.createEl("button", {
            cls: `checkin-cell${on ? " is-on" : ""}${future ? " is-future" : ""}${
              key === todayKey ? " is-today" : ""
            }`,
          });
          btn.setAttribute("aria-label", `${habit.name} · ${key}`);
          if (!future) btn.onclick = () => this.toggle(habit, key);
        });

        const wkeys = this.windowDates().map(ymd);
        const done = wkeys.filter((k) => habit.dates.has(k)).length;
        const streak = this.streakOf(habit);
        const rate = Math.round((done / wkeys.length) * 100);

        tr.createEl("td", {
          cls: `checkin-stat${streak >= 3 ? " is-hot" : ""}`,
          text: streak > 0 ? `${streak}天` : "–",
        });
        tr.createEl("td", { cls: "checkin-stat checkin-rate", text: `${rate}%` });
      });

      scroll.addEventListener("scroll", () => {
        this.lastScroll = scroll.scrollLeft;
      });
      scroll.addEventListener("touchstart", () => {
        this.userScrolled = true;
      }, { passive: true });
      scroll.addEventListener("wheel", () => {
        this.userScrolled = true;
      }, { passive: true });

      // 首次渲染后样式/宽度可能还没算完，scrollWidth 会是 0，
      // 所以定位必须等布局完成再补几次，而不是同步赋值一次。
      const first = !this.autoPositioned;
      this.autoPositioned = true;
      if (first || !this.userScrolled) {
        this.alignToToday(scroll, true);
      } else if (this.lastScroll !== null) {
        scroll.scrollLeft = this.lastScroll;
      }
      if (typeof ResizeObserver === "function") {
        this._ro = new ResizeObserver(() => {
          if (!this.userScrolled) this.alignToToday(scroll, true);
        });
        this._ro.observe(scroll);
      }
    }

    // 底栏
    const footer = wrapper.createDiv({ cls: "checkin-footer" });
    const addBtn = footer.createEl("button", { cls: "checkin-btn" });
    const addIcon = addBtn.createSpan({ cls: "checkin-btn-icon" });
    setIcon(addIcon, "plus");
    addBtn.createSpan({ text: "添加习惯" });
    addBtn.onclick = () => this.openAddHabit();

    const group = footer.createDiv({ cls: "checkin-days" });
    DAY_OPTIONS.forEach((n) => {
      const btn = group.createEl("button", {
        cls: `checkin-day-btn${n === this.days ? " is-active" : ""}`,
        text: `${n}天`,
      });
      btn.onclick = () => this.plugin.setDays(n);
    });
  }

  /* 滚到最右端 = 露出今天（今天是最右一个日期列，右侧只有统计列）。
     布局未完成时 scrollWidth 可能还是 0，因此多补几次，直到宽度稳定。 */
  alignToToday(scroll, force) {
    if (!scroll) return;
    const go = () => {
      if (!force && this.userScrolled) return;
      const max = scroll.scrollWidth - scroll.clientWidth;
      scroll.scrollLeft = max > 0 ? max : 0;
      this.lastScroll = scroll.scrollLeft;
    };
    go();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        go();
        requestAnimationFrame(go);
      });
    }
    window.setTimeout(go, 80);
    window.setTimeout(go, 300);
  }

  scrollToToday() {
    const scroll = this.containerEl.querySelector(".checkin-scroll");
    if (!scroll) return;
    this.userScrolled = false;
    this.autoPositioned = true;
    this.alignToToday(scroll, true);
  }

  toggle(habit, key) {
    if (habit.dates.has(key)) habit.dates.delete(key);
    else habit.dates.add(key);
    this.render();
    this.save();
  }

  openAddHabit() {
    new AddHabitModal(this.app, (name) => {
      const n = (name || "").trim();
      if (!n) return;
      if (this.habits.some((h) => h.name === n)) return;
      this.habits.push({ name: n, dates: new Set() });
      this.render();
      this.save();
    }).open();
  }

  startRename(habit, nameTd) {
    if (nameTd.querySelector(".checkin-rename-input")) return;
    nameTd.empty();
    nameTd.addClass("is-editing");
    const input = nameTd.createEl("input", { type: "text", cls: "checkin-rename-input" });
    input.value = habit.name;
    let finished = false;

    const finish = (keep) => {
      if (finished) return;
      const v = input.value.trim();
      if (keep) {
        if (!v) {
          new Notice("习惯名不能为空");
          input.focus();
          return;
        }
        if (v !== habit.name) {
          if (this.habits.some((h) => h !== habit && h.name === v)) {
            new Notice(`「${v}」已经存在了`);
            input.focus();
            return;
          }
          habit.name = v;
          finished = true;
          this.render();
          this.save();
          return;
        }
      }
      finished = true;
      this.render();
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  startDelete(habit, nameTd) {
    const name = habit.name;
    const count = habit.dates.size;
    nameTd.empty();
    nameTd.addClass("is-editing");
    const wrap = nameTd.createSpan({ cls: "checkin-confirm" });
    wrap.createSpan({ cls: "checkin-confirm-text", text: "删除？" });
    const yes = wrap.createEl("button", { cls: "checkin-confirm-btn is-danger", text: "删除" });
    const no = wrap.createEl("button", { cls: "checkin-confirm-btn", text: "取消" });
    no.onclick = (e) => {
      e.stopPropagation();
      this.render();
    };
    yes.onclick = (e) => {
      e.stopPropagation();
      this.habits = this.habits.filter((h) => h !== habit);
      this.render();
      this.save();
      new Notice(count > 0 ? `已删除「${name}」，连同 ${count} 天记录` : `已删除「${name}」`);
    };
    window.setTimeout(() => yes.focus(), 0);
  }

  buildInner() {
    const lines = [...this.otherLines];
    this.habits.forEach((h) => lines.push(serializeLine(h)));
    return lines.join("\n");
  }

  async saveChanges() {
    const file = this.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
    if (!file) return;
    const content = await this.app.vault.read(file);
    const inner = this.buildInner();
    const next = this.replaceBlock(content, inner);
    if (next === null) return;
    await this.app.vault.modify(file, next);
    this.source = inner;
  }

  replaceBlock(content, inner) {
    const fence = /```([^\s`]+)[^\n]*\r?\n([\s\S]*?)```/g;
    const oldBody = this.source.replace(/\s+$/, "");
    let m;
    let fallback = null;
    while ((m = fence.exec(content))) {
      const alias = m[1];
      if (ALIASES.indexOf(alias) === -1) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      const body = m[2].replace(/\s+$/, "");
      const block = "```" + alias + "\n" + inner + "\n```";
      if (body === oldBody) return content.slice(0, start) + block + content.slice(end);
      if (fallback === null) fallback = { start, end, alias };
    }
    if (fallback) {
      const block = "```" + fallback.alias + "\n" + inner + "\n```";
      return content.slice(0, fallback.start) + block + content.slice(fallback.end);
    }
    return null;
  }
}

/* ---------------- 添加习惯弹窗 ---------------- */
class AddHabitModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("checkin-modal");
    contentEl.createEl("h3", { text: "添加习惯" });
    const input = contentEl.createEl("input", { type: "text", cls: "checkin-modal-input" });
    input.placeholder = "例如：早起 / 背单词 / 跑步";
    const row = contentEl.createDiv({ cls: "checkin-modal-btns" });
    const ok = row.createEl("button", { text: "添加", cls: "mod-cta" });
    const cancel = row.createEl("button", { text: "取消" });
    const submit = () => {
      const v = input.value;
      this.close();
      this.onSubmit(v);
    };
    ok.onclick = submit;
    cancel.onclick = () => this.close();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") this.close();
    });
    window.setTimeout(() => input.focus(), 0);
  }
  onClose() {
    this.contentEl.empty();
  }
}

module.exports = CheckinGridPlugin;
