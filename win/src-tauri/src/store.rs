//! mock store —— 形态先行阶段的数据层（FORM-PLAN §5）
//!
//! 数据态（Note）+ ephemeral（影响数据行为的 UI 态）+ journal 雏形（快照式撤销）。
//! 任务三整体替换为 SQLite + 版本 + 同步引擎，动作层接口（action.rs）不变。
//! 铁律相关：本 mock 不签发版本号；还原/删除语义在任务三落地。

use serde::{Deserialize, Serialize};

pub const AUTO_ARCHIVE_DAYS: i64 = 30;
pub const MAX_MERGE: usize = 4;
pub const MAX_STACK: usize = 9;
pub const CARD_W: f64 = 220.0;
pub const CARD_H: f64 = 170.0;
/// 方向移动步长（CSS px，按所在显示器缩放比换算）
pub const DIR_STEP: f64 = 240.0;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct CheckItem {
    pub id: String,
    pub text: String,
    pub done: bool,
}

/// 合并容器（四宫格产物，便签级简化，上限 4）
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct MergeTree {
    pub dir: String, // "grid"
    pub children: Vec<Note>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub text: String,
    #[serde(default)]
    pub items: Vec<CheckItem>,
    pub color: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub urgent: bool,
    #[serde(default)]
    pub timed: Option<i64>, // epoch ms；null = 无定时
    #[serde(default)]
    pub mode: String, // "desk" | "archive"（互斥存在方式）
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    #[serde(default)]
    pub last_desk_pos: Option<[f64; 4]>,
    #[serde(default)]
    pub slot_id: Option<String>,
    #[serde(default)]
    pub merge_tree: Option<MergeTree>,
    #[serde(default)]
    pub deleted: bool, // tombstone（历史保留，跨设备还原在任务三）
}

impl Note {
    pub fn is_desk(&self) -> bool {
        self.mode == "desk" && !self.deleted
    }
    pub fn is_archive(&self) -> bool {
        self.mode == "archive" && !self.deleted
    }
    #[allow(dead_code)]
    pub fn is_live(&self) -> bool {
        !self.deleted
    }
    #[allow(dead_code)]
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

/// ephemeral（Rust 侧、不持久化、影响数据行为的 UI 态）
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct Ephemeral {
    #[serde(default)]
    pub unconfirmed: Vec<String>, // 自动收回产生，待确认
    #[serde(default)]
    pub borrowing: Vec<String>, // 视图借用中（自动收回跳过）
    #[serde(default)]
    pub dragging: Option<String>, // 拖拽中（自动收回跳过）
}

// ---------------------------------------------------------------------------
// journal（快照式撤销雏形）
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct JournalMeta {
    pub seq: u64,
    pub batch: String,
    pub author: String, // "ui" | "ai"（任务三 local API 传）
    pub name: String,
    pub args: serde_json::Value,
    pub time: i64,
}

#[derive(Clone)]
pub struct JournalEntry {
    pub meta: JournalMeta,
    /// 动作前快照（覆盖数据态 + ephemeral）
    pub snapshot: Vec<Note>,
    pub ephem: Ephemeral,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct Store {
    pub notes: Vec<Note>,
    pub ephemeral: Ephemeral,
    pub journal: Vec<JournalEntry>,
    next_id: u64,
    next_seq: u64,
    /// 模拟时间偏移（调试快进；自动收回/逾期基准 = 真实时间 + 偏移）
    pub time_offset: i64,
}

impl Store {
    pub fn new() -> Self {
        let mut s = Store {
            notes: seed_notes(),
            ephemeral: Ephemeral::default(),
            journal: Vec::new(),
            next_id: 100,
            next_seq: 1,
            time_offset: 0,
        };
        s.notes.sort_by_key(|n| n.updated_at); // 种子按时间序排列（DOM 顺序稳定）
        s
    }

    pub fn now(&self) -> i64 {
        now_ms() + self.time_offset
    }

    pub fn note(&self, id: &str) -> Option<&Note> {
        self.notes.iter().find(|n| n.id == id)
    }

    fn note_mut(&mut self, id: &str) -> Option<&mut Note> {
        self.notes.iter_mut().find(|n| n.id == id)
    }

    fn new_id(&mut self) -> String {
        let id = format!("n{}", self.next_id);
        self.next_id += 1;
        id
    }

    /// journal 序号（单调递增，仅 mock 内部使用；任务三由服务器签发版本号）
    pub fn next_seq(&mut self) -> u64 {
        let s = self.next_seq;
        self.next_seq += 1;
        s
    }

