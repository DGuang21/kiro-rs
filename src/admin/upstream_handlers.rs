//! 补货上游相关 HTTP 处理器
//!
//! 包含两部分：
//! 1. Admin 端点（`/api/admin/upstream/*`，需 admin 鉴权）：上游 CRUD、查库存/余额、
//!    手动提号、注册/测试 webhook、查事件日志。
//! 2. 公共 webhook 接收端点（`/api/upstream/webhook/{token}`，免 admin 鉴权，靠 token 鉴别）。

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};

use super::middleware::AdminState;
use super::upstream::{
    UpstreamEventKind, WEBHOOK_PATH_PREFIX, make_event, new_client_order_id,
};

// ── 请求体 ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUpstreamRequest {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub receiver_base_url: Option<String>,
    #[serde(default)]
    pub auto_purchase_enabled: bool,
    #[serde(default)]
    pub auto_purchase_count: u32,
    /// 分时段自动提货量（高峰 / 低谷）
    #[serde(default)]
    pub schedule: Option<super::upstream::PurchaseSchedule>,
    /// 入库凭据使用的端点（cli / ide 等），留空回退全局默认
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUpstreamRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    /// 空串表示不修改
    #[serde(default)]
    pub api_key: Option<String>,
    /// 传 null 清除，传字符串设置，不传则不改（用 Option<Option<T>> 表达）
    #[serde(default, deserialize_with = "double_option")]
    pub receiver_base_url: Option<Option<String>>,
    #[serde(default)]
    pub auto_purchase_enabled: Option<bool>,
    #[serde(default)]
    pub auto_purchase_count: Option<u32>,
    #[serde(default)]
    pub schedule: Option<super::upstream::PurchaseSchedule>,
    #[serde(default, deserialize_with = "double_option")]
    pub endpoint: Option<Option<String>>,
    #[serde(default)]
    pub groups: Option<Vec<String>>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub note: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualPurchaseRequest {
    /// 期望数量；缺省或 0 表示按 stock.max 提满
    #[serde(default)]
    pub count: u32,
}

// serde: 区分"字段缺失"与"显式 null"
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

// ── 响应体 ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockView {
    pub max: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseResult {
    pub client_order_id: String,
    pub purchased: u32,
    pub imported: u32,
}

// ── Admin 端点：CRUD ─────────────────────────────────────────────────────────

/// GET /api/admin/upstream —— 列出所有上游（脱敏）
pub async fn list_upstreams(State(state): State<AdminState>) -> impl IntoResponse {
    let views: Vec<_> = state.upstreams.list().iter().map(|u| u.to_view()).collect();
    Json(serde_json::json!({ "total": views.len(), "upstreams": views }))
}

/// POST /api/admin/upstream —— 创建
pub async fn create_upstream(
    State(state): State<AdminState>,
    Json(req): Json<CreateUpstreamRequest>,
) -> impl IntoResponse {
    match state.upstreams.create(
        req.name,
        req.base_url,
        req.api_key,
        req.receiver_base_url,
        req.auto_purchase_enabled,
        req.auto_purchase_count,
        req.schedule,
        req.endpoint,
        req.groups,
        req.note,
    ) {
        Ok(cfg) => Json(cfg.to_view()).into_response(),
        Err(e) => bad_request(e.to_string()),
    }
}

/// PUT /api/admin/upstream/{id} —— 更新
pub async fn update_upstream(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateUpstreamRequest>,
) -> impl IntoResponse {
    match state.upstreams.update(
        &id,
        req.name,
        req.base_url,
        req.api_key,
        req.receiver_base_url,
        req.auto_purchase_enabled,
        req.auto_purchase_count,
        req.schedule,
        req.endpoint,
        req.groups,
        req.enabled,
        req.note,
    ) {
        Ok(cfg) => Json(cfg.to_view()).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("不存在") {
                (StatusCode::NOT_FOUND, Json(err_body(msg))).into_response()
            } else {
                bad_request(msg)
            }
        }
    }
}

/// DELETE /api/admin/upstream/{id}
pub async fn delete_upstream(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if state.upstreams.delete(&id) {
        Json(serde_json::json!({ "success": true, "message": "已删除" })).into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response()
    }
}

