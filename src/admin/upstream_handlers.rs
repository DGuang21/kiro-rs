//! 补货上游相关 HTTP 处理器
//!
//! 包含两部分：
//! 1. Admin 端点（`/api/admin/upstream/*`，需 admin 鉴权）：上游 CRUD、查库存/余额、
//!    手动提号、注册/测试 webhook、查事件日志。
//! 2. 公共 webhook 接收端点（`/api/upstream/webhook/{token}`，免 admin 鉴权，靠 token 鉴别）。

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};

use super::middleware::AdminState;
use super::upstream::{
    KiroCeoZone, UpstreamEventKind, UpstreamPlatform, WEBHOOK_PATH_PREFIX, make_event,
    new_client_order_id,
};

// ── 请求体 ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUpstreamRequest {
    pub name: String,
    #[serde(default)]
    pub platform: UpstreamPlatform,
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub receiver_base_url: Option<String>,
    /// `key_pulled` 直推协议可选的 `X-Webhook-Secret` 口令。
    #[serde(default)]
    pub webhook_secret: Option<String>,
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
    pub platform: Option<UpstreamPlatform>,
    #[serde(default)]
    pub base_url: Option<String>,
    /// 空串表示不修改
    #[serde(default)]
    pub api_key: Option<String>,
    /// 传 null 清除，传字符串设置，不传则不改（用 Option<Option<T>> 表达）
    #[serde(default, deserialize_with = "double_option")]
    pub receiver_base_url: Option<Option<String>>,
    /// 传 null 清除，传字符串设置，不传则不改。
    #[serde(default, deserialize_with = "double_option")]
    pub webhook_secret: Option<Option<String>>,
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
    /// Kiro CEO 库存区域；缺省保持兼容行为，使用美国区。
    #[serde(default)]
    pub zone: Option<KiroCeoZone>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_price: Option<f64>,
    /// 仅 Kiro Market：该接口一次就返回余额，前端无需再打 /profile
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<f64>,
    /// 仅 Kiro Market：阶梯定价的最高价（key_price 是最低价）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_max: Option<f64>,
    /// Kiro CEO 的两区库存；其他平台省略。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub zones: Vec<StockZoneView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockZoneView {
    pub zone: KiroCeoZone,
    pub max: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_price: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
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
    let views: Vec<_> = state
        .upstreams
        .list()
        .iter()
        .map(|upstream| {
            let mut view = upstream.to_view();
            view.pickup_total = state.upstream_events.pickup_total(&upstream.id);
            view
        })
        .collect();
    Json(serde_json::json!({ "total": views.len(), "upstreams": views }))
}