    /// 内容性改动 → 更新 updated_at（移动/归档等整理动作不 bump）
    fn bump(&mut self, id: &str) {
        let now = self.now();
        if let Some(n) = self.note_mut(id) {
            n.updated_at = now;
        }
    }

    // -----------------------------------------------------------------------
    // 数据动作（全部经 record 包装 → journal）
    // -----------------------------------------------------------------------

    pub fn record<F>(&mut self, meta: JournalMeta, f: F) -> Result<Vec<String>, String>
    where
        F: FnOnce(&mut Self) -> Result<Vec<String>, String>,
    {
        let snapshot = self.notes.clone();
        let ephem = self.ephemeral.clone();
        let changed = f(self)?;
        self.journal.push(JournalEntry {
            meta,
            snapshot,
            ephem,
        });
        // G4：journal 上限（mock 阶段防无限增长；只丢最老，保留新批次可撤销）
        if self.journal.len() > 1000 {
            self.journal.drain(0..self.journal.len() - 1000);
        }
        Ok(changed)
    }

    pub fn create(&mut self, text: &str, color: &str, x: f64, y: f64) -> Note {
        let t = self.now();
        let n = Note {
            id: self.new_id(),
            title: None,
            text: text.to_string(),
            items: vec![],
            color: color.to_string(),
            created_at: t,
            updated_at: t,
            urgent: false,
            timed: None,
            mode: "desk".into(),
            x,
            y,
            w: CARD_W,
            h: CARD_H,
            last_desk_pos: None,
            slot_id: None,
            merge_tree: None,
            deleted: false,
        };
        let id = n.id.clone();
        self.notes.push(n);
        self.note(&id).cloned().unwrap()
    }

    pub fn edit_text(&mut self, id: &str, text: &str) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        if n.deleted {
            return Err("便签已删除".into());
        }
        n.text = text.to_string();
        self.bump(id);
        Ok(())
    }

    pub fn check(&mut self, id: &str, item_id: &str, done: bool) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        let it = n
            .items
            .iter_mut()
            .find(|i| i.id == item_id)
            .ok_or("清单项不存在")?;
        it.done = done;
        self.bump(id);
        Ok(())
    }

