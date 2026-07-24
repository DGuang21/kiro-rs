//! 补货上游（Restock Upstream）管理
//!
//! 对接上游"提号"API：配置上游账号（baseUrl + usr-key），查询库存/余额、
//! 手动或自动提取新 Key、注册并接收 Webhook。收到 `new_keys_available` 时按配置
//! 自动提号并把 `ksk_` Key 作为 api_key 凭据入库（代理池轮询分配）；收到
//! `all_keys_dead` 仅记录事件。
//!
//! 持久化：`upstreams.json`（配置，含上游 usr-key，与 credentials.json 同目录）
//! 和 `upstream_events.json`（事件日志，环形上限）。设计参考 groups.rs / client_keys.rs
//! 的 RwLock + JSON 持久化模式。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::http_client::{ProxyConfig, build_client};
use crate::model::config::TlsBackend;

/// 上游 HTTP 请求超时（秒）
const UPSTREAM_TIMEOUT_SECS: u64 = 30;
/// 事件日志保留上限（环形，超出丢弃最旧）
const MAX_EVENTS: usize = 500;

// ── 配置实体 ─────────────────────────────────────────────────────────────────

/// 单条高峰时段规则：某些星期几的 `[start_hour, end_hour)`（整点，按服务器本地时间）。
///
/// - `weekdays`：0=周日 … 6=周六（与前端 JS `Date.getDay()` 一致）。空表示每天。
/// - 时间为整点，`[start_hour, end_hour)` 左闭右开。支持跨天（start > end，如 22→6）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakWindow {
    /// 生效的星期几集合（0=周日…6=周六）；空 = 每天
    #[serde(default)]
    pub weekdays: Vec<u8>,
    /// 起始小时（0-23，含）
    #[serde(default)]
    pub start_hour: u8,
    /// 结束小时（0-23，不含）
    #[serde(default)]
    pub end_hour: u8,
}

impl PeakWindow {
    /// 判断给定 (星期几, 小时) 是否落在本规则内。
    ///
    /// 跨天窗口（start > end，如 22→6）：凌晨那半段算作**起始日**的延续，
    /// 即命中日期仍按 `weekday` 是否在集合里判断当天，凌晨 [0,end) 归属"前一天开始的窗口"。
    /// 为简化且直观，这里对跨天窗口按"当天命中起始段或当天命中结尾段"处理——
    /// 即只要 weekday 命中且 hour 落在 [start,24)∪[0,end) 就算高峰。
    pub fn matches(&self, weekday: u8, hour: u8) -> bool {
        let day_ok = self.weekdays.is_empty() || self.weekdays.contains(&weekday);
        if !day_ok {
            return false;
        }
        let (s, e) = (self.start_hour % 24, self.end_hour % 24);
        if s == e {
            false
        } else if s < e {
            hour >= s && hour < e
        } else {
            hour >= s || hour < e
        }
    }
}

/// 分时段自动提货量配置：多条高峰规则 + 高峰/低谷两档提货量。
///
/// 命中**任一**高峰规则用 `peak_count`，否则用 `offpeak_count`；量为 0 仍表示
/// "按 stock.max 提满"。未启用时回退到 `auto_purchase_count`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseSchedule {
    /// 是否启用分时段
    #[serde(default)]
    pub enabled: bool,
    /// 高峰时段规则（多条，命中任一即为高峰）
    #[serde(default)]
    pub peak_windows: Vec<PeakWindow>,
    /// 高峰提货量（0 = 提满）
    #[serde(default)]
    pub peak_count: u32,
    /// 低谷提货量（0 = 提满）
    #[serde(default)]
    pub offpeak_count: u32,
}

impl PurchaseSchedule {
    /// 给定 (星期几 0-6, 小时 0-23) 是否命中任一高峰规则
    pub fn is_peak(&self, weekday: u8, hour: u8) -> bool {
        self.peak_windows.iter().any(|w| w.matches(weekday, hour))
    }
}

