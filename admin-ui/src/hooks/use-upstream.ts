import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listUpstreams,
  createUpstream,
  updateUpstream,
  deleteUpstream,
  listUpstreamEvents,
  type UpsertUpstreamRequest,
} from '@/api/upstream'

/** 补货上游配置列表 */
export function useUpstreams() {
  return useQuery({
    queryKey: ['upstreams'],
    queryFn: listUpstreams,
    staleTime: 5000,
  })
}

/** 上游事件日志（自动刷新，便于观察自动提号结果） */
export function useUpstreamEvents(enabled = true) {
  return useQuery({
    queryKey: ['upstream-events'],
    queryFn: listUpstreamEvents,
    enabled,
    refetchInterval: 15000,
  })
}

export function useCreateUpstream() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: UpsertUpstreamRequest) => createUpstream(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['upstreams'] }),
  })
}

export function useUpdateUpstream() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: UpsertUpstreamRequest }) =>
      updateUpstream(id, req),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['upstreams'] }),
  })
}

export function useDeleteUpstream() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteUpstream(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['upstreams'] }),
  })
}