    /// 桌面定位（拖动落点 / AI 精确 move）。不 bump updated_at（整理动作）。
    pub fn move_note(&mut self, id: &str, x: f64, y: f64) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        n.x = x;
        n.y = y;
        Ok(())
    }

    /// archive → desk。落点：显式坐标 / lastDeskPos / 边栏左侧空白（由 action.rs 定）。
    /// 拖出 = 隐含确认（未确认态清除）；bump updated_at（拖出即关注，重置自动收回时钟）
    pub fn take(&mut self, id: &str, x: f64, y: f64) -> Result<(), String> {
        let now = self.now();
        let n = self.note_mut(id).ok_or("便签不存在")?;
        if n.deleted {
            return Err("便签已删除".into());
        }
        n.mode = "desk".into();
        n.slot_id = None;
        n.x = x;
        n.y = y;
        n.w = CARD_W;
        n.h = CARD_H;
        n.updated_at = now;
        self.ephemeral.unconfirmed.retain(|i| i != id);
        Ok(())
    }

    /// desk → archive 扁平条目（index = 扁平层插入位，None = 末尾）
    pub fn store(&mut self, id: &str, index: Option<usize>) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        if n.deleted {
            return Err("便签已删除".into());
        }
        n.mode = "archive".into();
        n.slot_id = None;
        n.last_desk_pos = Some([n.x, n.y, n.w, n.h]);
        // 归档组内排序：把便签挪到 archive 条目序列中的 index 位（默认末尾）
        let pos = self.notes.iter().position(|n| n.id == id).unwrap();
        let note = self.notes.remove(pos);
        let arch_idx: Vec<usize> = self
            .notes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.is_archive())
            .map(|(i, _)| i)
            .collect();
        let at = match index {
            Some(k) => arch_idx.get(k.min(arch_idx.len())).copied().unwrap_or(self.notes.len()),
            None => self.notes.len(),
        };
        self.notes.insert(at, note);
        Ok(())
    }

    /// 扁平条目 → 档案格（格不存在则创建：格 id 取首个成员的便签 id）
    pub fn join_slot(&mut self, id: &str, slot_id: &str) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        if n.deleted {
            return Err("便签已删除".into());
        }
        n.mode = "archive".into();
        n.slot_id = Some(if slot_id.is_empty() {
            format!("slot-{id}")
        } else {
            slot_id.to_string()
        });
        Ok(())
    }

    /// 桌面纸堆（同位置多张）整格拖入 → 创建档案格
    pub fn store_slot(&mut self, ids: &[String]) -> Result<String, String> {
        if ids.len() < 2 {
            return Err("档案格至少需要 2 张便签".into());
        }
        let slot_id = format!("slot-{}", ids[0]);
        for id in ids {
            let n = self.note_mut(id).ok_or("便签不存在")?;
            n.mode = "archive".into();
            n.slot_id = Some(slot_id.clone());
            n.last_desk_pos = Some([n.x, n.y, n.w, n.h]);
        }
        Ok(slot_id)
    }

    /// 一键归档：全部桌面便签 → 扁平归档
    pub fn archive_all(&mut self) -> Vec<String> {
        let ids: Vec<String> = self
            .notes
            .iter()
            .filter(|n| n.is_desk())
            .map(|n| n.id.clone())
            .collect();
        for id in &ids {
            let _ = self.store(id, None);
        }
        ids
    }

    /// 标记：urgent = bool；timed = Option<i64>（null 清除）
    pub fn tag(&mut self, id: &str, tag: &str, v: serde_json::Value) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        match tag {
            "urgent" => {
                n.urgent = v.as_bool().unwrap_or(false);
            }
            "timed" => {
                n.timed = v.as_i64();
            }
            _ => return Err(format!("未知标记 {tag}")),
        }
        self.bump(id);
        Ok(())
    }

    /// 叠放：成员对齐同一位置（stack 数据语义 = position 对齐 + Vec 顺序 = 顶层顺序）
    pub fn stack(&mut self, ids: &[String], x: f64, y: f64) -> Result<(), String> {
        if ids.len() > MAX_STACK {
            return Err(format!("叠放上限 {MAX_STACK} 张"));
        }
        for id in ids {
            let n = self.note_mut(id).ok_or("便签不存在")?;
            n.x = x;
            n.y = y;
        }
        // 成员移到末尾（最后 = 最上层）
        for id in ids {
            if let Some(pos) = self.notes.iter().position(|n| &n.id == id) {
                let n = self.notes.remove(pos);
                self.notes.push(n);
            }
        }
        Ok(())
    }

    /// 合并容器撕裂方向（row = 左右分 / col = 上下分；停靠点决定）
    pub fn set_merge_dir(&mut self, id: &str, dir: &str) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        let t = n.merge_tree.as_mut().ok_or("非合并容器")?;
        if dir == "row" || dir == "col" {
            t.dir = dir.to_string();
        }
        Ok(())
    }

    /// 拆叠：散开同位置的其他成员（级联偏移）；id 自身不动——拖动松手时
    /// drag_end 已同步更新过 id 的位置，此处只负责给同伴腾位（Y10 明确语义）
    pub fn unstack(&mut self, id: &str) -> Result<(), String> {
        let (x, y) = {
            let n = self.note(id).ok_or("便签不存在")?;
            (n.x, n.y)
        };
        let mates: Vec<String> = self
            .notes
            .iter()
            .filter(|n| n.is_desk() && n.x == x && n.y == y && n.id != id)
            .map(|n| n.id.clone())
            .collect();
        for (i, mid) in mates.iter().enumerate() {
            if let Some(n) = self.note_mut(mid) {
                n.x = x + (i as f64 + 1.0) * 28.0;
                n.y = y + (i as f64 + 1.0) * 24.0;
            }
        }
        Ok(())
    }

    /// 合并（上限 4，四宫格容器；成员快照嵌入容器）
    pub fn merge(&mut self, ids: &[String], x: f64, y: f64) -> Result<Note, String> {
        if ids.len() < 2 || ids.len() > MAX_MERGE {
            return Err(format!("合并需要 2~{MAX_MERGE} 张便签"));
        }
        let mut seen: Vec<&str> = Vec::new();
        let mut children = Vec::new();
        for id in ids {
            if seen.contains(&id.as_str()) {
                continue; // G4：重复 id 去重（同 id 传两次不产生双克隆）
            }
            let n = self.note(id).ok_or("便签不存在")?;
            if n.merge_tree.is_some() {
                return Err("合并容器不能再合并".into());
            }
            children.push(n.clone());
            seen.push(id.as_str());
        }
        if children.len() < 2 {
            return Err("去重后不足 2 张，无法合并".into());
        }
        let t = self.now();
        let container = Note {
            id: self.new_id(),
            title: Some(format!("合并 · {}", children.len())),
            text: String::new(),
            items: vec![],
            color: "#f5efe2".into(),
            created_at: t,
            updated_at: t,
            urgent: false,
            timed: None,
            mode: "desk".into(),
            x,
            y,
            w: 260.0,
            h: 210.0,
            last_desk_pos: None,
            slot_id: None,
            merge_tree: Some(MergeTree {
                dir: "grid".into(),
                children,
            }),
            deleted: false,
        };
        self.notes.retain(|n| !ids.contains(&n.id));
        let id = container.id.clone();
        self.notes.push(container);
        Ok(self.note(&id).cloned().unwrap())
    }

    /// 解合并：容器解散，成员还原为桌面卡（级联摆放）
    pub fn unmerge(&mut self, id: &str) -> Result<Vec<Note>, String> {
        let (x, y, children) = {
            let n = self.note(id).ok_or("便签不存在")?;
            match &n.merge_tree {
                Some(mt) => (n.x, n.y, mt.children.clone()),
                None => return Err("不是合并容器".into()),
            }
        };
        self.notes.retain(|n| n.id != id);
        let mut out = Vec::new();
        for (i, mut c) in children.into_iter().enumerate() {
            c.mode = "desk".into();
            c.x = x + (i % 2) as f64 * 30.0;
            c.y = y + (i / 2) as f64 * 26.0;
            self.notes.push(c);
            let last = self.notes.last().cloned().unwrap();
            out.push(last);
        }
        Ok(out)
    }

    /// 扁平层排序（边栏全部列表）：to_index = 在「归档扁平序列」中的插入位
    /// （前端传 archiveFlat 的下标；不含档案格成员——Y2 语义修正）
    pub fn reorder(&mut self, id: &str, to_index: usize) -> Result<(), String> {
        let pos = self
            .notes
            .iter()
            .position(|n| n.id == id)
            .ok_or("便签不存在")?;
        let n = self.notes.remove(pos);
        let flat_idx: Vec<usize> = self
            .notes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.is_archive() && n.slot_id.is_none())
            .map(|(i, _)| i)
            .collect();
        let at = flat_idx
            .get(to_index)
            .copied()
            .unwrap_or(self.notes.len());
        self.notes.insert(at, n);
        Ok(())
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        n.deleted = true; // tombstone
        self.ephemeral.unconfirmed.retain(|i| i != id);
        Ok(())
    }

    /// 还原（mock：回到原存在方式；跨设备还原语义任务三落地）
    pub fn restore(&mut self, id: &str) -> Result<(), String> {
        let n = self.note_mut(id).ok_or("便签不存在")?;
        n.deleted = false;
        if n.mode == "archive" {
            let sid = n.slot_id.clone();
            if sid.is_none() {
                n.last_desk_pos = None;
            }
        }
        Ok(())
    }

    pub fn confirm(&mut self, id: &str) {
        self.ephemeral.unconfirmed.retain(|i| i != id);
    }

    /// 撤销批次：恢复该批次第一条动作前的快照；截断该批次之后的 journal
    pub fn undo_batch(&mut self, batch: &str) -> Result<(), String> {
        let pos = self
            .journal
            .iter()
            .position(|e| e.meta.batch == batch)
            .ok_or("批次不存在")?;
        let entry = self.journal[pos].clone();
        self.notes = entry.snapshot;
        self.ephemeral = entry.ephem;
        self.journal.truncate(pos);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 自动收回（宿主 = Rust 定时器；AI 路径同入口）
    // -----------------------------------------------------------------------

    /// 返回被收回的便签 id（updated_at 距今 > AUTO_ARCHIVE_DAYS 的桌面便签；
    /// 拖拽中/借用中跳过；收回后进入未确认态）
    pub fn auto_archive(&mut self) -> Vec<String> {
        let now = self.now();
        let mut changed = Vec::new();
        let ids: Vec<String> = self
            .notes
            .iter()
            .filter(|n| n.is_desk())
            .map(|n| n.id.clone())
            .collect();
        for id in ids {
            let (old, dragging, borrowing) = {
                let n = match self.note(&id) {
                    Some(n) => n,
                    None => continue,
                };
                (n.updated_at, self.ephemeral.dragging.as_deref() == Some(id.as_str()), self.ephemeral.borrowing.contains(&id))
            };
            if dragging || borrowing {
                continue;
            }
            if now - old > AUTO_ARCHIVE_DAYS * 86_400_000 {
                if let Ok(()) = self.store(&id, None) {
                    if !self.ephemeral.unconfirmed.contains(&id) {
                        self.ephemeral.unconfirmed.push(id.clone());
                    }
                    changed.push(id);
                }
            }
        }
        changed
    }

    /// 调试：模拟时间前进 days 天（updated_at 相对变老 → 自动收回可触发）
    pub fn fast_forward(&mut self, days: i64) {
        self.time_offset += days * 86_400_000;
    }

    pub fn journal_meta(&self, n: usize) -> Vec<JournalMeta> {
        self.journal
            .iter()
            .rev()
            .take(n)
            .map(|e| e.meta.clone())
            .collect()
    }

    pub fn reset(&mut self) {
        self.notes = seed_notes();
        self.ephemeral = Ephemeral::default();
        self.journal.clear();
        self.time_offset = 0;
    }
}