/// 单个上游配置（持久化实体）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamConfig {
    /// 主键，创建时生成
    pub id: String,
    /// 展示名
    pub name: String,
    /// 上游 API 基础地址，如 https://api.example.com
    pub base_url: String,
    /// 上游鉴权 API Key（usr-xxx），敏感，不明文返回给前端
    pub api_key: String,
    /// 本服务对外可达的基础地址（用于拼接 webhook 接收地址并注册到上游）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_base_url: Option<String>,
    /// 本上游 webhook 接收路径的随机密钥（上游回调时带在 path 上鉴别来源）
    pub webhook_token: String,
    /// 是否开启自动提号（收到 new_keys_available 时自动 purchase 并入库）
    #[serde(default)]
    pub auto_purchase_enabled: bool,
    /// 自动提号数量：0 表示按 GET /api/my/stock 的 max 尽量提满
    #[serde(default)]
    pub auto_purchase_count: u32,
    /// 分时段自动提货量（高峰 / 低谷）；启用时覆盖 auto_purchase_count
    #[serde(default)]
    pub schedule: PurchaseSchedule,
    /// 入库凭据使用的端点（如 cli / ide）；留空回退全局 defaultEndpoint。
    /// ksk key 通常走 cli，而全局默认多为 ide，故按上游指定更稳。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// 自动入库时给凭据打的分组
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<String>,
    /// 是否启用该上游（禁用后不接受 webhook、不自动提号）
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 备注
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 创建时间（RFC3339）
    pub created_at: String,
}

fn default_true() -> bool {
    true
}

impl UpstreamConfig {
    /// 计算 webhook 自动提号应使用的数量（None 表示"提满 stock.max"）。
    ///
    /// - 启用分时段：按当前本地 (星期几, 小时) 命中高峰规则选高峰 / 低谷量；量为 0 → None（提满）。
    /// - 未启用：用 auto_purchase_count；为 0 → None（提满）。
    pub fn resolve_auto_count(&self, weekday: u8, hour: u8) -> Option<u32> {
        let n = if self.schedule.enabled {
            if self.schedule.is_peak(weekday, hour) {
                self.schedule.peak_count
            } else {
                self.schedule.offpeak_count
            }
        } else {
            self.auto_purchase_count
        };
        if n > 0 { Some(n) } else { None }
    }
}

/// 脱敏后的上游视图（返回给前端，不含明文 api_key）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamView {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// 脱敏后的 api_key（仅展示尾部）
    pub masked_api_key: String,
    pub receiver_base_url: Option<String>,
    /// 完整 webhook 接收地址（receiver_base_url + 路径）；未配置 receiver_base_url 时为 None
    pub webhook_receiver_url: Option<String>,
    pub auto_purchase_enabled: bool,
    pub auto_purchase_count: u32,
    pub schedule: PurchaseSchedule,
    pub endpoint: Option<String>,
    pub groups: Vec<String>,
    pub enabled: bool,
    pub note: Option<String>,
    pub created_at: String,
}

/// 本服务接收上游 webhook 的相对路径前缀（挂在顶层 app，免 admin 鉴权）
pub const WEBHOOK_PATH_PREFIX: &str = "/api/upstream/webhook";

fn mask_api_key(key: &str) -> String {
    let n = key.chars().count();
    if n <= 6 {
        "****".to_string()
    } else {
        let head: String = key.chars().take(3).collect();
        let tail: String = key.chars().skip(n - 3).collect();
        format!("{}****{}", head, tail)
    }
}

impl UpstreamConfig {
    pub fn to_view(&self) -> UpstreamView {
        let webhook_receiver_url = self.receiver_base_url.as_ref().map(|base| {
            format!(
                "{}{}/{}",
                base.trim_end_matches('/'),
                WEBHOOK_PATH_PREFIX,
                self.webhook_token
            )
        });
        UpstreamView {
            id: self.id.clone(),
            name: self.name.clone(),
            base_url: self.base_url.clone(),
            masked_api_key: mask_api_key(&self.api_key),
            receiver_base_url: self.receiver_base_url.clone(),
            webhook_receiver_url,
            auto_purchase_enabled: self.auto_purchase_enabled,
            auto_purchase_count: self.auto_purchase_count,
            schedule: self.schedule.clone(),
            endpoint: self.endpoint.clone(),
            groups: self.groups.clone(),
            enabled: self.enabled,
            note: self.note.clone(),
            created_at: self.created_at.clone(),
        }
    }
}

