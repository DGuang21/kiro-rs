import type { LoadBalancingMode } from '@/api/credentials'

export const LOAD_BALANCING_LABELS: Record<LoadBalancingMode, string> = {
  priority: '按优先级',
  balanced: '均衡负载',
  'priority-balanced': '优先级均衡',
  'priority-random': '优先级随机',
}

export const LOAD_BALANCING_HINTS: Record<LoadBalancingMode, string> = {
  priority: '优先使用数字最小的可用凭据，同优先级按 ID 顺序选择',
  balanced: '会话粘性未命中时，先避让在途并发，再按负载因子加权轮询',
  'priority-balanced': '会话粘性未命中时，在最高优先级层内先避让并发，再按负载因子均衡，整层不可用后降级',
  'priority-random': '会话粘性未命中时，在最高优先级层内随机分配，整层不可用后降级',
}

const MODES: LoadBalancingMode[] = ['priority', 'balanced', 'priority-balanced', 'priority-random']

export function nextLoadBalancingMode(mode: LoadBalancingMode): LoadBalancingMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]
}
