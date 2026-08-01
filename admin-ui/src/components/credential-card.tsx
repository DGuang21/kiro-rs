import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  RefreshCw,
  GripVertical,
  Trash2,
  Loader2,
  Pencil,
  LogIn,
  MoreHorizontal,
  RotateCcw,
  Zap,
  ZapOff,
  Clock,
  ScrollText,
  Boxes,
  Wallet,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SubscriptionBadge } from "@/components/subscription-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  CredentialMetadataFieldSchema,
  CredentialMetadataSchema,
  CredentialStatusItem,
  BalanceResponse,
} from "@/types/api";
import { maskProxyUrl, extractErrorMessage, overageFailureMessage } from "@/lib/utils";
import {
  useSetDisabled,
  useSetPriority,
  useResetFailure,
  useDeleteCredential,
  useForceRefreshToken,
  useResetSuccessCount,
  useClearThrottle,
} from "@/hooks/use-credentials";
import { setCredentialOverage } from "@/api/credentials";
import { useQueryClient } from "@tanstack/react-query";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EditCredentialDialog } from "@/components/edit-credential-dialog";
import { UpdateTokenDialog } from "@/components/update-token-dialog";
import { ReloginDialog } from "@/components/relogin-dialog";
import { CredentialFailuresDialog } from "@/components/credential-failures-dialog";
import { AvailableModelsDialog } from "@/components/available-models-dialog";
import { BalanceDialog } from "@/components/balance-dialog";
import { getDisposition } from "@/components/console/credential-state";
import { railBorderClass } from "@/components/console/rail";
import { PriorityPreview } from "@/components/console/priority-preview";
import { CredentialLabel } from "@/components/console/credential-label";
import { metadataCssToStyle } from "@/lib/credential-metadata-style";

interface CredentialCardProps {
  credential: CredentialStatusItem;
  selected: boolean;
  onToggleSelect: () => void;
  balance: BalanceResponse | null;
  loadingBalance: boolean;
  onRefreshBalance: () => void;
  /** 该凭据的失败分类计数（来自 trace 聚合）；无数据时回退 totalFailureCount */
  failureStats?: { auth: number; throttle: number; other: number };
  /** 展示形态：卡片（默认）或紧凑列表行 */
  view?: "card" | "list";
  /** 字段排序开启时禁用拖拽调优先级（隐藏拖拽手柄） */
  dragDisabled?: boolean;
  metadataSchema?: CredentialMetadataSchema;
}

function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return "从未使用";
  const date = new Date(lastUsedAt);
  const diff = Date.now() - date.getTime();
  if (diff < 0) return "刚刚";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 添加时间用绝对日期展示（凭据的创建时刻是固定事实，相对时间意义不大） */
function formatCreatedAt(createdAt: string | null | undefined): string {
  if (!createdAt) return "未知";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "未知";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 完整时间戳，用于 hover 提示 */
function formatCreatedAtFull(createdAt: string | null | undefined): string {
  if (!createdAt) return "添加时间未知（该凭据在此功能上线前导入）";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "添加时间未知";
  return `添加于 ${date.toLocaleString("zh-CN")}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatResetDate(ts: number | null): string {
  if (!ts) return "未知";
  return new Date(ts * 1000).toLocaleString("zh-CN");
}

/** 把秒数格式化为 `mm:ss` 或 `hh:mm:ss` */
function formatThrottleCountdown(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function metadataValueLabel(
  value: unknown,
  field?: CredentialMetadataFieldSchema,
): string {
  const option = field?.oneOf?.find(
    (item) => JSON.stringify(item.const) === JSON.stringify(value),
  );
  if (option) return option.title;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Schema 字段优先按配置顺序展示，未登记的扩展字段随后按 key 排序。
 * 空值不占卡片空间，但 false 和 0 都是有效 metadata，必须保留。
 */
function metadataEntries(
  credential: CredentialStatusItem,
  schema?: CredentialMetadataSchema,
) {
  const metadata = credential.metadata ?? { type: "normal" as const };
  const schemaKeys = Object.keys(schema?.properties ?? {});
  const extraKeys = Object.keys(metadata)
    .filter((key) => !schemaKeys.includes(key))
    .sort((a, b) => a.localeCompare(b));

  return [...schemaKeys, ...extraKeys]
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .flatMap((key) => {
      const value = metadata[key];
      if (value == null || value === "") return [];
      const field = schema?.properties[key];
      return [{
        key,
        label: field?.title?.trim() || key,
        value: key === "salePrice" && typeof value === "number"
          ? `¥${value.toLocaleString("zh-CN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}`
          : metadataValueLabel(value, field),
        emphasized: key === "type" && value === "boom",
        style: metadataCssToStyle(field?.["x-css"]),
      }];
    });
}