// ── 事件日志实体 ─────────────────────────────────────────────────────────────

/// 上游事件类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamEventKind {
    /// 新 Key 就绪（触发自动提号）
    NewKeysAvailable,
    /// 全部 Key 失效（仅记录）
    AllKeysDead,
    /// 自动提号结果
    AutoPurchase,
    /// 手动提号结果
    ManualPurchase,
    /// 其他/错误
    Error,
}

/// 单条事件记录（持久化）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamEvent {
    pub id: String,
    pub upstream_id: String,
    pub upstream_name: String,
    pub kind: UpstreamEventKind,
    /// 人类可读消息
    pub message: String,
    /// 关联订单号（purchase_order_id / client_order_id），可空
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    /// 请求/通知数量
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested: Option<u32>,
    /// 实际入库数量
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported: Option<u32>,
    /// 是否成功
    pub ok: bool,
    pub created_at: String,
}

// ── 上游配置管理器 ───────────────────────────────────────────────────────────

/// 上游配置管理器（线程安全 + 自动持久化）
pub struct UpstreamManager {
    inner: RwLock<Vec<UpstreamConfig>>,
    path: Option<PathBuf>,
}

impl UpstreamManager {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Vec::new()),
            path: None,
        }
    }

    /// 从 `upstreams.json` 加载（不存在时返回空管理器）
    pub fn load<P: AsRef<Path>>(path: P) -> anyhow::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let list: Vec<UpstreamConfig> = if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            if content.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(&content)?
            }
        } else {
            Vec::new()
        };
        Ok(Self {
            inner: RwLock::new(list),
            path: Some(path),
        })
    }

    fn save_locked(&self, list: &[UpstreamConfig]) {
        let path = match &self.path {
            Some(p) => p,
            None => return,
        };
        match serde_json::to_string_pretty(list) {
            Ok(json) => {
                if let Err(e) = std::fs::write(path, json) {
                    tracing::warn!("写入上游配置失败: {}", e);
                }
            }
            Err(e) => tracing::warn!("序列化上游配置失败: {}", e),
        }
    }

    /// 列出所有上游（按创建时间）
    pub fn list(&self) -> Vec<UpstreamConfig> {
        self.inner.read().clone()
    }

    pub fn get(&self, id: &str) -> Option<UpstreamConfig> {
        self.inner.read().iter().find(|u| u.id == id).cloned()
    }

    /// 按 webhook_token 查找（webhook 接收时鉴别来源）
    pub fn find_by_token(&self, token: &str) -> Option<UpstreamConfig> {
        self.inner
            .read()
            .iter()
            .find(|u| u.webhook_token == token)
            .cloned()
    }

    /// 创建上游。生成 id 与 webhook_token。
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        name: String,
        base_url: String,
        api_key: String,
        receiver_base_url: Option<String>,
        auto_purchase_enabled: bool,
        auto_purchase_count: u32,
        schedule: Option<PurchaseSchedule>,
        endpoint: Option<String>,
        groups: Vec<String>,
        note: Option<String>,
    ) -> anyhow::Result<UpstreamConfig> {
        let name = name.trim().to_string();
        if name.is_empty() {
            anyhow::bail!("上游名称不能为空");
        }
        if api_key.trim().is_empty() {
            anyhow::bail!("上游 API Key 不能为空");
        }
        let cfg = UpstreamConfig {
            id: format!("up_{}", random_hex(12)),
            name,
            base_url: base_url.trim().trim_end_matches('/').to_string(),
            api_key: api_key.trim().to_string(),
            receiver_base_url: normalize_opt(receiver_base_url),
            webhook_token: random_hex(32),
            auto_purchase_enabled,
            auto_purchase_count,
            schedule: schedule.unwrap_or_default(),
            endpoint: normalize_opt(endpoint),
            groups,
            enabled: true,
            note: normalize_opt(note),
            created_at: Utc::now().to_rfc3339(),
        };
        let mut inner = self.inner.write();
        inner.push(cfg.clone());
        self.save_locked(&inner);
        Ok(cfg)
    }

    /// 更新可编辑字段（None 表示不改；api_key 为空串表示不改）
    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &self,
        id: &str,
        name: Option<String>,
        base_url: Option<String>,
        api_key: Option<String>,
        receiver_base_url: Option<Option<String>>,
        auto_purchase_enabled: Option<bool>,
        auto_purchase_count: Option<u32>,
        schedule: Option<PurchaseSchedule>,
        endpoint: Option<Option<String>>,
        groups: Option<Vec<String>>,
        enabled: Option<bool>,
        note: Option<Option<String>>,
    ) -> anyhow::Result<UpstreamConfig> {
        let mut inner = self.inner.write();
        let cfg = inner
            .iter_mut()
            .find(|u| u.id == id)
            .ok_or_else(|| anyhow::anyhow!("上游不存在: {}", id))?;
        if let Some(v) = name {
            let v = v.trim().to_string();
            if v.is_empty() {
                anyhow::bail!("上游名称不能为空");
            }
            cfg.name = v;
        }
        if let Some(v) = base_url {
            cfg.base_url = v.trim().trim_end_matches('/').to_string();
        }
        if let Some(v) = api_key {
            let v = v.trim();
            if !v.is_empty() {
                cfg.api_key = v.to_string();
            }
        }
        if let Some(v) = receiver_base_url {
            cfg.receiver_base_url = normalize_opt(v);
        }
        if let Some(v) = auto_purchase_enabled {
            cfg.auto_purchase_enabled = v;
        }
        if let Some(v) = auto_purchase_count {
            cfg.auto_purchase_count = v;
        }
        if let Some(v) = schedule {
            cfg.schedule = v;
        }
        if let Some(v) = endpoint {
            cfg.endpoint = normalize_opt(v);
        }
        if let Some(v) = groups {
            cfg.groups = v;
        }
        if let Some(v) = enabled {
            cfg.enabled = v;
        }
        if let Some(v) = note {
            cfg.note = normalize_opt(v);
        }
        let cloned = cfg.clone();
        self.save_locked(&inner);
        Ok(cloned)
    }

    /// 删除；返回是否真的删了
    pub fn delete(&self, id: &str) -> bool {
        let mut inner = self.inner.write();
        let before = inner.len();
        inner.retain(|u| u.id != id);
        let removed = inner.len() != before;
        if removed {
            self.save_locked(&inner);
        }
        removed
    }
}