// ---------------------------------------------------------------------------
// 种子数据（形态演示：桌面卡 / 叠放 / 合并容器 / 档案格 / 定时与紧急 / 过期自动收回）
// ---------------------------------------------------------------------------

pub fn seed_notes() -> Vec<Note> {
    let t = now_ms();
    let day = 86_400_000i64;
    let mk = |id: &str, text: &str, color: &str, age: i64| Note {
        id: id.into(),
        title: None,
        text: text.into(),
        items: vec![],
        color: color.into(),
        created_at: t - age,
        updated_at: t - age,
        urgent: false,
        timed: None,
        mode: "desk".into(),
        x: 0.0,
        y: 0.0,
        w: CARD_W,
        h: CARD_H,
        last_desk_pos: None,
        slot_id: None,
        merge_tree: None,
        deleted: false,
    };
    let mut v = Vec::new();

    // ---- 桌面 ----
    let mut n1 = mk("n1", "买牛奶和鸡蛋 🥛🥚", "#fff3b0", 2 * 3600_000);
    n1.urgent = true;
    n1.x = 250.0;
    n1.y = 180.0;
    v.push(n1);

    let mut n2 = mk("n2", "周末清单", "#d8f3dc", day);
    n2.items = vec![
        CheckItem { id: "i1".into(), text: "洗车".into(), done: false },
        CheckItem { id: "i2".into(), text: "交电费".into(), done: false },
        CheckItem { id: "i3".into(), text: "给花浇水".into(), done: true },
    ];
    n2.x = 620.0;
    n2.y = 340.0;
    v.push(n2);

    let mut n3 = mk("n3", "灵感：让纸筏把纸条送到每台设备", "#ffd6e0", 3 * 3600_000);
    n3.x = 1080.0;
    n3.y = 140.0;
    v.push(n3);

    let mut n4 = mk(
        "n4",
        "跨屏拖动测试卡：把我拖到另一个屏幕试试",
        "#caf0f8",
        2 * day,
    );
    n4.x = 200.0;
    n4.y = 470.0;
    v.push(n4);

    // 叠放三张（同一位置）
    let mut n11 = mk("n11", "叠放成员 A：快速松手可叠成一摞", "#ffe8cc", 4 * day);
    n11.x = 1500.0;
    n11.y = 320.0;
    let mut n12 = mk("n12", "叠放成员 B", "#f0f7c8", 4 * day);
    n12.x = 1500.0;
    n12.y = 320.0;
    let mut n13 = mk("n13", "叠放成员 C", "#e7d8f8", 4 * day);
    n13.x = 1500.0;
    n13.y = 320.0;
    v.extend([n11, n12, n13]);

    // 合并容器（四宫格）
    let children = vec![
        mk("c1", "合并：项目 A", "#fff3b0", 5 * day),
        mk("c2", "合并：项目 B", "#d8f3dc", 5 * day),
        mk("c3", "合并：项目 C", "#ffd6e0", 5 * day),
        mk("c4", "合并：项目 D", "#caf0f8", 5 * day),
    ];
    let mut m1 = mk(
        "m1",
        "",
        "#f5efe2",
        5 * day,
    );
    m1.title = Some("合并容器（四宫格）".into());
    m1.merge_tree = Some(MergeTree { dir: "grid".into(), children });
    m1.x = 900.0;
    m1.y = 520.0;
    m1.w = 260.0;
    m1.h = 210.0;
    v.push(m1);

    // 定时便签（明天 10:00）
    let mut n15 = mk("n15", "周日 10:00 体检（空腹）", "#f8e7f9", 6 * 3600_000);
    n15.timed = Some(t + 20 * 3600_000);
    n15.x = 1580.0;
    n15.y = 640.0;
    v.push(n15);

    // 40 天未动 → 启动后第一次自动收回检查即被归档（未确认态演示）
    let mut n14 = mk(
        "n14",
        "旧的季度总结便签（40 天没动，将被自动收回）",
        "#e8e0d8",
        40 * day,
    );
    n14.x = 480.0;
    n14.y = 700.0;
    v.push(n14);

    // ---- 归档（扁平条目）----
    let mut n5 = mk("n5", "服务器已部署：50000 端口冒烟通过", "#e7e4f8", 6 * day);
    n5.mode = "archive".into();
    v.push(n5);

    let mut n6 = mk("n6", "周三 18:00 和妈妈视频", "#fff3b0", 4 * day);
    n6.mode = "archive".into();
    n6.timed = Some(t + 2 * day);
    v.push(n6);

    let mut n7 = mk("n7", "老同学聚会报名", "#d8f3dc", 8 * day);
    n7.mode = "archive".into();
    v.push(n7);

    // ---- 档案格（出差资料 3 张）----
    for (i, txt) in ["出差资料 · 机票", "出差资料 · 酒店", "出差资料 · 行程单"].iter().enumerate() {
        let mut n = mk(&format!("s{}", i + 1), txt, "#ffe8cc", 9 * day);
        n.mode = "archive".into();
        n.slot_id = Some("slot-s1".into());
        v.push(n);
    }

    v
}