function MetadataSummary({
  credential,
  schema,
  compact = false,
}: {
  credential: CredentialStatusItem;
  schema?: CredentialMetadataSchema;
  compact?: boolean;
}) {
  const entries = metadataEntries(credential, schema);
  if (entries.length === 0) return null;

  if (compact) {
    return (
      <div
        className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden"
        aria-label="凭据 Metadata"
      >
        {entries.map((entry) => (
          <span
            key={entry.key}
            className={`inline-flex min-w-0 max-w-full shrink-0 items-center overflow-hidden rounded-md border px-1.5 py-0.5 text-[11px] ${
              entry.emphasized
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-border/60 bg-muted/45 text-foreground"
            }`}
            title={`${entry.label}: ${entry.value}`}
            style={entry.style}
          >
            <span className="shrink-0 text-muted-foreground">{entry.label}</span>
            <span className="mx-1 text-border">·</span>
            <span className="max-w-40 truncate font-medium">{entry.value}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      className="min-w-0 overflow-hidden rounded-xl border border-border/60"
      aria-label="凭据 Metadata"
    >
      <div className="bg-muted/50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Metadata
      </div>
      <table className="w-full table-fixed text-[12px]">
        <colgroup>
          <col className="w-[38%]" />
          <col />
        </colgroup>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.key} className="border-t border-border/50">
              <th
                scope="row"
                className="bg-muted/20 px-3 py-1.5 text-left font-normal text-muted-foreground"
                title={entry.key === entry.label ? undefined : `key: ${entry.key}`}
              >
                <span className="block truncate">{entry.label}</span>
              </th>
              <td
                className={`px-3 py-1.5 font-medium ${
                  entry.emphasized
                    ? "bg-amber-500/[0.07] text-amber-700 dark:text-amber-300"
                    : "text-foreground"
                }`}
                title={entry.value}
                style={entry.style}
              >
                <span className="block truncate">{entry.value}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 紧凑超额状态胶囊 — 与订阅徽章并列展示，不占整行
 * 三态：已开（绿色实色）/ 未开（中性细描边）/ 不支持（灰色虚边小字）
 */
function OverageStatusPill({ balance }: { balance: BalanceResponse }) {
  const cap = balance.overageCapable;
  const on = balance.overageEnabled === true;

  // 不支持的订阅：极弱化
  if (cap === false) return null;

  if (on) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 h-6 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
        title="此账号已开启超额"
      >
        <Zap className="h-3 w-3" />
        超额
      </span>
    );
  }

  if (cap === true) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-transparent px-2 h-6 text-[11px] font-medium text-amber-600 dark:text-amber-400"
        title="此账号支持超额但当前未开启"
      >
        <ZapOff className="h-3 w-3" />
        未开
      </span>
    );
  }

  // 未知：低调灰色，hover 看原始值
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-border/60 bg-transparent px-2 h-6 text-[11px] text-muted-foreground"
      title={
        balance.overageCapabilityRaw
          ? `overageCapability = ${balance.overageCapabilityRaw}`
          : "上游未返回 overageCapability"
      }
    >
      <ZapOff className="h-3 w-3" />
      未知
    </span>
  );
}

/**
 * 把后端返回的 disabledReason 字符串映射为更直观的中文徽标
 * （颜色/文案/排序权重，越靠前越显眼）
 */
function getDisabledReasonStyle(reason?: string | null): {
  label: string;
  variant: "destructive" | "warning" | "outline" | "secondary";
} | null {
  if (!reason) return null;
  switch (reason) {
    case "QuotaExceeded":
      return { label: "已超额", variant: "warning" };
    case "TooManyFailures":
      return { label: "失败过多", variant: "destructive" };
    case "Suspended":
      return { label: "账号封禁", variant: "destructive" };
    case "TooManyRefreshFailures":
      return { label: "刷新失败过多", variant: "destructive" };
    case "InvalidRefreshToken":
      return { label: "Token 失效", variant: "destructive" };
    case "InvalidConfig":
      return { label: "配置无效", variant: "destructive" };
    case "Manual":
      return { label: "手动禁用", variant: "secondary" };
    default:
      return { label: reason, variant: "outline" };
  }
}