// ── Admin 端点：动作 ─────────────────────────────────────────────────────────

/// GET /api/admin/upstream/{id}/stock —— 查询本轮最大可提取数量
pub async fn upstream_stock(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client.get_stock().await {
        Ok(s) => Json(StockView { max: s.max }).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/{id}/profile —— 查询余额与 webhook 配置
pub async fn upstream_profile(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client.get_profile().await {
        Ok(p) => Json(p).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/{id}/keys —— 全部 Key（?history=1 含失效）
pub async fn upstream_keys(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let history = q.get("history").map(|v| v == "1").unwrap_or(false);
    let client = state.service.build_upstream_client(&cfg);
    match client.get_keys(history).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/{id}/created-at —— 账号有效期起点
pub async fn upstream_created_at(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client.get_keys_created_at().await {
        Ok(r) => Json(r).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/{id}/orders —— 最近提取订单
pub async fn upstream_orders(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client.get_purchase_orders().await {
        Ok(list) => Json(serde_json::json!({ "orders": list })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/{id}/status —— 上游系统状态与库存
pub async fn upstream_status(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client.get_status().await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// POST /api/admin/upstream/{id}/purchase —— 手动提号并入库
///
/// 手动提号**必须显式指定数量**（count >= 1），不允许自动按上限提满；
/// 「按最低消费自动提满」只在 webhook 自动提号路径生效。
pub async fn upstream_purchase(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    Json(req): Json<ManualPurchaseRequest>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    if req.count == 0 {
        return bad_request("手动提号必须指定数量（count ≥ 1）");
    }
    let order_id = new_client_order_id();
    let count = Some(req.count);
    let source_channel = Some(cfg.name.clone());
    let result = state
        .service
        .upstream_purchase_and_import(&cfg, count, &order_id, cfg.groups.clone(), source_channel)
        .await;

    match result {
        Ok((purchased, imported)) => {
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::ManualPurchase,
                format!("手动提号：请求 {} 个，出 Key {} 个，入库 {} 个", req.count, purchased, imported),
                Some(order_id.clone()),
                count,
                Some(imported),
                true,
            ));
            Json(PurchaseResult {
                client_order_id: order_id,
                purchased,
                imported,
            })
            .into_response()
        }
        Err(e) => {
            // 上游真实错误原样透出（余额不足 / 暂无可用 Key 等）
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::ManualPurchase,
                format!("手动提号失败: {}", e),
                Some(order_id),
                count,
                Some(0),
                false,
            ));
            (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response()
        }
    }
}

/// POST /api/admin/upstream/{id}/webhook/register —— 把本服务接收地址注册到上游
pub async fn upstream_register_webhook(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let Some(base) = cfg.receiver_base_url.as_ref() else {
        return bad_request("请先配置本服务对外可达地址（receiverBaseUrl）再注册");
    };
    let webhook_url = format!(
        "{}{}/{}",
        base.trim_end_matches('/'),
        WEBHOOK_PATH_PREFIX,
        cfg.webhook_token
    );
    let client = state.service.build_upstream_client(&cfg);
    match client.set_webhook(&webhook_url).await {
        Ok(_) => Json(serde_json::json!({
            "success": true,
            "message": "已注册 webhook 到上游",
            "webhookUrl": webhook_url,
        }))
        .into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// POST /api/admin/upstream/{id}/webhook/test —— 让上游给已保存 webhook 推测试
pub async fn upstream_test_webhook(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client.test_webhook().await {
        Ok(_) => Json(serde_json::json!({ "success": true, "message": "已触发测试推送" }))
            .into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/events —— 最近事件日志
pub async fn upstream_events(State(state): State<AdminState>) -> impl IntoResponse {
    let events = state.upstream_events.recent(200);
    Json(serde_json::json!({ "total": events.len(), "events": events }))
}

// ── 公共 webhook 接收端点（免 admin 鉴权，靠 path 中的 token 鉴别来源）──────────

/// 上游 webhook 回调体（宽松解析，未知字段忽略）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WebhookPayload {
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub event_id: Option<String>,
    /// new_keys_available 携带：自动提号时必须原样作为 client_order_id
    #[serde(default)]
    pub purchase_order_id: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub new_keys: Option<u32>,
    #[serde(default)]
    pub dead: Option<u32>,
}

/// POST /api/upstream/webhook/{token}
///
/// - `new_keys_available`：按上游配置自动提号（若开启），后台异步执行，立即 ack。
/// - `all_keys_dead`：仅记录事件。
/// - 未知 token → 404；未知/停用上游 → 404；其余一律 200 ack（避免上游反复重试）。
pub async fn receive_webhook(
    State(state): State<AdminState>,
    Path(token): Path<String>,
    Json(payload): Json<WebhookPayload>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.find_by_token(&token) else {
        return (StatusCode::NOT_FOUND, Json(err_body("未知 webhook token"))).into_response();
    };
    if !cfg.enabled {
        return (StatusCode::NOT_FOUND, Json(err_body("上游已禁用"))).into_response();
    }

    match payload.event.as_str() {
        "all_keys_dead" => {
            let dead = payload.dead.unwrap_or(0);
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::AllKeysDead,
                payload
                    .message
                    .clone()
                    .unwrap_or_else(|| format!("本轮全部 {} 个 Key 已失效", dead)),
                None,
                Some(dead),
                None,
                true,
            ));
        }
        "new_keys_available" => {
            // 先记录收到通知
            let new_keys = payload.new_keys.unwrap_or(0);
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::NewKeysAvailable,
                payload
                    .message
                    .clone()
                    .unwrap_or_else(|| format!("新一轮 {} 个 Key 已就绪", new_keys)),
                payload.purchase_order_id.clone(),
                Some(new_keys),
                None,
                true,
            ));

            if cfg.auto_purchase_enabled {
                // 后台异步提号，避免阻塞 webhook 响应；上游重试时 client_order_id 不变 → 幂等
                let state2 = state.clone();
                let order_id = payload
                    .purchase_order_id
                    .clone()
                    .unwrap_or_else(new_client_order_id);
                tokio::spawn(async move {
                    run_auto_purchase(state2, cfg, order_id).await;
                });
            } else {
                tracing::info!("上游 {} 未开启自动提号，仅记录通知", cfg.name);
            }
        }
        other => {
            tracing::info!("上游 {} 收到未知 webhook 事件: {}", cfg.name, other);
        }
    }

    // 统一 ack
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// 执行一次自动提号并入库，结果记入事件日志
async fn run_auto_purchase(
    state: AdminState,
    cfg: super::upstream::UpstreamConfig,
    order_id: String,
) {
    // 按服务器本地当前 (星期几, 小时) 决定提货量（分时段：命中任一高峰规则用高峰量，
    // 否则用低谷量；未启用分时段则用固定量）。None 表示按 stock.max 提满。
    let now = chrono::Local::now();
    let weekday = now.weekday().num_days_from_sunday() as u8; // 0=周日…6=周六
    let hour = now.hour() as u8;
    let count = cfg.resolve_auto_count(weekday, hour);
    let source_channel = Some(cfg.name.clone());
    match state
        .service
        .upstream_purchase_and_import(&cfg, count, &order_id, cfg.groups.clone(), source_channel)
        .await
    {
        Ok((purchased, imported)) => {
            tracing::info!(
                "上游 {} 自动提号成功：出 Key {}，入库 {}",
                cfg.name,
                purchased,
                imported
            );
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::AutoPurchase,
                format!("自动提号：出 Key {} 个，入库 {} 个", purchased, imported),
                Some(order_id),
                count,
                Some(imported),
                true,
            ));
        }
        Err(e) => {
            tracing::warn!("上游 {} 自动提号失败: {}", cfg.name, e);
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::AutoPurchase,
                format!("自动提号失败: {}", e),
                Some(order_id),
                None,
                Some(0),
                false,
            ));
        }
    }
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

fn err_body(msg: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "error": msg.into() })
}

fn bad_request(msg: impl Into<String>) -> axum::response::Response {
    (StatusCode::BAD_REQUEST, Json(err_body(msg))).into_response()
}