/// POST /api/admin/upstream —— 创建
pub async fn create_upstream(
    State(state): State<AdminState>,
    Json(req): Json<CreateUpstreamRequest>,
) -> impl IntoResponse {
    match state.upstreams.create(
        req.name,
        req.platform,
        req.base_url,
        req.api_key,
        req.receiver_base_url,
        req.webhook_secret,
        req.auto_purchase_enabled,
        req.auto_purchase_count,
        req.schedule,
        req.endpoint,
        req.groups,
        req.note,
    ) {
        Ok(cfg) => {
            let mut view = cfg.to_view();
            view.pickup_total = state.upstream_events.pickup_total(&cfg.id);
            Json(view).into_response()
        }
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
        req.platform,
        req.base_url,
        req.api_key,
        req.receiver_base_url,
        req.webhook_secret,
        req.auto_purchase_enabled,
        req.auto_purchase_count,
        req.schedule,
        req.endpoint,
        req.groups,
        req.enabled,
        req.note,
    ) {
        Ok(cfg) => {
            let mut view = cfg.to_view();
            view.pickup_total = state.upstream_events.pickup_total(&cfg.id);
            Json(view).into_response()
        }
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

/// POST /api/admin/upstream/{id}/pickup-total/reset
///
/// 追加一个对账分界事件，不删除任何历史提货记录。
pub async fn reset_upstream_pickup_total(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let previous_total = state.upstream_events.reset_pickup_total(&cfg.id, &cfg.name);
    Json(serde_json::json!({
        "success": true,
        "previousTotal": previous_total,
        "pickupTotal": 0,
    }))
    .into_response()
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
        Ok(s) => {
            let zones = s
                .zones
                .iter()
                .map(|zone| StockZoneView {
                    zone: zone.zone,
                    max: zone.effective_max(),
                    key_price: zone.effective_price(),
                    label: zone.label.clone(),
                    enabled: zone.enabled,
                })
                .collect();
            Json(StockView {
                max: s.max,
                key_price: s.key_price,
                balance: s.balance,
                price_max: s.price_max,
                zones,
            })
            .into_response()
        }
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
    let page = q.get("page").and_then(|v| v.parse::<u32>().ok());
    let page_size = q.get("page_size").and_then(|v| v.parse::<u32>().ok());
    let client = state.service.build_upstream_client(&cfg);
    if cfg.platform == UpstreamPlatform::KiroMarket {
        return match client.market_keys(history, page, page_size).await {
            Ok(r) => Json(r).into_response(),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
        };
    }
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
    if cfg.platform == UpstreamPlatform::KiroMarket {
        // Kiro Market 用 count 表示总数，映射到既有的 keyCount 字段供前端复用
        return match client.market_keys_created_at().await {
            Ok(r) => Json(serde_json::json!({
                "createdAt": r.created_at,
                "keyCount": r.count,
            }))
            .into_response(),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
        };
    }
    match client.get_keys_created_at().await {
        Ok(r) => Json(r).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/{id}/orders —— 最近提取订单
pub async fn upstream_orders(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    if cfg.platform == UpstreamPlatform::KiroMarket {
        let page = q.get("page").and_then(|v| v.parse::<u32>().ok());
        let page_size = q.get("page_size").and_then(|v| v.parse::<u32>().ok());
        return match client.market_orders(page, page_size).await {
            Ok(r) => Json(r).into_response(),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
        };
    }
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
    let kiro_ceo_zone =
        (cfg.platform == UpstreamPlatform::KiroCeo).then_some(req.zone.unwrap_or_default());
    let source_channel = Some(cfg.name.clone());
    // 手动提号不限定开号批次，从全量库存里取。
    let result = state
        .service
        .upstream_purchase_and_import(
            &cfg,
            count,
            &order_id,
            None,
            cfg.groups.clone(),
            source_channel,
            kiro_ceo_zone,
        )
        .await;

    match result {
        Ok((purchased, imported)) => {
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::ManualPurchase,
                format!(
                    "手动提号{}：请求 {} 个，出 Key {} 个，入库 {} 个",
                    kiro_ceo_zone
                        .map(|zone| format!("（{}）", zone.as_str()))
                        .unwrap_or_default(),
                    req.count,
                    purchased,
                    imported
                ),
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
    if !cfg.platform.can_register_webhook() {
        return bad_request(webhook_register_unsupported_hint(cfg.platform));
    }
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
    if !cfg.platform.can_register_webhook() {
        return bad_request(webhook_register_unsupported_hint(cfg.platform));
    }
    let client = state.service.build_upstream_client(&cfg);
    match client.test_webhook().await {
        Ok(_) => Json(serde_json::json!({ "success": true, "message": "已触发测试推送" }))
            .into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/events —— 最近事件日志 + 取货统计
pub async fn upstream_events(State(state): State<AdminState>) -> impl IntoResponse {
    let events = state.upstream_events.recent(200);
    let stats = state.upstream_events.stats();
    Json(serde_json::json!({
        "total": events.len(),
        "events": events,
        "stats": stats,
    }))
}

// ── Kiro Market 专属端点 ─────────────────────────────────────────────────────

/// 兑换码充值请求体
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemRequest {
    pub code: String,
}

/// 签发 API 令牌请求体
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueTokenRequest {
    #[serde(default)]
    pub name: Option<String>,
    /// 有效期天数；0 = 永不过期，最长 365
    #[serde(default)]
    pub expires_in_days: Option<u32>,
}

/// GET /api/admin/upstream/{id}/ledger —— 积分流水
pub async fn upstream_ledger(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let page = q.get("page").and_then(|v| v.parse::<u32>().ok());
    let page_size = q.get("page_size").and_then(|v| v.parse::<u32>().ok());
    let entry_type = q.get("type").map(String::as_str);
    let client = state.service.build_upstream_client(&cfg);
    match client.market_ledger(page, page_size, entry_type).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// POST /api/admin/upstream/{id}/redeem —— 兑换码充值
pub async fn upstream_redeem(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    Json(req): Json<RedeemRequest>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    if req.code.trim().is_empty() {
        return bad_request("兑换码不能为空");
    }
    let client = state.service.build_upstream_client(&cfg);
    match client.market_redeem(req.code.trim()).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// GET /api/admin/upstream/{id}/tokens —— API 令牌列表（不含明文）
pub async fn upstream_tokens(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client.market_tokens().await {
        Ok(list) => Json(serde_json::json!({ "tokens": list })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// POST /api/admin/upstream/{id}/tokens —— 签发令牌
///
/// 上游只在此处返回一次明文，因此原样透传给调用方，本服务不落盘。
pub async fn upstream_issue_token(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    Json(req): Json<IssueTokenRequest>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client
        .market_issue_token(req.name.as_deref(), req.expires_in_days)
        .await
    {
        Ok(r) => Json(r).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
}

/// DELETE /api/admin/upstream/{id}/tokens/{tokenId} —— 吊销令牌
pub async fn upstream_revoke_token(
    State(state): State<AdminState>,
    Path((id, token_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.get(&id) else {
        return (StatusCode::NOT_FOUND, Json(err_body("上游不存在"))).into_response();
    };
    let client = state.service.build_upstream_client(&cfg);
    match client.market_revoke_token(&token_id).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(err_body(e.to_string()))).into_response(),
    }
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
    /// new_keys_available 携带：自动提号时必须原样作为 client_order_id。
    ///
    /// 老平台叫 `purchase_order_id`，Kiro Market 叫 `client_order_id`（由「批次+收件人」
    /// 确定性派生，推送重试/服务重启后都是同一个值），故用 alias 同时接受两者。
    #[serde(default, alias = "client_order_id")]
    pub purchase_order_id: Option<String>,
    /// Kiro Market 的开号批次 id。原样回传给 `POST /api/me/purchase` 即可只拉该批次的 Key。
    #[serde(default)]
    pub order_id: Option<String>,
    /// Kiro CEO 补货区域（us / eu）。
    #[serde(default)]
    pub zone: Option<String>,
    /// Kiro Market：母号 id，仅记录
    #[serde(default)]
    pub mother_id: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub new_keys: Option<u32>,
    #[serde(default)]
    pub dead: Option<u32>,
    /// `key_pulled`：来源平台。
    #[serde(default)]
    pub provider: Option<String>,
    /// `key_pulled`：上游拉取时间（Unix 毫秒）。
    #[serde(default)]
    pub pulled_at: Option<i64>,
    /// `key_pulled`：用于对账的打码 Key。
    #[serde(default)]
    pub key_masked: Option<String>,
    /// `key_pulled`：可直接使用的完整 Kiro API Key。
    #[serde(default)]
    pub key: Option<String>,
}

/// POST /api/upstream/webhook/{token}
///
/// - `key_pulled`：先回 200，再在后台将 payload.key 去重入库。
/// - `new_keys_available`：按上游配置自动提号（若开启），后台异步执行，立即 ack。
/// - `all_keys_dead`：仅记录事件。
/// - 未知 token → 404；未知/停用上游 → 404；其余一律 200 ack（避免上游反复重试）。
pub async fn receive_webhook(
    State(state): State<AdminState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<WebhookPayload>,
) -> impl IntoResponse {
    let Some(cfg) = state.upstreams.find_by_token(&token) else {
        return (StatusCode::NOT_FOUND, Json(err_body("未知 webhook token"))).into_response();
    };
    if !cfg.enabled {
        return (StatusCode::NOT_FOUND, Json(err_body("上游已禁用"))).into_response();
    }

    if cfg.platform.is_direct_key_webhook() {
        if !webhook_secret_authorized(&headers, cfg.webhook_secret.as_deref()) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(err_body("X-Webhook-Secret 校验失败")),
            )
                .into_response();
        }
        if payload.event != "key_pulled" {
            return bad_request("Kiro API Key 通知只接受 key_pulled 事件");
        }
        let Some(key) = payload
            .key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
        else {
            return bad_request("key_pulled 事件缺少 key");
        };
        if !key.starts_with("ksk_") {
            return bad_request("key_pulled 事件的 key 格式无效");
        }

        let masked_key = payload
            .key_masked
            .as_deref()
            .and_then(safe_masked_key)
            .unwrap_or_else(|| mask_pushed_key(&key));
        let provider = payload
            .provider
            .as_deref()
            .and_then(safe_provider)
            .unwrap_or_else(|| "kiroapp.io".to_string());
        let pulled_at = payload.pulled_at;
        let state2 = state.clone();
        tokio::spawn(async move {
            import_pushed_key(state2, cfg, key, masked_key, provider, pulled_at).await;
        });
        return Json(serde_json::json!({ "ok": true })).into_response();
    }

    // 推送失败会重试，同一事件可能送达多次：按 event_id 去重后再处理。
    // 已见过的直接 ack，避免重复记事件、重复触发提号。
    if !state
        .upstream_events
        .mark_event_seen(payload.event_id.as_deref())
    {
        tracing::info!(
            "上游 {} 的 webhook 事件 {:?} 重复送达，已忽略",
            cfg.name,
            payload.event_id
        );
        return Json(serde_json::json!({ "ok": true, "deduplicated": true })).into_response();
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
                let kiro_ceo_zone =
                    match webhook_kiro_ceo_zone(cfg.platform, payload.zone.as_deref()) {
                        Ok(zone) => zone,
                        Err(message) => {
                            state.upstream_events.push(make_event(
                                &cfg.id,
                                &cfg.name,
                                UpstreamEventKind::Error,
                                message,
                                payload.purchase_order_id.clone(),
                                Some(new_keys),
                                Some(0),
                                false,
                            ));
                            return Json(serde_json::json!({ "ok": true })).into_response();
                        }
                    };
                // 后台异步提号，避免阻塞 webhook 响应；上游重试时 client_order_id 不变 → 幂等
                let state2 = state.clone();
                let order_id = payload
                    .purchase_order_id
                    .clone()
                    .unwrap_or_else(new_client_order_id);
                // Kiro Market：把批次 order_id 一并带上，只拉取该批次产出的 Key
                let upstream_order_id = payload.order_id.clone();
                tokio::spawn(async move {
                    run_auto_purchase(state2, cfg, order_id, upstream_order_id, kiro_ceo_zone)
                        .await;
                });
            } else {
                tracing::info!("上游 {} 未开启自动提号，仅记录通知", cfg.name);
            }
        }
        // Kiro Market：Key 因滥用被回收，仅记录，不触发提号
        "key_revoked_abuse" => {
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::KeyRevokedAbuse,
                payload
                    .message
                    .clone()
                    .unwrap_or_else(|| "上游 Key 因滥用被回收".to_string()),
                payload.order_id.clone(),
                None,
                None,
                true,
            ));
        }
        // Kiro Market：网页上「发一条 test 事件」验证连通性
        "test" => {
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::WebhookTest,
                payload
                    .message
                    .clone()
                    .unwrap_or_else(|| "收到上游 Webhook 连通性测试".to_string()),
                None,
                None,
                None,
                true,
            ));
        }
        other => {
            tracing::info!("上游 {} 收到未知 webhook 事件: {}", cfg.name, other);
        }
    }

    // 统一 ack
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// 直推协议必须尽快 ack；实际入库与事件落盘都在后台完成。
async fn import_pushed_key(
    state: AdminState,
    cfg: super::upstream::UpstreamConfig,
    key: String,
    masked_key: String,
    provider: String,
    pulled_at: Option<i64>,
) {
    let source = pulled_at
        .map(|timestamp| format!("{} @ {}", provider, timestamp))
        .unwrap_or(provider);
    match state.service.upstream_import_pushed_key(&cfg, &key).await {
        Ok(true) => {
            tracing::info!("上游 {} 直推 Key 已入库", cfg.name);
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::KeyPulled,
                format!("收到 {} 直推 Key {}，已入库", source, masked_key),
                None,
                Some(1),
                Some(1),
                true,
            ));
        }
        Ok(false) => {
            tracing::info!("上游 {} 直推了重复 Key，已忽略", cfg.name);
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::KeyPulled,
                format!("收到 {} 重复直推 Key {}，已去重", source, masked_key),
                None,
                Some(1),
                Some(0),
                true,
            ));
        }
        Err(error) => {
            tracing::warn!("上游 {} 直推 Key 入库失败: {}", cfg.name, error);
            state.upstream_events.push(make_event(
                &cfg.id,
                &cfg.name,
                UpstreamEventKind::KeyPulled,
                format!("{} 直推 Key {} 入库失败: {}", source, masked_key, error),
                None,
                Some(1),
                Some(0),
                false,
            ));
        }
    }
}

/// 执行一次自动提号并入库，结果记入事件日志
async fn run_auto_purchase(
    state: AdminState,
    cfg: super::upstream::UpstreamConfig,
    order_id: String,
    upstream_order_id: Option<String>,
    kiro_ceo_zone: Option<KiroCeoZone>,
) {
    // 按**北京时间 UTC+8** 当前 (星期几, 小时) 决定提货量（分时段：命中任一高峰规则用高峰量，
    // 否则用低谷量；未启用分时段则用固定量）。不依赖服务器/容器时区。None 表示按 stock.max 提满。
    let now = super::upstream::beijing_now();
    let weekday = now.weekday().num_days_from_sunday() as u8; // 0=周日…6=周六
    let hour = now.hour() as u8;
    let count = cfg.resolve_auto_count(weekday, hour);
    let source_channel = Some(cfg.name.clone());
    match state
        .service
        .upstream_purchase_and_import(
            &cfg,
            count,
            &order_id,
            upstream_order_id.as_deref(),
            cfg.groups.clone(),
            source_channel,
            kiro_ceo_zone,
        )
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

fn webhook_secret_authorized(headers: &HeaderMap, expected: Option<&str>) -> bool {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    headers
        .get("x-webhook-secret")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|actual| crate::common::auth::constant_time_eq(actual, expected))
}

fn webhook_kiro_ceo_zone(
    platform: UpstreamPlatform,
    value: Option<&str>,
) -> Result<Option<KiroCeoZone>, String> {
    if platform != UpstreamPlatform::KiroCeo {
        return Ok(None);
    }
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(Some(KiroCeoZone::Us)),
        Some(value) => KiroCeoZone::parse(value)
            .map(Some)
            .ok_or_else(|| format!("Kiro CEO Webhook 区域无效: {value}")),
    }
}

fn mask_pushed_key(key: &str) -> String {
    let prefix: String = key.chars().take(6).collect();
    format!("{}****", prefix)
}

fn safe_masked_key(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 64
        || !value.contains('*')
        || value.chars().any(char::is_control)
    {
        return None;
    }
    Some(value.to_string())
}

fn safe_provider(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return None;
    }
    Some(value.to_string())
}

/// 「不支持注册/测试回调」的提示文案。
///
/// Kiro Market 会推送 webhook，但回调地址只能在平台网页里填，没有注册 API，
/// 因此要和「完全不支持 webhook」的 KiroApp 区分开，否则用户会以为收不到推送。
fn webhook_register_unsupported_hint(platform: UpstreamPlatform) -> &'static str {
    match platform {
        UpstreamPlatform::KiroMarket => {
            "Kiro Market 不提供注册接口，请到平台网页「设置 → Webhook 配置」填写回调地址，可在那里发送 test 事件验证连通"
        }
        UpstreamPlatform::KiroKeyWebhook => {
            "Kiro API Key 通知没有注册接口，请把生成的 HTTPS 接收地址和可选 Secret 提供给推送方"
        }
        _ => "当前平台不支持 Webhook",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_key_pulled_payload() {
        let payload: WebhookPayload = serde_json::from_value(serde_json::json!({
            "event": "key_pulled",
            "provider": "kiroapp.io",
            "pulled_at": 1730300000000_i64,
            "key_masked": "ksk_ab****",
            "key": "ksk_live_xxxxxxxx"
        }))
        .unwrap();

        assert_eq!(payload.event, "key_pulled");
        assert_eq!(payload.provider.as_deref(), Some("kiroapp.io"));
        assert_eq!(payload.pulled_at, Some(1730300000000));
        assert_eq!(payload.key_masked.as_deref(), Some("ksk_ab****"));
        assert_eq!(payload.key.as_deref(), Some("ksk_live_xxxxxxxx"));
    }

    #[test]
    fn kiro_ceo_webhook_zone_is_strict_and_defaults_to_us() {
        assert_eq!(
            webhook_kiro_ceo_zone(UpstreamPlatform::KiroCeo, Some("eu")).unwrap(),
            Some(KiroCeoZone::Eu)
        );
        assert_eq!(
            webhook_kiro_ceo_zone(UpstreamPlatform::KiroCeo, None).unwrap(),
            Some(KiroCeoZone::Us)
        );
        assert!(webhook_kiro_ceo_zone(UpstreamPlatform::KiroCeo, Some("ap")).is_err());
        assert_eq!(
            webhook_kiro_ceo_zone(UpstreamPlatform::KiroMarket, Some("eu")).unwrap(),
            None
        );
    }

    #[test]
    fn webhook_secret_is_optional_and_compared_exactly() {
        let mut headers = HeaderMap::new();
        assert!(webhook_secret_authorized(&headers, None));
        assert!(!webhook_secret_authorized(&headers, Some("secret")));

        headers.insert("x-webhook-secret", "secret".parse().unwrap());
        assert!(webhook_secret_authorized(&headers, Some("secret")));
        assert!(!webhook_secret_authorized(&headers, Some("different")));
    }

    #[test]
    fn untrusted_masked_key_cannot_put_plain_key_in_events() {
        assert_eq!(safe_masked_key("ksk_ab****").as_deref(), Some("ksk_ab****"));
        assert!(safe_masked_key("ksk_live_plaintext").is_none());
        assert_eq!(mask_pushed_key("ksk_live_xxxxxxxx"), "ksk_li****");
    }
}