impl Default for UpstreamManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── 事件日志 ─────────────────────────────────────────────────────────────────

/// 上游事件日志（环形，持久化到 upstream_events.json）
pub struct UpstreamEventLog {
    inner: RwLock<Vec<UpstreamEvent>>,
    path: Option<PathBuf>,
}

impl UpstreamEventLog {
    pub fn load<P: AsRef<Path>>(path: P) -> Self {
        let path = path.as_ref().to_path_buf();
        let list: Vec<UpstreamEvent> = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .filter(|c| !c.trim().is_empty())
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Self {
            inner: RwLock::new(list),
            path: Some(path),
        }
    }

    fn save_locked(&self, list: &[UpstreamEvent]) {
        if let Some(path) = &self.path {
            if let Ok(json) = serde_json::to_string_pretty(list) {
                let _ = std::fs::write(path, json);
            }
        }
    }

    /// 追加一条事件（新事件在前，超出上限丢弃最旧）
    pub fn push(&self, event: UpstreamEvent) {
        let mut inner = self.inner.write();
        inner.insert(0, event);
        if inner.len() > MAX_EVENTS {
            inner.truncate(MAX_EVENTS);
        }
        self.save_locked(&inner);
    }

    /// 最近 N 条事件
    pub fn recent(&self, limit: usize) -> Vec<UpstreamEvent> {
        let inner = self.inner.read();
        inner.iter().take(limit).cloned().collect()
    }
}

/// 便捷构造事件
#[allow(clippy::too_many_arguments)]
pub fn make_event(
    upstream_id: &str,
    upstream_name: &str,
    kind: UpstreamEventKind,
    message: String,
    order_id: Option<String>,
    requested: Option<u32>,
    imported: Option<u32>,
    ok: bool,
) -> UpstreamEvent {
    UpstreamEvent {
        id: random_hex(12),
        upstream_id: upstream_id.to_string(),
        upstream_name: upstream_name.to_string(),
        kind,
        message,
        order_id,
        requested,
        imported,
        ok,
        created_at: Utc::now().to_rfc3339(),
    }
}