// ---------------------------------------------------------------------------
// 单元测试（T2/T3 数据侧：边界参数化）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[Note]) -> Vec<String> {
        v.iter().map(|n| n.id.clone()).collect()
    }

    #[test]
    fn merge_cap_4() {
        let mut s = Store::new();
        let created: Vec<Note> = (0..5)
            .map(|_| s.create("x", "#fff", 0.0, 0.0))
            .collect();
        let a = ids(&created[..4]);
        let r = s.merge(&a, 10.0, 10.0);
        assert!(r.is_ok());
        // 5 张 → 超上限
        let r2 = s.merge(&ids(&created), 10.0, 10.0);
        assert!(r2.is_err());
        // 容器不能再合并
        let c = r.unwrap();
        let r3 = s.merge(&[c.id.clone(), created[4].id.clone()], 10.0, 10.0);
        assert!(r3.is_err());
    }

    #[test]
    fn set_merge_dir_switches_tear_direction() {
        let mut s = Store::new();
        let a = s.create("a", "#fff", 0.0, 0.0);
        let b = s.create("b", "#fff", 0.0, 0.0);
        let c = s.merge(&[a.id.clone(), b.id.clone()], 10.0, 10.0).unwrap();
        assert_eq!(c.merge_tree.as_ref().unwrap().dir, "grid");
        s.set_merge_dir(&c.id, "row").unwrap();
        assert_eq!(s.note(&c.id).unwrap().merge_tree.as_ref().unwrap().dir, "row");
        s.set_merge_dir(&c.id, "col").unwrap();
        assert_eq!(s.note(&c.id).unwrap().merge_tree.as_ref().unwrap().dir, "col");
        // 非法方向不变更
        s.set_merge_dir(&c.id, "diag").unwrap();
        assert_eq!(s.note(&c.id).unwrap().merge_tree.as_ref().unwrap().dir, "col");
        // 非容器报错
        assert!(s.set_merge_dir(&a.id, "row").is_err());
    }

    #[test]
    fn merge_unmerge_roundtrip() {
        let mut s = Store::new();
        let a = s.create("a", "#fff", 0.0, 0.0);
        let b = s.create("b", "#fff", 0.0, 0.0);
        let c = s.merge(&[a.id.clone(), b.id.clone()], 0.0, 0.0).unwrap();
        assert!(s.note(&a.id).is_none());
        let back = s.unmerge(&c.id).unwrap();
        assert_eq!(back.len(), 2);
        assert!(s.note(&a.id).is_some() && s.note(&b.id).is_some());
    }

    #[test]
    fn stack_cap_9_and_align() {
        let mut s = Store::new();
        let created: Vec<Note> = (0..10).map(|_| s.create("x", "#fff", 0.0, 0.0)).collect();
        let a = ids(&created[..9]);
        assert!(s.stack(&a, 50.0, 60.0).is_ok());
        assert!(s.stack(&ids(&created), 50.0, 60.0).is_err());
        let all: Vec<_> = a
            .iter()
            .map(|id| s.note(id).unwrap())
            .collect();
        assert!(all.iter().all(|n| n.x == 50.0 && n.y == 60.0));
    }

    #[test]
    fn auto_archive_30d_skips_dragging_borrowing() {
        let mut s = Store::new();
        let id = s.create("x", "#fff", 0.0, 0.0).id;
        s.note_mut(&id).unwrap().updated_at = now_ms() - 40 * 86_400_000;
        let changed = s.auto_archive();
        assert!(changed.contains(&id)); // 种子 n14（40 天旧）也会被收回
        assert_eq!(s.note(&id).unwrap().mode, "archive");
        assert!(s.ephemeral.unconfirmed.contains(&id));
        // 拖拽中跳过
        s.take(&id, 0.0, 0.0).unwrap(); // 还原到桌面（隐含确认）
        s.note_mut(&id).unwrap().updated_at = now_ms() - 40 * 86_400_000;
        s.ephemeral.dragging = Some(id.clone());
        let changed = s.auto_archive();
        assert!(!changed.contains(&id));
        s.ephemeral.dragging = None;
        // 借用中跳过
        s.ephemeral.borrowing.push(id.clone());
        let changed = s.auto_archive();
        assert!(!changed.contains(&id));
    }

    #[test]
    fn store_take_roundtrip_preserves_last_desk_pos() {
        let mut s = Store::new();
        let n = s.create("x", "#fff", 100.0, 200.0);
        s.store(&n.id, None).unwrap();
        let a = s.note(&n.id).unwrap();
        assert_eq!(a.mode, "archive");
        assert_eq!(a.last_desk_pos, Some([100.0, 200.0, CARD_W, CARD_H]));
        s.take(&n.id, 0.0, 0.0).unwrap();
        let a = s.note(&n.id).unwrap();
        assert_eq!(a.mode, "desk");
        assert!(a.slot_id.is_none());
    }

    #[test]
    fn slot_join_store_slot() {
        let mut s = Store::new();
        let a = s.create("a", "#fff", 0.0, 0.0);
        let b = s.create("b", "#fff", 0.0, 0.0);
        let sid = s.store_slot(&[a.id.clone(), b.id.clone()]).unwrap();
        assert!(sid.starts_with("slot-"));
        assert!(s.note(&a.id).unwrap().is_archive());
        assert_eq!(s.note(&a.id).unwrap().slot_id.as_deref(), Some(sid.as_str()));
        // 扁平条目入格
        let c = s.create("c", "#fff", 0.0, 0.0);
        s.store(&c.id, None).unwrap();
        s.join_slot(&c.id, &sid).unwrap();
        assert_eq!(s.note(&c.id).unwrap().slot_id.as_deref(), Some(sid.as_str()));
    }

    #[test]
    fn tag_urgent_timed_clear() {
        let mut s = Store::new();
        let id = s.create("x", "#fff", 0.0, 0.0).id;
        s.tag(&id, "urgent", serde_json::json!(true)).unwrap();
        s.tag(&id, "timed", serde_json::json!(1_700_000_000_000i64)).unwrap();
        {
            let n = s.note(&id).unwrap();
            assert!(n.urgent);
            assert_eq!(n.timed, Some(1_700_000_000_000));
        }
        // 📄 清全部 = 两次 tag 调用
        s.tag(&id, "urgent", serde_json::json!(false)).unwrap();
        s.tag(&id, "timed", serde_json::Value::Null).unwrap();
        {
            let n = s.note(&id).unwrap();
            assert!(!n.urgent && n.timed.is_none());
        }
    }

    #[test]
    fn undo_batch_restores_snapshot() {
        let mut s = Store::new();
        let before: Vec<String> = ids(&s.notes);
        let n = s.create("x", "#fff", 0.0, 0.0);
        let batch = "b1".to_string();
        let after_x: Vec<String> = ids(&s.notes);
        let meta = JournalMeta {
            seq: 1,
            batch: batch.clone(),
            author: "ui".into(),
            name: "create".into(),
            args: serde_json::json!({}),
            time: s.now(),
        };
        s.record(meta, |st| {
            let _ = st.create("y", "#fff", 0.0, 0.0);
            Ok(vec![n.id.clone()])
        })
        .unwrap();
        assert_eq!(s.notes.len(), before.len() + 2);
        s.undo_batch(&batch).unwrap();
        // 快照 = 批次开始前（create("x") 已生效）
        assert_eq!(ids(&s.notes), after_x);
        assert!(s.journal.is_empty());
    }

    #[test]
    fn delete_is_tombstone_restore_back() {
        let mut s = Store::new();
        let n = s.create("x", "#fff", 0.0, 0.0);
        s.delete(&n.id).unwrap();
        assert!(s.note(&n.id).unwrap().deleted);
        assert!(!s.note(&n.id).unwrap().is_live());
        s.restore(&n.id).unwrap();
        assert!(s.note(&n.id).unwrap().is_live());
    }

    #[test]
    fn fast_forward_drives_auto_archive() {
        let mut s = Store::new();
        let n = s.create("x", "#fff", 0.0, 0.0);
        s.fast_forward(31);
        let changed = s.auto_archive();
        assert!(changed.contains(&n.id));
        // 快进后"今天"判断也前移：逾期定时
        s.fast_forward(-31);
        let n2 = s.create("y", "#fff", 0.0, 0.0);
        s.tag(&n2.id, "timed", serde_json::json!(s.now() - 1000)).unwrap();
        s.fast_forward(1);
        assert!(s.note(&n2.id).unwrap().timed.unwrap() < s.now());
    }

    #[test]
    fn reorder_inserts_within_flat_archive_sequence() {
        let mut s = Store::new();
        let flat: Vec<String> = s
            .notes
            .iter()
            .filter(|n| n.is_archive() && n.slot_id.is_none())
            .map(|n| n.id.clone())
            .collect();
        // 种子：n7(8天) n5(6天) n6(4天) 按 updated_at 升序（Store::new 排序）；s1..s3 档案格不计入
        assert_eq!(flat, vec!["n7", "n5", "n6"]);
        // n6 拖到列表头（flat index 0）
        s.reorder("n6", 0).unwrap();
        let flat2: Vec<String> = s
            .notes
            .iter()
            .filter(|n| n.is_archive() && n.slot_id.is_none())
            .map(|n| n.id.clone())
            .collect();
        assert_eq!(flat2, vec!["n6", "n7", "n5"]);
        // n5 拖到中间（flat index 1）
        s.reorder("n5", 1).unwrap();
        let flat3: Vec<String> = s
            .notes
            .iter()
            .filter(|n| n.is_archive() && n.slot_id.is_none())
            .map(|n| n.id.clone())
            .collect();
        assert_eq!(flat3, vec!["n6", "n5", "n7"]);
        // 新归档条目拖到头：不会插到便签头部/档案格前（Y2 语义）
        let desk = s.create("d", "#fff", 0.0, 0.0);
        s.store(&desk.id, None).unwrap();
        s.reorder(&desk.id, 0).unwrap();
        let flat4: Vec<String> = s
            .notes
            .iter()
            .filter(|n| n.is_archive() && n.slot_id.is_none())
            .map(|n| n.id.clone())
            .collect();
        assert_eq!(flat4[0], desk.id);
        // 全局 Vec 头部仍是档案格/桌面卡区域，不出现扁平条目（不越界）
        assert!(s.notes[0].mode == "desk" || s.notes[0].slot_id.is_some());
    }

    #[test]
    fn merge_dedups_duplicate_ids() {
        let mut s = Store::new();
        let a = s.create("a", "#fff", 0.0, 0.0);
        let b = s.create("b", "#fff", 0.0, 0.0);
        let r = s.merge(&[a.id.clone(), a.id.clone(), b.id.clone()], 10.0, 10.0).unwrap();
        assert_eq!(r.merge_tree.as_ref().unwrap().children.len(), 2);
        // 全部重复 → 错误
        let c = s.create("c", "#fff", 0.0, 0.0);
        let r2 = s.merge(&[c.id.clone(), c.id.clone()], 10.0, 10.0);
        assert!(r2.is_err());
    }

    #[test]
    fn unstack_scatters_mates_but_not_self() {
        let mut s = Store::new();
        let a = s.create("a", "#fff", 100.0, 100.0);
        let b = s.create("b", "#fff", 100.0, 100.0);
        let c = s.create("c", "#fff", 100.0, 100.0);
        s.unstack(&a.id).unwrap();
        assert_eq!(
            (s.note(&a.id).unwrap().x, s.note(&a.id).unwrap().y),
            (100.0, 100.0)
        );
        assert_ne!((s.note(&b.id).unwrap().x, s.note(&b.id).unwrap().y), (100.0, 100.0));
        assert_ne!((s.note(&c.id).unwrap().x, s.note(&c.id).unwrap().y), (100.0, 100.0));
        assert_ne!(
            (s.note(&b.id).unwrap().x, s.note(&b.id).unwrap().y),
            (s.note(&c.id).unwrap().x, s.note(&c.id).unwrap().y)
        );
    }
}