export function CredentialCard({
  credential,
  selected,
  onToggleSelect,
  balance,
  loadingBalance,
  onRefreshBalance,
  failureStats,
  view = "card",
  dragDisabled = false,
  metadataSchema,
}: CredentialCardProps) {
  const [editingPriority, setEditingPriority] = useState(false);
  const [priorityValue, setPriorityValue] = useState(
    String(credential.priority),
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showUpdateTokenDialog, setShowUpdateTokenDialog] = useState(false);
  const [showReloginDialog, setShowReloginDialog] = useState(false);
  const [showFailuresDialog, setShowFailuresDialog] = useState(false);
  const [showModelsDialog, setShowModelsDialog] = useState(false);
  const [showBalanceDialog, setShowBalanceDialog] = useState(false);

  const setDisabled = useSetDisabled();
  const setPriority = useSetPriority();
  const resetFailure = useResetFailure();
  const deleteCredential = useDeleteCredential();
  const forceRefresh = useForceRefreshToken();
  const resetSuccess = useResetSuccessCount();
  const clearThrottle = useClearThrottle();
  const queryClient = useQueryClient();

  // 拖拽排序：手柄触发，整卡随拖动位移
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: credential.id, disabled: dragDisabled });
  const dragStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    // 拖拽中关掉过渡，避免 Card 基类的 transition-all 把每帧 transform 动画化导致"不跟手"；
    // 非拖拽态保留 dnd-kit 的归位过渡。
    transition: isDragging ? "none" : transition,
    zIndex: isDragging ? 20 : undefined,
  };

  // 后端冷却剩余秒数会在 30s 拉取间隔之间过时，本地用 setInterval 自然递减以让倒计时连续。
  const [throttleRemaining, setThrottleRemaining] = useState<number>(
    credential.throttledRemainingSecs ?? 0,
  );
  useEffect(() => {
    setThrottleRemaining(credential.throttledRemainingSecs ?? 0);
  }, [credential.throttledRemainingSecs]);
  useEffect(() => {
    if (throttleRemaining <= 0) return;
    const t = window.setInterval(() => {
      setThrottleRemaining((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => window.clearInterval(t);
  }, [throttleRemaining]);
  const handleClearThrottle = useCallback(() => {
    clearThrottle.mutate(credential.id, {
      onSuccess: (res) => {
        setThrottleRemaining(0);
        toast.success(res.message);
      },
      onError: (err) => toast.error("解除失败: " + extractErrorMessage(err)),
    });
  }, [clearThrottle, credential.id]);
  const [overageBusy, setOverageBusy] = useState(false);
  const handleSetOverage = async (enabled: boolean) => {
    setOverageBusy(true);
    try {
      await setCredentialOverage(credential.id, enabled);
      toast.success(enabled ? "已开启超额" : "已关闭超额");
      queryClient.invalidateQueries({ queryKey: ["credentials"] });
    } catch (err) {
      toast.error(
        (enabled ? "开启" : "关闭") +
          "超额失败: " +
          overageFailureMessage(extractErrorMessage(err)),
      );
    } finally {
      setOverageBusy(false);
    }
  };

  const handleToggleDisabled = () => {
    // 当前为禁用态 → 这次操作是“启用”，启用成功后顺带刷新一次余额
    const willEnable = credential.disabled;
    setDisabled.mutate(
      { id: credential.id, disabled: !credential.disabled },
      {
        onSuccess: (res) => {
          toast.success(res.message);
          if (willEnable) onRefreshBalance();
        },
        onError: (err) => toast.error("操作失败: " + (err as Error).message),
      },
    );
  };

  const handlePriorityChange = () => {
    const np = parseInt(priorityValue, 10);
    if (isNaN(np) || np < 0) {
      toast.error("优先级要填 0 或更大的整数，0 最先被使用");
      return;
    }
    setPriority.mutate(
      { id: credential.id, priority: np },
      {
        onSuccess: (res) => {
          toast.success(res.message);
          setEditingPriority(false);
        },
        onError: (err) => toast.error("操作失败: " + (err as Error).message),
      },
    );
  };

  const handleReset = () =>
    resetFailure.mutate(credential.id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (err) => toast.error("操作失败: " + (err as Error).message),
    });

  const handleForceRefresh = () =>
    forceRefresh.mutate(credential.id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (err) => toast.error("刷新失败: " + extractErrorMessage(err)),
    });

  const handleResetSuccess = () =>
    resetSuccess.mutate(credential.id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (err) => toast.error("重置失败: " + (err as Error).message),
    });

  const handleDelete = () => {
    deleteCredential.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message);
        setShowDeleteDialog(false);
      },
      onError: (err) => toast.error("删除失败: " + (err as Error).message),
    });
  };

  const authLabel = (() => {
    if (credential.authMethod === "api_key") return "API Key";
    const provider = credential.provider?.toLowerCase();
    if (credential.authMethod === "social") {
      if (provider === "github") return "GitHub";
      if (provider === "google") return "Google";
      return "Social";
    }
    if (credential.authMethod === "idc") {
      if (provider === "enterprise") return "Enterprise";
      if (provider === "iam_sso") return "IAM SSO";
      if (provider === "builderid") return "Builder ID";
      return "IdC";
    }
    if (credential.authMethod === "external_idp") {
      if (provider === "azuread") return "Entra ID";
      return "企业 SSO";
    }
    return credential.authMethod;
  })();

  const isQuotaExceeded = balance
    ? balance.remaining <= 0 || balance.usagePercentage >= 100
    : false;

  const disabledByQuota =
    credential.disabled && credential.disabledReason === "QuotaExceeded";
  const reasonStyle = getDisabledReasonStyle(credential.disabledReason);
  const isThrottled = !credential.disabled && throttleRemaining > 0;

  // 状态判定与处置意图 —— 与日志页共用同一套四档色轨语义，
  // 判定逻辑集中在 console/credential-state.ts，卡片与列表行只负责渲染。
  const disposition = getDisposition(credential, balance, throttleRemaining);

  /** 处置意图 → 具体 handler。语义类型在 credential-state 里定义，落地在这里。 */
  const runDisposition = () => {
    switch (disposition.action) {
      case "clearThrottle":
        handleClearThrottle();
        break;
      case "viewBalance":
        setShowBalanceDialog(true);
        break;
      case "relogin":
        setShowReloginDialog(true);
        break;
      case "enable":
        handleToggleDisabled();
        break;
      case "refreshToken":
        handleForceRefresh();
        break;
      case "viewFailures":
        setShowFailuresDialog(true);
        break;
      case "none":
        break;
    }
  };

  /**
   * 处置按钮：这一行当前唯一该做的事。
   *
   * 只在需要处置时出现，健康行不显示 —— 空着本身就是信息："这行不用管"。
   */
  const dispositionButton = disposition.actionLabel ? (
    <Button
      size="sm"
      variant="outline"
      onClick={runDisposition}
      disabled={
        (disposition.action === "clearThrottle" && clearThrottle.isPending) ||
        (disposition.action === "enable" && setDisabled.isPending) ||
        (disposition.action === "refreshToken" && forceRefresh.isPending)
      }
      title={`${disposition.stateLabel} → ${disposition.actionLabel}`}
      className="h-7 whitespace-nowrap px-2.5 text-xs"
    >
      {disposition.actionLabel}
    </Button>
  ) : null;

  // 卡片与列表行共用的状态描边 / 灰化（当前优先 · 超额 · 冷却 · 禁用）
  const stateClasses = [
    credential.isCurrent ? "ring-2 ring-primary/60 shadow-apple-lg" : "",
    !credential.disabled && isQuotaExceeded ? "ring-1 ring-amber-500/60" : "",
    disabledByQuota
      ? "ring-1 ring-amber-500/70 bg-amber-50/40 dark:bg-amber-500/[0.04]"
      : "",
    isThrottled
      ? "ring-1 ring-orange-500/60 bg-orange-50/40 dark:bg-orange-500/[0.04]"
      : "",
    credential.disabled && !disabledByQuota ? "opacity-70" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 订阅 / 状态 / 鉴权等徽章 —— 卡片头部与列表行共用。
  // Metadata 独立展示，避免把账号属性和运行状态混为一谈。
  const badges = (
    <>
      {balance?.subscriptionTitle && (
        <SubscriptionBadge
          title={balance.subscriptionTitle}
          className="max-w-full"
        />
      )}
      {credential.isCurrent && <Badge variant="success">当前优先</Badge>}
      {/* 禁用状态：合并 "已禁用" + 中文化的原因，单个 Badge 更醒目 */}
      {credential.disabled && reasonStyle && (
        <Badge variant={reasonStyle.variant}>已禁用 · {reasonStyle.label}</Badge>
      )}
      {credential.disabled && !reasonStyle && (
        <Badge variant="destructive">已禁用</Badge>
      )}
      {/* 仍启用但已经达到上限：黄色"已超额"徽章 */}
      {!credential.disabled && isQuotaExceeded && (
        <Badge variant="warning">已超额</Badge>
      )}
      {isThrottled && (
        <Badge
          variant="warning"
          className="bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30"
          title="账号级风控冷却中（429 + suspicious activity），到期或手动解除后恢复调度"
        >
          <Clock className="mr-1 h-3 w-3" />
          冷却 {formatThrottleCountdown(throttleRemaining)}
        </Badge>
      )}
      {credential.authMethod && <Badge variant="secondary">{authLabel}</Badge>}
      {/* 配置元信息合并为单个徽章，减少换行：endpoint · ARN */}
      {(credential.endpoint || credential.hasProfileArn) && (
        <Badge
          variant="outline"
          className="max-w-full truncate"
          title={
            credential.hasProfileArn ? "endpoint / 已配置 Profile ARN" : "endpoint"
          }
        >
          {[credential.endpoint, credential.hasProfileArn ? "ARN" : null]
            .filter(Boolean)
            .join(" · ")}
        </Badge>
      )}
      {/* 分组与来源不在这里：它们不是状态，见下方 groupingBlock */}
    </>
  );

  const groups = credential.groups ?? [];

  /**
   * 归属模块：分组 + 来源渠道。
   *
   * 原先这两样和「已禁用」「冷却」「Builder ID」挤在同一串徽章里，但它们回答的是
   * 完全不同的问题 —— 那些说的是"这个号现在怎么了"（会变，要处置），分组说的是
   * "这个号归谁用"（人为归档，稳定）。混在一起的后果是：想按分组扫一眼时，眼睛
   * 得在一排形状相同的胶囊里挑出哪几个是分组，因为它们长得一模一样。
   *
   * 拆成独立一块并加上字段名，分组就有了固定位置：不用读内容也知道去哪儿看。
   */
  const groupingBlock =
    groups.length > 0 || credential.sourceChannel ? (
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 text-[12px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground">分组</span>
          {groups.length > 0 ? (
            groups.map((g) => (
              <span
                key={g}
                className="inline-flex max-w-full items-center truncate rounded-md bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground"
              >
                {g}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground/60">未分组</span>
          )}
        </div>
        {credential.sourceChannel && (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-muted-foreground">来源</span>
            <span className="min-w-0 truncate">{credential.sourceChannel}</span>
          </div>
        )}
      </div>
    ) : null;

  // “更多操作”下拉 —— 卡片与列表行共用
  const moreMenu = (
    // modal={false}：菜单非模态，避免 Radix 在 <html> 上施加 overflow:hidden 滚动锁。
    // 该锁在移动端（尤其 iOS Safari）会与背景层 backdrop-blur / 固定定位叠加，
    // 导致整页渲染错乱或横向位移——这正是移动端点击"更多操作"后页面异常的根因。
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" title="更多操作">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            handleReset();
          }}
          disabled={
            resetFailure.isPending ||
            (credential.failureCount === 0 &&
              credential.refreshFailureCount === 0)
          }
        >
          <RotateCcw />
          重置失败计数
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => setShowModelsDialog(true)}
          disabled={credential.disabled}
          title={credential.disabled ? "已禁用凭据无法查询" : undefined}
        >
          <Boxes />
          查看可用模型
        </DropdownMenuItem>
        {throttleRemaining > 0 && (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              handleClearThrottle();
            }}
            disabled={clearThrottle.isPending}
          >
            <Clock />
            解除风控冷却（{formatThrottleCountdown(throttleRemaining)}）
          </DropdownMenuItem>
        )}
        {balance?.overageCapable === true &&
          (balance.overageEnabled ? (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                handleSetOverage(false);
              }}
              disabled={overageBusy}
            >
              <ZapOff />
              关闭超额
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                handleSetOverage(true);
              }}
              disabled={overageBusy}
            >
              <Zap className="text-emerald-500" />
              开启超额
            </DropdownMenuItem>
          ))}
        {credential.authMethod !== "api_key" && <DropdownMenuSeparator />}
        {credential.authMethod !== "api_key" && (
          <DropdownMenuItem onSelect={() => setShowReloginDialog(true)}>
            <LogIn />
            重新登录
          </DropdownMenuItem>
        )}
        {credential.authMethod !== "api_key" && (
          <DropdownMenuItem onSelect={() => setShowUpdateTokenDialog(true)}>
            <RefreshCw />
            重新导入 Token
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          onSelect={(e) => {
            e.preventDefault();
            setShowDeleteDialog(true);
          }}
        >
          <Trash2 />
          删除凭据
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // 紧凑列表行：继承卡片的全部操作（启用/禁用 · 优先级 · 失败/成功 · 刷新 · 编辑 · 更多 · 拖拽 · 选择）
  const listView = (
    <div
      ref={setNodeRef}
      style={dragStyle}
      data-credential-id={credential.id}
      // 这里刻意不加 overflow-hidden：优先级编辑框与它下方的队列位置预览是绝对定位
      // 浮起的，会有意超出 56px 的优先级列，裁剪会把它们切掉。
      className={`group flex min-w-0 items-center gap-2 rounded-2xl border bg-card px-2 py-2 transition-all sm:gap-3 sm:px-3 ${railBorderClass(
        disposition.tone,
      )} ${
        isDragging
          ? "shadow-apple-lg opacity-80"
          : "hover:bg-accent/40 hover:shadow-apple-sm"
      } ${stateClasses}`}
    >
      {/* 拖拽手柄（字段排序开启时隐藏，此时拖拽无意义） */}
      {!dragDisabled && (
        <Button
          ref={setActivatorNodeRef}
          size="icon"
          variant="ghost"
          data-no-rect-select
          className="h-8 w-8 shrink-0 cursor-grab touch-none active:cursor-grabbing"
          title="拖拽排序 · 越靠上越先被使用"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </Button>
      )}

      {/* 选择框 */}
      <label
        data-no-rect-select
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent"
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          className="h-5 w-5 [&_svg]:h-4 [&_svg]:w-4"
          checked={selected}
          onCheckedChange={onToggleSelect}
        />
      </label>

      {/* 身份 + 徽章 */}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-5">
          <CredentialLabel id={credential.id} email={credential.email} />
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden [&>*]:shrink-0">
          {badges}
          {/* 列表行放不下字段名，用一个前导斜杠把归属信息与状态徽章隔开，
              形状（方角、实底）也与状态胶囊（圆角、描边）不同，扫读时可分辨 */}
          {groups.map((g) => (
            <span
              key={g}
              title="账号分组"
              className="inline-flex items-center rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground"
            >
              {g}
            </span>
          ))}
          {credential.sourceChannel && (
            <span
              title="账号来源渠道"
              className="text-[11px] text-muted-foreground"
            >
              {credential.sourceChannel}
            </span>
          )}
        </div>
        <MetadataSummary
          credential={credential}
          schema={metadataSchema}
          compact
        />
      </div>

      {/* 关键指标（中大屏） */}
      <div className="hidden shrink-0 items-center gap-5 lg:flex">
        <div className="relative w-14 shrink-0 text-center">
          {/* 列宽只有 56px，塞不下「小=先用」。用一个升序楔形符号带住方向，
              完整说明挂 title；点开编辑后由队列位置预览把话说全。 */}
          <div
            className="text-[10px] uppercase tracking-wider text-muted-foreground"
            title="优先级：数字越小越先被使用，0 最先"
          >
            优先级
            <span className="ml-0.5 text-muted-foreground/60">↑</span>
          </div>
          {/* 固定高度占位，避免编辑态切换时整行高度抖动 */}
          <div className="mt-0.5 flex h-[26px] items-center justify-center">
            {editingPriority ? (
              // 编辑栏（≈112px）比列宽（56px）更宽：绝对定位脱离流式布局浮起，
              // 配合背景与 z-index，避免被相邻"失败"列在绘制顺序上覆盖
              <div className="absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-md border border-border/60 bg-card p-1 shadow-apple-sm">
                <div className="inline-flex items-center gap-0.5">
                <Input
                  type="number"
                  value={priorityValue}
                  onChange={(e) => setPriorityValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handlePriorityChange();
                    if (e.key === "Escape") {
                      setEditingPriority(false);
                      setPriorityValue(String(credential.priority));
                    }
                  }}
                  className="h-7 w-16 rounded-md text-sm"
                  min="0"
                  autoFocus
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={handlePriorityChange}
                  disabled={setPriority.isPending}
                  title="确认"
                >
                  ✓
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => {
                    setEditingPriority(false);
                    setPriorityValue(String(credential.priority));
                  }}
                  title="取消"
                >
                  ✕
                </Button>
                </div>
                {/* 改这个数字会发生什么，当场说清楚 */}
                <div className="mt-1 whitespace-nowrap px-1 text-center">
                  <PriorityPreview
                    credentialId={credential.id}
                    draft={priorityValue}
                    disabled={credential.disabled}
                  />
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm font-medium tabular-nums transition-colors hover:bg-accent hover:text-primary"
                onClick={() => setEditingPriority(true)}
                title="点击编辑 · 数字越小越先被使用"
              >
                {credential.priority}
                <Pencil className="h-3 w-3 opacity-70" />
              </button>
            )}
          </div>
        </div>

        <div className="w-20 text-center">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            失败
          </div>
          <button
            type="button"
            onClick={() => setShowFailuresDialog(true)}
            className="mt-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm font-medium tabular-nums transition-colors hover:bg-accent"
            title="鉴权失败 / 账号风控 / 其他（额度·瞬态·网络等）。点击查看失败日志详情"
          >
            {failureStats ? (
              <span className="tabular-nums">
                <span className="text-destructive">{failureStats.auth}</span>
                <span className="text-muted-foreground/50">/</span>
                <span className="text-amber-600 dark:text-amber-400">
                  {failureStats.throttle}
                </span>
                <span className="text-muted-foreground/50">/</span>
                <span className="text-muted-foreground">
                  {failureStats.other}
                </span>
              </span>
            ) : (
              <span
                className={
                  credential.totalFailureCount > 0
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {credential.totalFailureCount}
              </span>
            )}
            <ScrollText className="h-3.5 w-3.5 opacity-70" />
          </button>
        </div>

        <div className="w-16 text-center">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            成功
          </div>
          <button
            type="button"
            onClick={handleResetSuccess}
            className="mt-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm font-medium tabular-nums transition-colors hover:bg-accent hover:text-primary"
            title="点击重置成功次数"
          >
            {credential.successCount}
            <RotateCcw className="h-3 w-3 opacity-70" />
          </button>
        </div>
      </div>

      {/* 余额（大屏） */}
      <div className="hidden w-44 shrink-0 xl:block">
        {loadingBalance ? (
          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            查询中…
          </div>
        ) : balance ? (
          <div>
            <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
              <span
                className={`font-semibold ${
                  balance.remaining < 0
                    ? "text-red-600 dark:text-red-400"
                    : balance.remaining === 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-emerald-600 dark:text-emerald-400"
                }`}
              >
                {balance.remaining < 0
                  ? `-$${formatNumber(Math.abs(balance.remaining))}`
                  : `$${formatNumber(balance.remaining)}`}
              </span>
              <span className="text-muted-foreground">
                {balance.usagePercentage.toFixed(0)}%
              </span>
            </div>
            <Progress value={balance.usagePercentage} className="mt-1 h-1.5" />
          </div>
        ) : (
          <div className="text-center text-[11px] text-muted-foreground">
            余额未查询
          </div>
        )}
      </div>

      {/* 最后调用 + 添加时间（中大屏） */}
      <div className="hidden w-24 shrink-0 truncate text-right text-xs md:block">
        <div className="truncate text-muted-foreground">
          {formatLastUsed(credential.lastUsedAt)}
        </div>
        <div
          className="truncate text-[11px] tabular-nums text-muted-foreground/60"
          title={formatCreatedAtFull(credential.createdAt)}
        >
          添加 {formatCreatedAt(credential.createdAt)}
        </div>
      </div>

      {/*
        操作区：处置意图按钮在最前 —— 这一行现在唯一该做的事。
        禁用态下会多出一个「启用」按钮，加上右侧几个固定宽度的指标列，总宽会超出
        行容器把「更多操作」顶出右边界。所以有处置按钮时就收掉那两个图标按钮
        （刷新 Token / 刷新余额）—— 它们在「更多操作」里本来就有一份，而处置按钮
        才是这一行真正该点的东西。
      */}
      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        {dispositionButton}
        <Button
          size="icon"
          variant="ghost"
          className={`h-9 w-9 ${dispositionButton ? "hidden" : "hidden sm:inline-flex"}`}
          onClick={handleForceRefresh}
          disabled={
            forceRefresh.isPending ||
            credential.disabled ||
            credential.authMethod === "api_key"
          }
          title={
            credential.authMethod === "api_key"
              ? "API Key 无需刷新"
              : credential.disabled
                ? "已禁用"
                : "强制刷新 Token"
          }
        >
          <RefreshCw
            className={`h-4 w-4 ${forceRefresh.isPending ? "animate-spin" : ""}`}
          />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={`h-9 w-9 ${dispositionButton ? "hidden" : "hidden sm:inline-flex"}`}
          onClick={onRefreshBalance}
          disabled={loadingBalance || credential.disabled}
          title={credential.disabled ? "已禁用" : "刷新余额"}
        >
          {loadingBalance ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Wallet className="h-4 w-4" />
          )}
        </Button>
        <Switch
          checked={!credential.disabled}
          onCheckedChange={handleToggleDisabled}
          disabled={setDisabled.isPending}
          title={credential.disabled ? "启用" : "禁用"}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9"
          onClick={() => setShowEditDialog(true)}
          title="编辑"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        {moreMenu}
      </div>
    </div>
  );

  return (
    <>
      {view === "list" ? (
        listView
      ) : (
      <Card
        ref={setNodeRef}
        style={dragStyle}
        data-credential-id={credential.id}
        className={`group flex h-full min-w-0 flex-col overflow-hidden ${
          isDragging
            ? "shadow-apple-lg opacity-80"
            : "hover:-translate-y-0.5 hover:shadow-apple-lg"
        } ${stateClasses}`}
      >
        <CardHeader className="p-4 pb-3 sm:p-5 sm:pb-3">
          <div className="flex min-w-0 items-start gap-2.5 sm:gap-3">
            <label
              data-no-rect-select
              className="mt-0.5 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent sm:h-7 sm:w-7"
              onClick={(e) => {
                // label + Checkbox 双击事件去重，避免触发两次 onCheckedChange
                e.stopPropagation();
              }}
            >
              <Checkbox
                className="h-5 w-5 [&_svg]:h-4 [&_svg]:w-4"
                checked={selected}
                onCheckedChange={onToggleSelect}
              />
            </label>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-[15px] leading-5">
                <CredentialLabel id={credential.id} email={credential.email} />
              </CardTitle>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">
                {badges}
              </div>
            </div>
            <Switch
              className="mt-0.5"
              checked={!credential.disabled}
              onCheckedChange={handleToggleDisabled}
              disabled={setDisabled.isPending}
              title={credential.disabled ? "启用" : "禁用"}
            />
          </div>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col space-y-3 px-4 pb-4 sm:space-y-4 sm:px-5 sm:pb-5">
          {/* 归属：分组 / 来源 —— 独立成块，与状态徽章分开 */}
          {groupingBlock}

          {/* 账号属性：按设置中的 Schema 显示名称和枚举文案，扩展 key 同样可见 */}
          <MetadataSummary credential={credential} schema={metadataSchema} />

          {/* 信息行 */}
          <dl className="grid grid-cols-1 gap-2 text-[13px] min-[420px]:grid-cols-2 min-[420px]:gap-x-4">
            <div className="flex min-w-0 items-center justify-between gap-2">
              {/* 方向写在字段名里：标签本来就该说清这个数字是什么意思 */}
              <dt className="shrink-0 text-muted-foreground">
                优先级
                <span className="ml-1 text-[11px] text-muted-foreground/70">
                  小=先用
                </span>
              </dt>
              <dd className="min-w-0">
                {editingPriority ? (
                  <div className="max-w-full text-right">
                    <div className="inline-flex max-w-full items-center gap-1">
                      <Input
                        type="number"
                        value={priorityValue}
                        onChange={(e) => setPriorityValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handlePriorityChange();
                          if (e.key === "Escape") {
                            setEditingPriority(false);
                            setPriorityValue(String(credential.priority));
                          }
                        }}
                        className="w-16 h-7 rounded-md text-base sm:text-sm"
                        min="0"
                        autoFocus
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={handlePriorityChange}
                        disabled={setPriority.isPending}
                        title="保存"
                      >
                        ✓
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => {
                          setEditingPriority(false);
                          setPriorityValue(String(credential.priority));
                        }}
                        title="取消"
                      >
                        ✕
                      </Button>
                    </div>
                    <div className="mt-0.5">
                      <PriorityPreview
                        credentialId={credential.id}
                        draft={priorityValue}
                        disabled={credential.disabled}
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium tabular-nums transition-colors hover:bg-accent hover:text-primary"
                    onClick={() => setEditingPriority(true)}
                    title="点击编辑优先级"
                  >
                    {credential.priority}
                    <Pencil className="h-3 w-3 opacity-70" />
                  </button>
                )}
              </dd>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <dt className="shrink-0 text-muted-foreground">失败次数</dt>
              <dd className="min-w-0">
                <button
                  type="button"
                  onClick={() => setShowFailuresDialog(true)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium tabular-nums transition-colors hover:bg-accent"
                  title="鉴权失败 / 账号风控 / 其他（额度·瞬态·网络等）。点击查看失败日志详情"
                >
                  {failureStats ? (
                    <span className="tabular-nums">
                      <span className="text-destructive">{failureStats.auth}</span>
                      <span className="text-muted-foreground/50">/</span>
                      <span className="text-amber-600 dark:text-amber-400">
                        {failureStats.throttle}
                      </span>
                      <span className="text-muted-foreground/50">/</span>
                      <span className="text-muted-foreground">{failureStats.other}</span>
                    </span>
                  ) : (
                    <span
                      className={
                        credential.totalFailureCount > 0
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      {credential.totalFailureCount}
                    </span>
                  )}
                  <ScrollText className="h-3.5 w-3.5 opacity-70" />
                </button>
              </dd>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <dt className="shrink-0 text-muted-foreground">刷新失败</dt>
              <dd
                className={`tabular-nums font-medium ${credential.refreshFailureCount > 0 ? "text-destructive" : ""}`}
              >
                {credential.refreshFailureCount}
              </dd>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <dt className="shrink-0 text-muted-foreground">成功次数</dt>
              <dd className="min-w-0">
                <button
                  type="button"
                  onClick={handleResetSuccess}
                  className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium tabular-nums transition-colors hover:bg-accent hover:text-primary"
                  title="点击重置成功次数"
                >
                  {credential.successCount}
                  <RotateCcw className="h-3 w-3 opacity-70" />
                </button>
              </dd>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 border-t border-border/50 pt-2 min-[420px]:col-span-2">
              <dt className="shrink-0 text-muted-foreground">最后调用</dt>
              <dd className="min-w-0 truncate text-right font-medium">
                {formatLastUsed(credential.lastUsedAt)}
              </dd>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 min-[420px]:col-span-2">
              <dt className="shrink-0 text-muted-foreground">添加时间</dt>
              <dd
                className="min-w-0 truncate text-right font-medium tabular-nums"
                title={formatCreatedAtFull(credential.createdAt)}
              >
                {formatCreatedAt(credential.createdAt)}
              </dd>
            </div>
            {credential.maskedApiKey && (
              <div className="flex min-w-0 items-center justify-between gap-2 min-[420px]:col-span-2">
                <dt className="shrink-0 text-muted-foreground">API Key</dt>
                <dd className="min-w-0 truncate text-right font-mono text-xs">
                  {credential.maskedApiKey}
                </dd>
              </div>
            )}
            {credential.hasProxy && (
              <div className="flex min-w-0 items-center justify-between gap-2 min-[420px]:col-span-2">
                <dt className="shrink-0 text-muted-foreground">代理</dt>
                <dd className="min-w-0 truncate text-right font-mono text-xs">
                  {maskProxyUrl(credential.proxyUrl ?? "")}
                </dd>
              </div>
            )}
          </dl>

          {/* 余额面板 */}
          <div
            className={`flex min-h-[138px] flex-col rounded-xl border p-3 transition-colors sm:min-h-[150px] sm:p-4 ${
              isQuotaExceeded || disabledByQuota
                ? "border-amber-500/40 bg-amber-50/60 dark:bg-amber-500/[0.06]"
                : "border-border/60 bg-secondary/40"
            }`}
          >
            {loadingBalance ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在查询余额…
              </div>
            ) : balance ? (
              <div className="space-y-3">
                <div className="flex min-w-0 items-end justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {balance.remaining < 0 ? "超额" : "余额"}
                    </div>
                    <div
                      className={`mt-0.5 text-xl font-semibold tabular-nums ${
                        balance.remaining < 0
                          ? "text-red-600 dark:text-red-400"
                          : balance.remaining === 0
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {balance.remaining < 0
                        ? `-$${formatNumber(Math.abs(balance.remaining))}`
                        : `$${formatNumber(balance.remaining)}`}
                    </div>
                  </div>
                  <div className="min-w-0 shrink-0 text-right">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      超额
                    </div>
                    <div className="mt-1 flex items-center justify-end">
                      <OverageStatusPill balance={balance} />
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Progress value={balance.usagePercentage} />
                  <div className="grid grid-cols-3 gap-1 text-[11px] tabular-nums text-muted-foreground">
                    <span className="min-w-0 truncate">
                      已用 ${formatNumber(balance.currentUsage)}
                    </span>
                    <span className="text-center">
                      {balance.usagePercentage.toFixed(1)}%
                    </span>
                    <span className="min-w-0 truncate text-right">
                      额度 ${formatNumber(balance.usageLimit)}
                    </span>
                  </div>
                </div>
                <div className="break-words border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                  下次重置：
                  <span className="font-medium text-foreground">
                    {formatResetDate(balance.nextResetAt)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-center text-[13px] text-muted-foreground">
                余额未查询，点击顶部"刷新当前页余额"即可加载。
              </div>
            )}
          </div>

          {/* 操作区 */}
          {/* min-w-0 + flex-wrap：两组按钮宽度不够时折行，不把内容顶出卡片 */}
          <div className="mt-auto flex flex-col gap-2 border-t border-border/50 pt-3 min-[420px]:flex-row min-[420px]:flex-wrap min-[420px]:items-center min-[420px]:justify-between">
            <div className="grid min-w-0 grid-cols-3 gap-1 min-[420px]:flex min-[420px]:items-center">
              {!dragDisabled && (
                <>
                  <Button
                    ref={setActivatorNodeRef}
                    size="icon"
                    variant="ghost"
                    data-no-rect-select
                    className="w-full cursor-grab touch-none active:cursor-grabbing min-[420px]:w-9"
                    title="拖拽排序 · 越靠上越先被使用"
                    {...attributes}
                    {...listeners}
                  >
                    <GripVertical className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <span className="mx-1 hidden h-5 w-px bg-border/70 min-[420px]:inline-block" />
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="w-full px-2 min-[420px]:w-auto min-[420px]:px-3"
                onClick={handleForceRefresh}
                disabled={
                  forceRefresh.isPending ||
                  credential.disabled ||
                  credential.authMethod === "api_key"
                }
                title={
                  credential.authMethod === "api_key"
                    ? "API Key 无需刷新"
                    : credential.disabled
                      ? "已禁用"
                      : "强制刷新 Token"
                }
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${forceRefresh.isPending ? "animate-spin" : ""}`}
                />
                <span className="hidden sm:inline">刷新 Token</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="w-full px-2 min-[420px]:w-auto min-[420px]:px-3"
                onClick={onRefreshBalance}
                disabled={loadingBalance || credential.disabled}
                title={credential.disabled ? "已禁用" : "刷新余额"}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loadingBalance ? "animate-spin" : ""}`}
                />
                <span className="hidden sm:inline">刷新余额</span>
              </Button>
            </div>

            {/*
              原先是 grid-cols-[1fr_auto]（两列）。禁用态会多出「启用」处置按钮，
              三个孩子塞两列，加上这条链路上没有任何 min-w-0 / flex-wrap 约束、
              Card 也没裁剪，于是「更多操作」被按固有宽度推出卡片右边界。
              改成可换行的 flex：宽度不够就折行，而不是往外顶。
            */}
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
              {dispositionButton}
              <Button
                size="sm"
                variant="outline"
                className="flex-1 min-[420px]:flex-none"
                onClick={() => setShowEditDialog(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                编辑
              </Button>
              {moreMenu}
            </div>
          </div>
        </CardContent>
      </Card>
      )}

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除凭据</DialogTitle>
            <DialogDescription>
              您确定要删除凭据 #{credential.id} 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleteCredential.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteCredential.isPending}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EditCredentialDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        credential={credential}
        metadataSchema={metadataSchema}
      />
      <UpdateTokenDialog
        open={showUpdateTokenDialog}
        onOpenChange={setShowUpdateTokenDialog}
        credential={credential}
      />
      <ReloginDialog
        open={showReloginDialog}
        onOpenChange={setShowReloginDialog}
        credential={credential}
      />
      <CredentialFailuresDialog
        open={showFailuresDialog}
        onOpenChange={setShowFailuresDialog}
        credentialId={credential.id}
        email={credential.email}
      />
      <AvailableModelsDialog
        open={showModelsDialog}
        onOpenChange={setShowModelsDialog}
        credentialId={credential.id}
      />
      {/* 「查看余额」处置动作：拉一次最新余额，看清用量与下次重置时间 */}
      <BalanceDialog
        open={showBalanceDialog}
        onOpenChange={setShowBalanceDialog}
        credentialId={showBalanceDialog ? credential.id : null}
      />
    </>
  );
}