fn normalize_opt(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 生成长度为 `len` 的十六进制随机串
fn random_hex(len: usize) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    (0..len)
        .map(|_| HEX[fastrand::usize(..HEX.len())] as char)
        .collect()
}

pub type SharedUpstreamManager = Arc<UpstreamManager>;
pub type SharedUpstreamEventLog = Arc<UpstreamEventLog>;

/// 默认路径
pub fn default_config_path_in(dir: &Path) -> PathBuf {
    dir.join("upstreams.json")
}
pub fn default_events_path_in(dir: &Path) -> PathBuf {
    dir.join("upstream_events.json")
}

// ── 上游 API 客户端 ──────────────────────────────────────────────────────────

/// GET /api/my/stock 响应
#[derive(Debug, Clone, Deserialize)]
pub struct StockResponse {
    pub max: u32,
}

/// GET /api/my/profile 响应。
/// 上游用 snake_case；对前端序列化用 camelCase，故加 alias 兼容反序列化。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResponse {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub quota: Option<f64>,
    #[serde(default)]
    pub remaining: Option<f64>,
    #[serde(default, alias = "used_quota")]
    pub used_quota: Option<f64>,
    #[serde(default, alias = "webhook_url")]
    pub webhook_url: Option<String>,
}

/// POST /api/my/purchase 返回的单个 key
#[derive(Debug, Clone, Deserialize)]
pub struct PurchasedKey {
    pub key: String,
}

/// POST /api/my/purchase 响应（上游为 snake_case，仅反序列化用，故不 rename）
#[derive(Debug, Clone, Deserialize)]
pub struct PurchaseResponse {
    #[serde(default)]
    pub client_order_id: Option<String>,
    pub purchased: u32,
    #[serde(default)]
    pub remaining: Option<f64>,
    #[serde(default)]
    pub keys: Vec<PurchasedKey>,
}

/// GET /api/my/keys 单条
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KeyItem {
    pub key: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// GET /api/my/keys 响应
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KeysResponse {
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub active: u32,
    #[serde(default)]
    pub keys: Vec<KeyItem>,
}

/// GET /api/my/keys/created-at 响应（账号有效期起点）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysCreatedAtResponse {
    /// 最早一条 Key 的创建时间；无 Key 时为 null
    #[serde(default, alias = "created_at")]
    pub created_at: Option<String>,
    #[serde(default, alias = "key_count")]
    pub key_count: u32,
}

/// GET /api/my/purchase-orders 单条
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrder {
    #[serde(default, alias = "client_order_id")]
    pub client_order_id: Option<String>,
    #[serde(default)]
    pub requested: Option<u32>,
    #[serde(default)]
    pub purchased: Option<u32>,
    #[serde(default, alias = "created_at")]
    pub created_at: Option<String>,
}

/// 上游 API 客户端。每次调用按需构建（无状态），可选走全局代理。
pub struct UpstreamClient {
    base_url: String,
    api_key: String,
    proxy: Option<ProxyConfig>,
    tls_backend: TlsBackend,
}

impl UpstreamClient {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        proxy: Option<ProxyConfig>,
        tls_backend: TlsBackend,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            proxy,
            tls_backend,
        }
    }

    fn client(&self) -> anyhow::Result<reqwest::Client> {
        build_client(self.proxy.as_ref(), UPSTREAM_TIMEOUT_SECS, self.tls_backend)
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with('/') {
            format!("{}{}", self.base_url, path)
        } else {
            format!("{}/{}", self.base_url, path)
        }
    }

    /// 统一处理：非 2xx 时读取 {"error":"..."} 并抛错
    async fn parse_json<T: serde::de::DeserializeOwned>(
        resp: reqwest::Response,
    ) -> anyhow::Result<T> {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // 上游失败响应格式为 {"error":"..."}
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
            anyhow::bail!("上游返回错误（{}）: {}", status.as_u16(), msg);
        }
        serde_json::from_str::<T>(&text)
            .map_err(|e| anyhow::anyhow!("解析上游响应失败: {} (body: {})", e, truncate(&text, 200)))
    }

    /// GET /api/my/stock —— 本轮最大可提取数量
    pub async fn get_stock(&self) -> anyhow::Result<StockResponse> {
        let resp = self
            .client()?
            .get(self.url("/api/my/stock"))
            .header("X-API-Key", &self.api_key)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// GET /api/my/profile —— 余额与 webhook 配置
    pub async fn get_profile(&self) -> anyhow::Result<ProfileResponse> {
        let resp = self
            .client()?
            .get(self.url("/api/my/profile"))
            .header("X-API-Key", &self.api_key)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// GET /api/my/keys —— 全部 Key（history=1 含已失效）
    pub async fn get_keys(&self, history: bool) -> anyhow::Result<KeysResponse> {
        let mut req = self
            .client()?
            .get(self.url("/api/my/keys"))
            .header("X-API-Key", &self.api_key);
        if history {
            req = req.query(&[("history", "1")]);
        }
        Self::parse_json(req.send().await?).await
    }

    /// GET /api/my/keys/created-at —— 账号最早 Key 创建时间（有效期起点）
    pub async fn get_keys_created_at(&self) -> anyhow::Result<KeysCreatedAtResponse> {
        let resp = self
            .client()?
            .get(self.url("/api/my/keys/created-at"))
            .header("X-API-Key", &self.api_key)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// GET /api/my/purchase-orders —— 最近 50 条提取订单
    pub async fn get_purchase_orders(&self) -> anyhow::Result<Vec<PurchaseOrder>> {
        let resp = self
            .client()?
            .get(self.url("/api/my/purchase-orders"))
            .header("X-API-Key", &self.api_key)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// GET /api/status —— 系统运行状态、Key 数量、库存等（宽松透传原始 JSON）
    pub async fn get_status(&self) -> anyhow::Result<serde_json::Value> {
        let resp = self
            .client()?
            .get(self.url("/api/status"))
            .header("X-API-Key", &self.api_key)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// POST /api/my/purchase —— 提号。`client_order_id` 幂等键。
    pub async fn purchase(
        &self,
        count: u32,
        client_order_id: &str,
    ) -> anyhow::Result<PurchaseResponse> {
        let resp = self
            .client()?
            .post(self.url("/api/my/purchase"))
            .header("X-API-Key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "count": count,
                "client_order_id": client_order_id,
            }))
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// PUT /api/my/webhook —— 注册回调地址到上游
    pub async fn set_webhook(&self, webhook_url: &str) -> anyhow::Result<()> {
        let resp = self
            .client()?
            .put(self.url("/api/my/webhook"))
            .header("X-API-Key", &self.api_key)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({ "webhook_url": webhook_url }))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let msg = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
            anyhow::bail!("注册 webhook 失败（{}）: {}", status.as_u16(), msg);
        }
        Ok(())
    }

    /// POST /api/my/webhook/test —— 让上游给已保存的 webhook 推一条测试
    pub async fn test_webhook(&self) -> anyhow::Result<()> {
        let resp = self
            .client()?
            .post(self.url("/api/my/webhook/test"))
            .header("X-API-Key", &self.api_key)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("测试 webhook 失败（{}）: {}", status.as_u16(), truncate(&text, 200));
        }
        Ok(())
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// 生成 32 位十六进制 client_order_id（用于手动提号时的幂等键）
pub fn new_client_order_id() -> String {
    random_hex(32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_hides_middle() {
        assert_eq!(mask_api_key("usr-abcdefgh"), "usr****fgh");
        assert_eq!(mask_api_key("short"), "****");
    }

    #[test]
    fn create_and_find_by_token() {
        let mgr = UpstreamManager::new();
        let cfg = mgr
            .create(
                "test".into(),
                "https://api.example.com/".into(),
                "usr-xxx".into(),
                Some("https://me.example.com".into()),
                true,
                5,
                None,
                None,
                vec![],
                None,
            )
            .unwrap();
        assert!(cfg.base_url.ends_with("com")); // 尾部斜杠被去掉
        assert_eq!(cfg.webhook_token.len(), 32);
        let found = mgr.find_by_token(&cfg.webhook_token).unwrap();
        assert_eq!(found.id, cfg.id);
        // 视图脱敏 + 拼接 webhook 地址
        let view = cfg.to_view();
        assert!(!view.masked_api_key.contains("usr-xxx"));
        assert_eq!(
            view.webhook_receiver_url.unwrap(),
            format!("https://me.example.com/api/upstream/webhook/{}", cfg.webhook_token)
        );
    }

    #[test]
    fn update_partial_keeps_api_key_when_blank() {
        let mgr = UpstreamManager::new();
        let cfg = mgr
            .create("t".into(), "https://a.com".into(), "usr-keep".into(), None, false, 0, None, None, vec![], None)
            .unwrap();
        let updated = mgr
            .update(
                &cfg.id,
                Some("t2".into()),
                None,
                Some("".into()), // 空串 → 不改 api_key
                None,
                Some(true),
                Some(3),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(updated.name, "t2");
        assert_eq!(updated.api_key, "usr-keep");
        assert!(updated.auto_purchase_enabled);
        assert_eq!(updated.auto_purchase_count, 3);
    }

    #[test]
    fn delete_removes() {
        let mgr = UpstreamManager::new();
        let cfg = mgr
            .create("t".into(), "https://a.com".into(), "usr".into(), None, false, 0, None, None, vec![], None)
            .unwrap();
        assert!(mgr.delete(&cfg.id));
        assert!(!mgr.delete(&cfg.id));
        assert!(mgr.get(&cfg.id).is_none());
    }

    #[test]
    fn peak_window_matches_days_and_hours() {
        // 工作日（周一~周五 = 1..=5）9→18
        let w = PeakWindow {
            weekdays: vec![1, 2, 3, 4, 5],
            start_hour: 9,
            end_hour: 18,
        };
        assert!(w.matches(1, 9)); // 周一 9 点
        assert!(w.matches(5, 17)); // 周五 17 点
        assert!(!w.matches(5, 18)); // 右开
        assert!(!w.matches(0, 10)); // 周日不在集合
        assert!(!w.matches(6, 10)); // 周六不在集合

        // 空 weekdays = 每天；跨天窗口 22→6
        let night = PeakWindow {
            weekdays: vec![],
            start_hour: 22,
            end_hour: 6,
        };
        assert!(night.matches(3, 23));
        assert!(night.matches(0, 2));
        assert!(!night.matches(3, 12));
    }

    #[test]
    fn schedule_multiple_windows_and_resolve() {
        // 两条高峰：工作日 9-12，以及每天 19-22
        let sched = PurchaseSchedule {
            enabled: true,
            peak_windows: vec![
                PeakWindow { weekdays: vec![1, 2, 3, 4, 5], start_hour: 9, end_hour: 12 },
                PeakWindow { weekdays: vec![], start_hour: 19, end_hour: 22 },
            ],
            peak_count: 20,
            offpeak_count: 3,
        };
        assert!(sched.is_peak(1, 10)); // 周一 10 点 → 命中第一条
        assert!(sched.is_peak(0, 20)); // 周日 20 点 → 命中第二条
        assert!(!sched.is_peak(0, 10)); // 周日 10 点 → 都不命中
        assert!(!sched.is_peak(1, 15)); // 周一 15 点 → 都不命中

        let mut cfg = UpstreamConfig {
            id: "x".into(),
            name: "n".into(),
            base_url: "b".into(),
            api_key: "k".into(),
            receiver_base_url: None,
            webhook_token: "t".into(),
            auto_purchase_enabled: true,
            auto_purchase_count: 7,
            schedule: sched,
            endpoint: None,
            groups: vec![],
            enabled: true,
            note: None,
            created_at: "c".into(),
        };
        assert_eq!(cfg.resolve_auto_count(1, 10), Some(20)); // 高峰
        assert_eq!(cfg.resolve_auto_count(0, 10), Some(3)); // 低谷

        // 低谷量 0 → None（提满）
        cfg.schedule.offpeak_count = 0;
        assert_eq!(cfg.resolve_auto_count(0, 10), None);

        // 未启用 → 用 auto_purchase_count
        cfg.schedule.enabled = false;
        assert_eq!(cfg.resolve_auto_count(0, 10), Some(7));
        cfg.auto_purchase_count = 0;
        assert_eq!(cfg.resolve_auto_count(0, 10), None);
    }
}


